import { createAgent, tool } from '@databricks/appkit/beta';
import { z } from 'zod';
import { emitAgentStart, emitAgentDone, getActiveRunId } from '../progress-store';

/**
 * Website Validator agent.
 *
 * Backs the `website-validator` markdown agent. The supervisor calls this
 * sub-agent when it needs to validate the `officialWebsite` field on facility
 * records. Produces a page_presence_score (0–20) composed of five sub-scores:
 *
 *   1. website_reachability_score  (0–4)  — HTTP status of officialWebsite
 *   2. recency_score               (0–6)  — recency_of_page_update
 *   3. staff_score                 (0–4)  — affiliated_staff_presence
 *   4. logo_score                  (0–2)  — custom_logo_presence
 *   5. facts_score                 (0–4)  — number_of_facts_about_the_organization
 *
 * Score labels: 17–20 Strong | 12–16 Good | 6–11 Moderate | 2–5 Weak | 0–1 None
 */
export const websiteValidatorAgent = createAgent({
  name: 'website-validator',
  model: 'OpenAI',
  instructions: [
    'You are the Website Validator sub-agent.',
    'When given a facility record, call `check_website` once for the officialWebsite URL,',
    'then call `score_web_presence` with the metadata fields to compute the full page_presence_score (0–20).',
    '',
    'Scoring rubric (from website-validation.md):',
    '  1. website_reachability_score (0–4): NULL/000=0, 4xx/5xx=2, 301/302=4, 200=4',
    '  2. recency_score (0–6): NULL=0, within 6mo=6, 6mo–1yr=4, 1–2yr=2, >2yr=0',
    '  3. staff_score (0–4): NULL/false=0, true=4',
    '  4. logo_score (0–2): NULL/false=0, true=2',
    '  5. facts_score (0–4): NULL/0=0, 1–3=1, 4–7=2, 8–14=3, >=15=4',
    '  Total: page_presence_score = sum of above, capped at 20.',
    '',
    'Apply judgment: a NULL recency_of_page_update that is clearly a scrape gap should not',
    'be penalised as heavily as a genuinely stale profile. Note the distinction in flags.',
    '',
    'Return ONLY a single compact JSON object — no markdown, no tables, no prose:',
    '{"agent":"website-validator","page_presence_score":<0-20>,"score_label":"Strong|Good|Moderate|Weak|None","verdict":"VERIFIED|REDIRECTS|MISCONFIGURED|UNREACHABLE|NO_WEBSITE","http_status":<number>,"url":"<url or null>","website_reachability_score":<0-4>,"recency_score":<0-6>,"staff_score":<0-4>,"logo_score":<0-2>,"facts_score":<0-4>,"domain_mismatch":<bool>,"flags":<array>,"note":"<one sentence or null>"}',
  ].join(' '),
  tools: {
    check_website: tool({
      description:
        'Performs an HTTP HEAD (falling back to GET) request against the given URL with a 5-second timeout. Returns the HTTP status code and a reachability verdict.',
      schema: z.object({
        record_id: z.string().describe('Facility unique_id.'),
        facility_name: z.string().describe('Facility name for domain-mismatch check.'),
        url: z.string().describe('The officialWebsite URL to probe.'),
      }),
      annotations: { effect: 'read' },
      execute: async ({ record_id, facility_name, url }) => {
        const runId = getActiveRunId();
        if (runId) emitAgentStart(runId, 'website-validator');

        if (!url || url.trim() === '' || url === 'null') {
          if (runId) emitAgentDone(runId, 'website-validator');
          return { record_id, facility_name, url: null, normalised_url: null, http_status: 0, verdict: 'NO_WEBSITE', domain_mismatch: false, error: null };
        }

        // Normalise: add https:// if missing
        let normalised = url.trim();
        if (!/^https?:\/\//i.test(normalised)) {
          normalised = `https://${normalised}`;
        }

        let status: number | null = null;
        let error: string | null = null;

        // Try HEAD first, fall back to GET
        for (const method of ['HEAD', 'GET'] as const) {
          try {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), 5000);
            const res = await fetch(normalised, {
              method,
              redirect: 'manual',
              signal: controller.signal,
              headers: { 'User-Agent': 'entity-resolver/1.0 (hackathon; contact: sawyer@enrollhere.com)' },
            });
            clearTimeout(timer);
            status = res.status;
            break;
          } catch (err) {
            error = err instanceof Error ? err.message : String(err);
          }
        }

        // Classify verdict
        let verdict: 'VERIFIED' | 'REDIRECTS' | 'MISCONFIGURED' | 'UNREACHABLE' | 'NO_WEBSITE';
        if (status === null) {
          verdict = 'UNREACHABLE';
        } else if (status === 200) {
          verdict = 'VERIFIED';
        } else if (status === 301 || status === 302) {
          verdict = 'REDIRECTS';
        } else if (status >= 400) {
          verdict = 'MISCONFIGURED';
        } else {
          verdict = 'VERIFIED';
        }

        // Domain-mismatch heuristic
        let domainMismatch = false;
        try {
          const domain = new URL(normalised).hostname.replace(/^www\./, '');
          const nameTokens = facility_name
            .toLowerCase()
            .replace(/[^a-z0-9\s]/g, '')
            .split(/\s+/)
            .filter((t) => t.length > 3);
          domainMismatch = nameTokens.length > 0 && !nameTokens.some((t) => domain.includes(t));
        } catch {
          // URL parse failed — already UNREACHABLE
        }

        if (runId) emitAgentDone(runId, 'website-validator');
        return {
          record_id,
          facility_name,
          url,
          normalised_url: normalised,
          http_status: status ?? 0,
          verdict,
          domain_mismatch: domainMismatch,
          error: error ?? null,
        };
      },
    }),

    score_web_presence: tool({
      description:
        'Computes the page_presence_score (0–20) from website metadata fields. Call after check_website with the reachability result plus the DB metadata fields.',
      schema: z.object({
        record_id: z.string().describe('Facility unique_id.'),
        http_status: z.number().describe('HTTP status from check_website (0 = unreachable/no website).'),
        recency_of_page_update: z.string().nullable().optional().describe('ISO date string of last profile update, or null.'),
        affiliated_staff_presence: z.string().nullable().optional().describe('"true" or "false" string, or null.'),
        custom_logo_presence: z.string().nullable().optional().describe('"true" or "false" string, or null.'),
        number_of_facts_about_the_organization: z.number().nullable().optional().describe('Count of structured facts, or null.'),
      }),
      annotations: { effect: 'read' },
      execute: async ({ record_id, http_status, recency_of_page_update, affiliated_staff_presence, custom_logo_presence, number_of_facts_about_the_organization }) => {
        // Sub-score 1: Website reachability (0–4)
        let reachabilityScore = 0;
        if (http_status === 200 || http_status === 301 || http_status === 302) {
          reachabilityScore = 4;
        } else if (http_status >= 400) {
          reachabilityScore = 2;
        }

        // Sub-score 2: Recency (0–6)
        let recencyScore = 0;
        if (recency_of_page_update && recency_of_page_update !== 'null') {
          try {
            const updated = new Date(recency_of_page_update);
            const now = new Date();
            const monthsAgo = (now.getTime() - updated.getTime()) / (1000 * 60 * 60 * 24 * 30);
            if (monthsAgo <= 6) recencyScore = 6;
            else if (monthsAgo <= 12) recencyScore = 4;
            else if (monthsAgo <= 24) recencyScore = 2;
            else recencyScore = 0;
          } catch {
            recencyScore = 0;
          }
        }

        // Sub-score 3: Staff presence (0–4)
        const staffScore = affiliated_staff_presence === 'true' ? 4 : 0;

        // Sub-score 4: Logo presence (0–2)
        const logoScore = custom_logo_presence === 'true' ? 2 : 0;

        // Sub-score 5: Facts count (0–4)
        let factsScore = 0;
        const facts = number_of_facts_about_the_organization ?? 0;
        if (facts >= 15) factsScore = 4;
        else if (facts >= 8) factsScore = 3;
        else if (facts >= 4) factsScore = 2;
        else if (facts >= 1) factsScore = 1;

        const total = Math.min(20, reachabilityScore + recencyScore + staffScore + logoScore + factsScore);
        const label =
          total >= 17 ? 'Strong' :
          total >= 12 ? 'Good' :
          total >= 6  ? 'Moderate' :
          total >= 2  ? 'Weak' : 'None';

        return {
          record_id,
          page_presence_score: total,
          score_label: label,
          website_reachability_score: reachabilityScore,
          recency_score: recencyScore,
          staff_score: staffScore,
          logo_score: logoScore,
          facts_score: factsScore,
        };
      },
    }),
  },
});
