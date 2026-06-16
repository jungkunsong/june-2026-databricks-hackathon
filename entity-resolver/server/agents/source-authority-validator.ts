import { createAgent, tool } from '@databricks/appkit/beta';
import { z } from 'zod';
import { emitAgentStart, emitAgentDone, getActiveRunId } from '../progress-store';

/**
 * Source Authority Validator agent.
 *
 * Scores each facility's source_urls array by the authority of the domains it
 * references. The per-facility score is the highest tier anchor score across all
 * URLs — the best source wins. A single Wikipedia link outweighs ten JustDial
 * entries.
 *
 * Tier classification (source-authority-validation.md, June 2026):
 *
 *   Tier 1 — Authoritative (anchor 20): Government (.gov/.gov.in), WHO, Wikipedia, PubMed
 *   Tier 2 — Professional / Official (anchor 16): LinkedIn (in.linkedin.com), facility's own officialWebsite
 *   Tier 3 — Healthcare directories (anchor 12): Practo, Lybrate, MedIndia, etc.
 *   Tier 4 — General directories / aggregators (anchor 8): JustDial, IndiaMart, Sulekha, etc.
 *   Tier 5 — Social media (anchor 4): Facebook, Twitter/X, Instagram, YouTube
 *   Tier 6 — Irrelevant / noise (anchor 0): real-estate portals, unrelated e-commerce
 *
 * The listed domains are examples, not an exhaustive allowlist. The agent must
 * classify unlisted domains by reasoning about their nature. Scores are continuous
 * 0–20; the tier anchors are calibrated starting points, not hard locks.
 *
 * Data quality flags:
 *   - domain_authority_score = 0  → no credible source URLs
 *   - url_count ≥ 5 AND score ≤ 4 → many URLs but none from a credible source (possible link spam)
 *   - www.proptiger.com present   → systematic pipeline issue; flagged separately
 */
