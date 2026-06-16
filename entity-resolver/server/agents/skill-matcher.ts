import { createAgent, tool } from '@databricks/appkit/beta';
import { z } from 'zod';

/**
 * Skill Matcher agent.
 *
 * Verifies that a facility's claimed equipment and capabilities are actually
 * evidenced on the web — not just internally consistent with its specialties.
 *
 * Tools:
 *
 * 1. scrape_website_for_evidence
 *    Fetches the facility's own website (or any URL) and extracts visible
 *    text. The agent then scans the text for mentions of the claimed equipment
 *    and capabilities. Returns matched terms, unmatched terms, and a raw
 *    excerpt for transparency.
 *
 * 2. search_web_for_evidence
 *    Queries DuckDuckGo (no API key required) for the facility name + a
 *    specific equipment/capability term. Returns the top result snippets so
 *    the agent can judge whether external sources corroborate the claim.
 *
 * Recommended call sequence:
 *   1. scrape_website_for_evidence(website_url, equipment_terms, capability_terms)
 *      → check which terms appear on the facility's own site
 *   2. For any terms NOT found on the site, call search_web_for_evidence
 *      → look for external corroboration (news, directories, health registries)
 *   3. Synthesise into a final verdict per field
 */

// ── Text helpers ──────────────────────────────────────────────────────────────

/** Strip HTML tags and collapse whitespace. */
function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/** Parse a comma/semicolon/pipe-separated or JSON-array field into tokens. */
function parseTerms(raw: string | null | undefined): string[] {
  if (!raw) return [];
  // Try JSON array first
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed.map((t: unknown) => String(t).trim().toLowerCase()).filter(Boolean);
    }
  } catch { /* not JSON */ }
  return raw.split(/[,;|]+/).map((t) => t.trim().toLowerCase()).filter(Boolean);
}

/** Find which terms from the list appear in the text (case-insensitive). */
function findMatches(text: string, terms: string[]): { matched: string[]; unmatched: string[] } {
  const lower = text.toLowerCase();
  const matched: string[] = [];
  const unmatched: string[] = [];
  for (const term of terms) {
    // Match whole-word or partial (equipment names are often compound)
    if (lower.includes(term)) {
      matched.push(term);
    } else {
      unmatched.push(term);
    }
  }
  return { matched, unmatched };
}

/** Extract a short excerpt around the first occurrence of a term. */
function excerpt(text: string, term: string, windowChars = 120): string | null {
  const idx = text.toLowerCase().indexOf(term.toLowerCase());
  if (idx === -1) return null;
  const start = Math.max(0, idx - windowChars / 2);
  const end = Math.min(text.length, idx + term.length + windowChars / 2);
  return (start > 0 ? '…' : '') + text.slice(start, end).trim() + (end < text.length ? '…' : '');
}

// ── Agent ─────────────────────────────────────────────────────────────────────

