import { createAgent, tool } from '@databricks/appkit/beta';
import { z } from 'zod';

/**
 * Facebook Page Validator agent.
 *
 * Backs the `facebook-validator` markdown agent. Uses Playwright (headless
 * Chromium) to load each Facebook URL and extract the `og:title` meta tag —
 * the only reliable unauthenticated signal Facebook exposes before the login
 * wall. The extracted title is then fuzzy-matched against the facility name.
 *
 * Why Playwright:
 *   - curl / fetch → HTTP 400 (Facebook requires a session cookie)
 *   - robots.txt-respecting fetchers → blocked
 *   - Meta Graph API → requires app approval
 *   - Playwright headless Chromium → renders the page, og:title is set
 *     before the login wall intercepts the DOM
 */
export const facebookValidatorAgent = createAgent({
  name: 'facebook-validator',
  instructions: [
    'You are the Facebook Page Validator sub-agent.',
    'When given facility records that have a facebookLink field, call `check_facebook_page` for each URL.',
    'After all checks complete, return a structured markdown table and a JSON summary',
    'that classifies each page match and flags shared pages and mismatches.',
  ].join(' '),
  tools: {
    check_facebook_page: tool({
      description:
        'Loads a Facebook page URL with a headless Chromium browser, extracts the og:title meta tag, and fuzzy-matches it against the facility name.',
      schema: z.object({
        url: z.string().describe('The Facebook page URL to validate (e.g. "https://www.facebook.com/AravindEyeHospital").'),
        facility_name: z.string().describe('The facility name from the database, used to match against og:title.'),
        record_id: z.string().describe('The unique_id of the facility record being checked.'),
      }),
      annotations: { effect: 'read' },
      execute: async ({ url, facility_name, record_id }) => {
        // Lazy-import playwright so the module only loads when the tool is
        // actually invoked (keeps startup time fast for non-FB clusters).
        let chromium: import('playwright').BrowserType;
        try {
          const pw = await import('playwright');
          chromium = pw.chromium;
        } catch {
          return {
            record_id,
            facility_name,
            url,
            og_title: null,
            match: 'UNREACHABLE' as const,
            notes: 'Playwright is not installed. Run: npx playwright install chromium',
          };
        }

        let browser: import('playwright').Browser | null = null;
        let ogTitle: string | null = null;
        let matchVerdict: 'MATCH' | 'PARTIAL' | 'MISMATCH' | 'NOT_FOUND' | 'UNREACHABLE' = 'UNREACHABLE';
        let notes = '';

        try {
          browser = await chromium.launch({ headless: true });
          const page = await browser.newPage();

          // Block images/fonts/media to speed up load
          await page.route('**/*', (route) => {
            const type = route.request().resourceType();
            if (['image', 'media', 'font', 'stylesheet'].includes(type)) {
              route.abort();
            } else {
              route.continue();
            }
          });

          const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15_000 });
          const httpStatus = response?.status() ?? 0;

          if (httpStatus === 404) {
            matchVerdict = 'NOT_FOUND';
            notes = 'Facebook returned 404 — page does not exist or has been removed.';
          } else {
            // Extract og:title
            ogTitle = await page
              .$eval('meta[property="og:title"]', (el) => el.getAttribute('content') ?? '')
              .catch(() => null);

            if (!ogTitle) {
              // Fallback: try <title> tag
              ogTitle = await page.title().catch(() => null);
            }

            if (ogTitle) {
              matchVerdict = classifyMatch(facility_name, ogTitle);
            } else {
              notes = 'Could not extract og:title — page may have loaded behind a login wall.';
              matchVerdict = 'UNREACHABLE';
            }
          }
        } catch (err: unknown) {
          notes = err instanceof Error ? err.message : String(err);
          matchVerdict = 'UNREACHABLE';
        } finally {
          await browser?.close();
        }

        return {
          record_id,
          facility_name,
          url,
          og_title: ogTitle,
          match: matchVerdict,
          notes: notes || null,
        };
      },
    }),
  },
});

/**
 * Classify how well the og:title matches the facility name.
 *
 * Strategy:
 *  1. Normalise both strings (lowercase, strip punctuation, collapse whitespace)
 *  2. MATCH   — one string is a substring of the other
 *  3. PARTIAL — Jaccard token similarity ≥ 0.4
 *  4. MISMATCH — otherwise
 */
function normalise(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenSet(s: string): Set<string> {
  return new Set(normalise(s).split(' ').filter((t) => t.length > 2));
}

function classifyMatch(
  facilityName: string,
  ogTitle: string,
): 'MATCH' | 'PARTIAL' | 'MISMATCH' {
  const normName = normalise(facilityName);
  const normTitle = normalise(ogTitle);

  // Substring check
  if (normTitle.includes(normName) || normName.includes(normTitle)) {
    return 'MATCH';
  }

  // Jaccard similarity on token sets
  const setA = tokenSet(facilityName);
  const setB = tokenSet(ogTitle);
  const intersection = [...setA].filter((t) => setB.has(t)).length;
  const union = new Set([...setA, ...setB]).size;
  const jaccard = union === 0 ? 0 : intersection / union;

  if (jaccard >= 0.4) return 'PARTIAL';
  return 'MISMATCH';
}