export const sourceAuthorityValidatorAgent = createAgent({
  name: 'source-authority-validator',
  model: 'OpenAI',
  instructions: [
    'You are the Source Authority Validator sub-agent.',
    'When given a facility record, call `score_source_authority` to classify its source_urls.',
    'The tool returns a tier breakdown for known domains. For any domain marked tier 6 (unknown),',
    'apply judgment: check TLD (.gov/.ac.in → tier 1), check if it matches officialWebsite (tier 2),',
    'assess whether it is a healthcare directory (tier 3), general business directory (tier 4),',
    'social platform (tier 5), or genuinely irrelevant (tier 6). Tier 6 is reserved for actively',
    'irrelevant domains — an unfamiliar domain that plausibly references the facility is at minimum tier 4.',
    'Scores are continuous 0–20; tier anchors (20,16,12,8,4,0) are starting points, not hard locks.',
    'Return ONLY a compact JSON object:',
    '{"agent":"source-authority-validator","domain_authority_score":<0-20>,"score_label":"<label>","url_count":<n>,"best_domain":"<domain>","best_tier":<1-6>,"flags":<array or null>,"unlisted_domains":<array of {domain,assigned_score,rationale} or null>}',
  ].join(' '),
  tools: {
    score_source_authority: tool({
      description:
        'Scores a facility record by the authority of its source_urls domains. Returns the highest tier weight found across all URLs (best-source-wins), the tier breakdown, and any data quality flags.',
      schema: z.object({
        record_id: z.string().describe('The unique_id of the facility record.'),
        facility_name: z.string().describe('The facility name from the database.'),
        official_website: z
          .string()
          .nullable()
          .describe('The officialWebsite value, used to detect Tier 2 own-domain matches.'),
        source_urls: z
          .array(z.string())
          .describe('The source_urls array for this facility record.'),
      }),
      annotations: { effect: 'read' },
      execute: ({ record_id, facility_name, official_website, source_urls }) => {
        // ── Domain tier map ─────────────────────────────────────────────────
        const TIER3_HEALTHCARE = new Set([
          'www.practo.com',
          'www.lybrate.com',
          'www.medindia.net',
          'www.hexahealth.com',
          'www.myupchar.com',
          'www.docindia.org',
          'www.medicineindia.org',
          'www.clinicspots.com',
          'www.bajajfinservhealth.in',
          'www.healthfrog.in',
          'www.drlogy.com',
          'www.sehat.com',
          'www.skedoc.com',
          'www.eka.care',
          'www.whatclinic.com',
        ]);

        const TIER4_GENERAL = new Set([
          'www.justdial.com',
          'www.indiamart.com',
          'dir.indiamart.com',
          'www.sulekha.com',
          'www.grotal.com',
          'www.mappls.com',
          'mapcarta.com',
          'www.latlong.net',
          'www.zoominfo.com',
          'www.zaubacorp.com',
          'www.joonsquare.com',
          'bdir.in',
          'www.diagnosticcentres.in',
          'www.cardiologistindia.com',
          'www.healthinsuranceindia.org',
          'www.policybazaar.com',
          'www.policyx.com',
          'www.insurancedekho.com',
          'www.iffcotokio.co.in',
          'www.newindia.co.in',
          'www.cashlesshospitalindia.com',
          'chotu.com',
          'watchdoq.com',
          'kivihealth.com',
          'www.scribd.com',
          'www.proptiger.com', // systematic pipeline issue — also flagged separately
        ]);

        const TIER5_SOCIAL = new Set([
          'www.facebook.com',
          'facebook.com',
          'm.facebook.com',
          'twitter.com',
          'x.com',
          'www.instagram.com',
          'instagram.com',
          'www.youtube.com',
          'youtube.com',
        ]);

        // Normalise the official website domain for Tier 2 matching
        let officialDomain: string | null = null;
        if (official_website) {
          try {
            const withScheme = /^https?:\/\//i.test(official_website)
              ? official_website
              : `https://${official_website}`;
            officialDomain = new URL(withScheme).hostname.replace(/^www\./, '');
          } catch {
            // bare domain or unparseable — keep null
          }
        }

        // ── Score each URL ──────────────────────────────────────────────────
        const urlDetails: Array<{
          url: string;
          domain: string;
          tier: number;
          weight: number;
          tier_label: string;
        }> = [];

        let proptigerFlag = false;

        for (const url of source_urls) {
          if (!url || url.trim() === '') continue;

          let domain = '';
          try {
            const withScheme = /^https?:\/\//i.test(url) ? url : `https://${url}`;
            domain = new URL(withScheme).hostname.toLowerCase();
          } catch {
            domain = url.toLowerCase().split('/')[0];
          }

          if (domain === 'www.proptiger.com' || domain === 'proptiger.com') {
            proptigerFlag = true;
          }

          let tier: number;
          let weight: number;
          let tierLabel: string;

          // Tier 1 — Authoritative
          if (
            /\.(gov|gov\.in)$/.test(domain) ||
            ['who.int', 'en.wikipedia.org', 'pmc.ncbi.nlm.nih.gov', 'pubmed.ncbi.nlm.nih.gov'].includes(domain)
          ) {
            tier = 1;
            weight = 20;
            tierLabel = 'Authoritative (gov/WHO/Wikipedia/PubMed)';
          }
          // Tier 2 — Professional / Official
          else if (
            domain === 'in.linkedin.com' ||
            domain === 'www.linkedin.com' ||
            domain === 'linkedin.com' ||
            (officialDomain && domain.endsWith(officialDomain))
          ) {
            tier = 2;
            weight = 16;
            tierLabel = 'Professional / Official (LinkedIn or own website)';
          }
          // Tier 3 — Healthcare directories
          else if (TIER3_HEALTHCARE.has(domain)) {
            tier = 3;
            weight = 12;
            tierLabel = 'Healthcare directory';
          }
          // Tier 4 — General directories / aggregators
          else if (TIER4_GENERAL.has(domain)) {
            tier = 4;
            weight = 8;
            tierLabel = 'General directory / aggregator';
          }
          // Tier 5 — Social media
          else if (TIER5_SOCIAL.has(domain)) {
            tier = 5;
            weight = 4;
            tierLabel = 'Social media';
          }
          // Tier 6 — Unknown / irrelevant (agent will reclassify unlisted domains)
          else {
            tier = 6;
            weight = 0;
            tierLabel = 'Unknown — agent must classify';
          }

          urlDetails.push({ url, domain, tier, weight, tier_label: tierLabel });
        }

        // ── Best-source-wins score ──────────────────────────────────────────
        const domainAuthorityScore =
          urlDetails.length === 0 ? 0 : Math.max(...urlDetails.map((d) => d.weight));

        const urlCount = urlDetails.length;

        // ── Data quality flags ──────────────────────────────────────────────
        const flags: string[] = [];
        if (domainAuthorityScore === 0 && urlCount > 0) {
          flags.push('No credible source URLs — all domains are unknown or irrelevant.');
        }
        if (urlCount >= 5 && domainAuthorityScore <= 4) {
          flags.push(
            `Link spam suspected: ${urlCount} URLs but highest authority score is only ${domainAuthorityScore}.`,
          );
        }
        if (proptigerFlag) {
          flags.push(
            'proptiger.com present in source_urls — likely a systematic pipeline issue, not a valid source.',
          );
        }

        // ── Score label ─────────────────────────────────────────────────────
        const scoreLabel =
          domainAuthorityScore >= 17
            ? 'Authoritative (gov/WHO/Wikipedia/PubMed)'
            : domainAuthorityScore >= 13
              ? 'Professional / Official (LinkedIn or own website)'
              : domainAuthorityScore >= 9
                ? 'Healthcare directory'
                : domainAuthorityScore >= 5
                  ? 'General directory / aggregator'
                  : domainAuthorityScore >= 1
                    ? 'Social media only'
                    : 'Unknown / no credible source';

        const runId = getActiveRunId();
        if (runId) { emitAgentStart(runId, 'source-authority-validator'); emitAgentDone(runId, 'source-authority-validator'); }
        return {
          record_id,
          facility_name,
          url_count: urlCount,
          domain_authority_score: domainAuthorityScore,
          score_label: scoreLabel,
          url_details: urlDetails,
          flags: flags.length > 0 ? flags : null,
          proptiger_flag: proptigerFlag,
        };
      },
    }),
  },
});