export const skillMatcherAgent = createAgent({
  name: 'skill-matcher',
  model: 'OpenAI',
  instructions: [
    'You are the Skill Matcher sub-agent.',
    'Your job is to verify that a facility\'s claimed equipment and capabilities are actually',
    'evidenced on the web — not just plausible in the abstract.',
    '',
    'RECOMMENDED SEQUENCE:',
    '1. If the facility has a website URL, call scrape_website_for_evidence with the URL and',
    '   the list of equipment/capability terms to look for. This checks the facility\'s own site.',
    '2. For any terms NOT found on the site (or if there is no website), call',
    '   search_web_for_evidence for each unverified term (max 3 searches to stay within rate limits).',
    '   Use query: "<facility name> <term> hospital equipment".',
    '3. Synthesise: a term is VERIFIED if found on the site OR in search results.',
    '   A term is UNVERIFIED if neither source mentions it.',
    '   A term is SUSPICIOUS if search results actively contradict it.',
    '',
    'Return ONLY a single compact JSON object — no markdown, no tables, no prose:',
    '{"agent":"skill-matcher",',
    ' "specialties_status":"verified|suspicious|inconclusive",',
    ' "equipment_status":"verified|suspicious|inconclusive",',
    ' "capability_status":"verified|suspicious|inconclusive",',
    ' "overall_confidence":0.0,',
    ' "verified_terms":["list of terms confirmed by web evidence"],',
    ' "unverified_terms":["list of terms with no web evidence"],',
    ' "flags":["list any issues, or empty array"],',
    ' "evidence_sources":["urls or search snippets used"]}',
  ].join('\n'),
  tools: {

    // ── Tool 1: Scrape facility website for equipment/capability mentions ──

    scrape_website_for_evidence: tool({
      description:
        'Fetches a facility\'s website and scans the visible text for mentions of specific ' +
        'equipment and capability terms. Returns which terms were found, which were not, ' +
        'and short excerpts around each match for transparency. ' +
        'Use this first before falling back to web search.',
      schema: z.object({
        url: z
          .string()
          .describe('The facility website URL to fetch. Must be a full URL including https://.'),
        facility_name: z
          .string()
          .describe('The facility name — used to verify the page is actually about this facility.'),
        equipment_terms: z
          .string()
          .nullable()
          .describe(
            'Comma-separated list of equipment terms to search for on the page. ' +
            'Example: "MRI,CT scanner,X-ray,ultrasound,ventilator"',
          ),
        capability_terms: z
          .string()
          .nullable()
          .describe(
            'Comma-separated list of capability terms to search for on the page. ' +
            'Example: "ICU,emergency care,dialysis,blood bank,NICU"',
          ),
      }),
      annotations: { effect: 'read' },
      execute: async ({ url, facility_name, equipment_terms, capability_terms }) => {
        // Normalise URL
        let normalised = url.trim();
        if (!/^https?:\/\//i.test(normalised)) normalised = `https://${normalised}`;

        const eqTerms = parseTerms(equipment_terms);
        const capTerms = parseTerms(capability_terms);
        const allTerms = [...new Set([...eqTerms, ...capTerms])];

        try {
          const res = await fetch(normalised, {
            headers: {
              'User-Agent':
                'Mozilla/5.0 (compatible; entity-resolver/1.0; +https://github.com/jungkunsong/june-2026-databricks-hackathon)',
              Accept: 'text/html,application/xhtml+xml',
            },
            signal: AbortSignal.timeout(10_000),
            redirect: 'follow',
          });

          if (!res.ok) {
            return {
              status: 'HTTP_ERROR' as const,
              url: normalised,
              http_status: res.status,
              message: `HTTP ${res.status} — could not fetch page.`,
              equipment_matched: [],
              equipment_unmatched: eqTerms,
              capability_matched: [],
              capability_unmatched: capTerms,
              excerpts: {},
              page_text_length: 0,
            };
          }

          const html = await res.text();
          const text = stripHtml(html);

          // Check if the page is plausibly about this facility
          const facilityOnPage = text.toLowerCase().includes(
            facility_name.toLowerCase().split(/\s+/)[0], // first word of name
          );

          const eqResult = findMatches(text, eqTerms);
          const capResult = findMatches(text, capTerms);

          // Build excerpts for matched terms (up to 5)
          const excerpts: Record<string, string> = {};
          for (const term of [...eqResult.matched, ...capResult.matched].slice(0, 5)) {
            const ex = excerpt(text, term);
            if (ex) excerpts[term] = ex;
          }

          return {
            status: 'OK' as const,
            url: normalised,
            http_status: res.status,
            facility_name_on_page: facilityOnPage,
            page_text_length: text.length,
            equipment_matched: eqResult.matched,
            equipment_unmatched: eqResult.unmatched,
            capability_matched: capResult.matched,
            capability_unmatched: capResult.unmatched,
            total_terms_checked: allTerms.length,
            match_rate: allTerms.length > 0
              ? Math.round(((eqResult.matched.length + capResult.matched.length) / allTerms.length) * 100)
              : 0,
            excerpts,
            message: `Checked ${allTerms.length} terms. Found ${eqResult.matched.length + capResult.matched.length} on page.`,
          };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return {
            status: 'UNREACHABLE' as const,
            url: normalised,
            http_status: 0,
            message: `Failed to fetch page: ${msg}`,
            equipment_matched: [],
            equipment_unmatched: eqTerms,
            capability_matched: [],
            capability_unmatched: capTerms,
            excerpts: {},
            page_text_length: 0,
          };
        }
      },
    }),

    // ── Tool 2: DuckDuckGo web search for external evidence ───────────────

    search_web_for_evidence: tool({
      description:
        'Searches the web (via DuckDuckGo) for evidence that a facility has specific equipment ' +
        'or capabilities. Use this for terms not found on the facility\'s own website, or when ' +
        'there is no website. Returns the top result titles and snippets. ' +
        'Limit to 3 calls per agent invocation to avoid rate limiting.',
      schema: z.object({
        query: z
          .string()
          .describe(
            'Search query. Be specific: include the facility name and the term. ' +
            'Example: "Netrajyoti Eye Hospital Guwahati MRI scanner" or ' +
            '"Apollo Hospital Chennai ICU capacity"',
          ),
        expected_term: z
          .string()
          .describe(
            'The specific equipment or capability term you are trying to verify. ' +
            'Used to scan snippets for mentions.',
          ),
      }),
      annotations: { effect: 'read' },
      execute: async ({ query, expected_term }) => {
        try {
          // DuckDuckGo HTML search — no API key, scrape the results page
          const params = new URLSearchParams({ q: query, kl: 'in-en' });
          const res = await fetch(`https://html.duckduckgo.com/html/?${params}`, {
            headers: {
              'User-Agent':
                'Mozilla/5.0 (compatible; entity-resolver/1.0; +https://github.com/jungkunsong/june-2026-databricks-hackathon)',
              Accept: 'text/html',
            },
            signal: AbortSignal.timeout(10_000),
          });

          if (!res.ok) {
            return {
              status: 'API_ERROR' as const,
              query,
              expected_term,
              message: `DuckDuckGo returned HTTP ${res.status}.`,
              results: [],
              term_found_in_snippets: false,
            };
          }

          const html = await res.text();

          // Extract result titles and snippets from DDG HTML
          // DDG HTML format: <a class="result__a">title</a> ... <a class="result__snippet">snippet</a>
          const titleMatches = [...html.matchAll(/<a[^>]+class="result__a"[^>]*>([\s\S]*?)<\/a>/gi)];
          const snippetMatches = [...html.matchAll(/<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi)];

          const results = titleMatches.slice(0, 5).map((m, i) => ({
            title: stripHtml(m[1]).trim(),
            snippet: snippetMatches[i] ? stripHtml(snippetMatches[i][1]).trim() : '',
          })).filter((r) => r.title.length > 0);

          // Check if the expected term appears in any snippet or title
          const termLower = expected_term.toLowerCase();
          const termFoundInSnippets = results.some(
            (r) =>
              r.title.toLowerCase().includes(termLower) ||
              r.snippet.toLowerCase().includes(termLower),
          );

          // Extract relevant excerpts
          const relevantExcerpts = results
            .filter(
              (r) =>
                r.title.toLowerCase().includes(termLower) ||
                r.snippet.toLowerCase().includes(termLower),
            )
            .map((r) => `${r.title}: ${r.snippet}`)
            .slice(0, 3);

          return {
            status: 'OK' as const,
            query,
            expected_term,
            results_count: results.length,
            term_found_in_snippets: termFoundInSnippets,
            relevant_excerpts: relevantExcerpts,
            all_results: results,
            message: termFoundInSnippets
              ? `"${expected_term}" found in ${relevantExcerpts.length} search result(s).`
              : `"${expected_term}" not mentioned in top ${results.length} search results.`,
          };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return {
            status: 'API_ERROR' as const,
            query,
            expected_term,
            message: `Search failed: ${msg}`,
            results: [],
            term_found_in_snippets: false,
          };
        }
      },
    }),
  },
});
