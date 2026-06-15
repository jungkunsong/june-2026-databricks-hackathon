import { createAgent, tool } from '@databricks/appkit/beta';
import { z } from 'zod';

/**
 * Website Validator agent.
 *
 * Backs the `website-validator` markdown agent. The supervisor calls this
 * sub-agent when it needs to HTTP-check the `websites` field on facility
 * records. Each URL is probed with a HEAD request (falling back to GET) with
 * a 5-second timeout, then classified into one of four verdicts:
 *
 *   VERIFIED      — HTTP 200
 *   REDIRECTS     — HTTP 301 / 302
 *   MISCONFIGURED — HTTP 4xx / 5xx
 *   UNREACHABLE   — connection error, DNS failure, or timeout
 */
export const websiteValidatorAgent = createAgent({
  name: 'website-validator',
  instructions: [
    'You are the Website Validator sub-agent.',
    'When given facility records, call `check_website` for every URL found in the `websites` field.',
    'After all checks complete, return a structured markdown table and a JSON summary',
    'that classifies each URL and flags duplicate domains and domain mismatches.',
  ].join(' '),
  tools: {
    check_website: tool({
      description:
        'Probes a single website URL with an HTTP HEAD request (fallback GET) and returns the HTTP status code and a verdict.',
      schema: z.object({
        url: z.string().describe('The website URL or bare domain to check (e.g. "aravind.org" or "https://aravind.org").'),
        facility_name: z.string().describe('The facility name from the database, used to detect domain mismatches.'),
        record_id: z.string().describe('The unique_id of the facility record being checked.'),
      }),
      annotations: { effect: 'read' },
      execute: async ({ url, facility_name, record_id }) => {
        // Normalise: ensure the URL has a scheme
        const normalised = /^https?:\/\//i.test(url) ? url : `https://${url}`;

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 5_000);

        let status: number | null = null;
        let error: string | null = null;

        try {
          // Try HEAD first — lighter on the server
          const headRes = await fetch(normalised, {
            method: 'HEAD',
            redirect: 'manual',
            signal: controller.signal,
            headers: { 'User-Agent': 'EntityResolver/1.0 (health-check)' },
          });
          status = headRes.status;

          // Some servers reject HEAD with 405; fall back to GET
          if (status === 405) {
            const getRes = await fetch(normalised, {
              method: 'GET',
              redirect: 'manual',
              signal: controller.signal,
              headers: { 'User-Agent': 'EntityResolver/1.0 (health-check)' },
            });
            status = getRes.status;
          }
        } catch (err: unknown) {
          error = err instanceof Error ? err.message : String(err);
        } finally {
          clearTimeout(timeout);
        }

        // Classify
        let verdict: 'VERIFIED' | 'REDIRECTS' | 'MISCONFIGURED' | 'UNREACHABLE';
        if (error || status === null) {
          verdict = 'UNREACHABLE';
        } else if (status === 200) {
          verdict = 'VERIFIED';
        } else if (status === 301 || status === 302) {
          verdict = 'REDIRECTS';
        } else if (status >= 400) {
          verdict = 'MISCONFIGURED';
        } else {
          // 2xx other than 200, 3xx other than 301/302 — treat as verified
          verdict = 'VERIFIED';
        }

        // Simple domain-mismatch heuristic: check if any word from the
        // facility name appears in the domain (case-insensitive)
        let domainMismatch = false;
        try {
          const domain = new URL(normalised).hostname.replace(/^www\./, '');
          const nameTokens = facility_name
            .toLowerCase()
            .replace(/[^a-z0-9\s]/g, '')
            .split(/\s+/)
            .filter((t) => t.length > 3); // skip short words like "the", "and"
          domainMismatch = nameTokens.length > 0 && !nameTokens.some((t) => domain.includes(t));
        } catch {
          // URL parse failed — already UNREACHABLE
        }

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
  },
});
