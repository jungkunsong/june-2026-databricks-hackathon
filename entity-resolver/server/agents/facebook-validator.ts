import { createAgent, tool } from '@databricks/appkit/beta';
import { z } from 'zod';
import { emitAgentStart, emitAgentDone, getActiveRunId } from '../progress-store';

/**
 * Facebook / Social Media Validator agent.
 *
 * Backs the `facebook-validator` markdown agent. Produces a combined
 * social_score (0–20) per social-validation.md:
 *
 *   social_score = social_presence_score (0–16) + fb_validation_score (0–4)
 *
 * Social presence sub-scores (0–16):
 *   1. platform_breadth_score  (0–2)  — distinct_social_media_presence_count
 *   2. recency_score           (0–5)  — post_metrics_most_recent_social_media_post_date
 *   3. post_volume_score       (0–1)  — post_metrics_post_count
 *   4. follower_score          (0–4)  — engagement_metrics_n_followers
 *   5. likes_score             (0–2)  — engagement_metrics_n_likes
 *   6. engagement_score        (0–2)  — engagement_metrics_n_engagements
 *
 * Facebook page validation (0–4):
 *   Uses Playwright (headless Chromium) to extract og:title and fuzzy-match
 *   against the facility name. MATCH=4, PARTIAL=2, INCONCLUSIVE=1, MISMATCH/NOT_FOUND=0.
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
  model: 'OpenAI',
  instructions: [
    'You are the Facebook / Social Media Validator sub-agent.',
    'When given a facility record:',
    '  1. Call `score_social_presence` with the social media metrics fields to compute social_presence_score (0–16).',
    '  2. If a facebookLink is present, call `check_facebook_page` to compute fb_validation_score (0–4).',
    '     If no facebookLink, fb_validation_score = 0.',
    '  3. social_score = social_presence_score + fb_validation_score (capped at 20).',
    '',
    'Social presence scoring (from social-validation.md):',
    '  platform_breadth (0–2): NULL/0=0, 1–2=1, >=3=2',
    '  recency (0–5): NULL=0, relative string=5, <=6mo=5, 6–12mo=3, 1–2yr=1, >2yr=0',
    '  post_volume (0–1): NULL/0=0, >=1=1',
    '  followers (0–4): NULL/0=0, 1–999=2, >=1000=4',
    '  likes (0–2): NULL/0=0, >=1=2',
    '  engagements (0–2): NULL/0=0, >=1=2',
    '',
    'Facebook validation scoring (from social-validation.md):',
    '  MATCH (og:title words overlap facility name) = 4',
    '  PARTIAL (some words overlap, not conclusive) = 2',
    '  INCONCLUSIVE (login wall, og:title = "Facebook") = 1',
    '  WRONG/DEAD (no overlap or page not found) = 0',
    '',
    'Apply judgment: use distribution percentiles as guides, not hard cutoffs.',
    'A single-platform facility is not zero-presence — award base presence points.',
    '',
    'Return ONLY a single compact JSON object — no markdown, no tables, no prose:',
    '{"agent":"facebook-validator","social_score":<0-20>,"score_label":"Strong|Good|Moderate|Weak|None","social_presence_score":<0-16>,"fb_validation_score":<0-4>,"fb_match":"MATCH|PARTIAL|INCONCLUSIVE|MISMATCH|NOT_FOUND|UNREACHABLE|NO_LINK","og_title":"<string or null>","platform_breadth_score":<0-2>,"recency_score":<0-5>,"post_volume_score":<0-1>,"follower_score":<0-4>,"likes_score":<0-2>,"engagement_score":<0-2>,"flags":<array>,"note":"<one sentence or null>"}',
  ].join(' '),
  tools: {
    score_social_presence: tool({
      description:
        'Computes the social_presence_score (0–16) from social media metrics fields stored in the facilities table.',
      schema: z.object({
        record_id: z.string().describe('Facility unique_id.'),
        distinct_social_media_presence_count: z.number().nullable().optional().describe('Number of distinct social platforms the facility appears on.'),
        post_metrics_most_recent_social_media_post_date: z.string().nullable().optional().describe('ISO date or relative string of most recent post.'),
        post_metrics_post_count: z.number().nullable().optional().describe('Total number of posts.'),
        engagement_metrics_n_followers: z.number().nullable().optional().describe('Number of followers.'),
        engagement_metrics_n_likes: z.number().nullable().optional().describe('Number of likes.'),
        engagement_metrics_n_engagements: z.number().nullable().optional().describe('Number of engagements.'),
      }),
      annotations: { effect: 'read' },
      execute: async ({
        record_id,
        distinct_social_media_presence_count,
        post_metrics_most_recent_social_media_post_date,
        post_metrics_post_count,
        engagement_metrics_n_followers,
        engagement_metrics_n_likes,
        engagement_metrics_n_engagements,
      }) => {
        // Sub-score 1: Platform breadth (0–2)
        const breadth = distinct_social_media_presence_count ?? 0;
        const platformBreadthScore = breadth >= 3 ? 2 : breadth >= 1 ? 1 : 0;

        // Sub-score 2: Posting recency (0–5)
        let recencyScore = 0;
        const rawDate = post_metrics_most_recent_social_media_post_date;
        if (rawDate && rawDate !== 'null') {
          // Relative strings (e.g. "2 months ago", "9h") → treat as active
          const parsed = new Date(rawDate);
          if (isNaN(parsed.getTime())) {
            // Not a parseable date — treat as relative string → recent
            recencyScore = 5;
          } else {
            const monthsAgo = (Date.now() - parsed.getTime()) / (1000 * 60 * 60 * 24 * 30);
            if (monthsAgo <= 6) recencyScore = 5;
            else if (monthsAgo <= 12) recencyScore = 3;
            else if (monthsAgo <= 24) recencyScore = 1;
            else recencyScore = 0;
          }
        }

        // Sub-score 3: Post volume (0–1)
        const postVolumeScore = (post_metrics_post_count ?? 0) >= 1 ? 1 : 0;

        // Sub-score 4: Followers (0–4)
        const followers = engagement_metrics_n_followers ?? 0;
        const followerScore = followers >= 1000 ? 4 : followers >= 1 ? 2 : 0;

        // Sub-score 5: Likes (0–2)
        const likesScore = (engagement_metrics_n_likes ?? 0) >= 1 ? 2 : 0;

        // Sub-score 6: Engagements (0–2)
        const engagementScore = (engagement_metrics_n_engagements ?? 0) >= 1 ? 2 : 0;

        const socialPresenceScore = platformBreadthScore + recencyScore + postVolumeScore + followerScore + likesScore + engagementScore;

        return {
          record_id,
          social_presence_score: socialPresenceScore,
          platform_breadth_score: platformBreadthScore,
          recency_score: recencyScore,
          post_volume_score: postVolumeScore,
          follower_score: followerScore,
          likes_score: likesScore,
          engagement_score: engagementScore,
        };
      },
    }),

    check_facebook_page: tool({
      description:
        'Loads a Facebook page URL with a headless Chromium browser, extracts the og:title meta tag, and fuzzy-matches it against the facility name. Returns fb_validation_score (0–4).',
      schema: z.object({
        url: z.string().describe('The Facebook page URL to validate (e.g. "https://www.facebook.com/AravindEyeHospital").'),
        facility_name: z.string().describe('The facility name from the database, used to match against og:title.'),
        record_id: z.string().describe('The unique_id of the facility record being checked.'),
      }),
      annotations: { effect: 'read' },
      execute: async ({ url, facility_name, record_id }) => {
        const runId = getActiveRunId();
        if (runId) emitAgentStart(runId, 'facebook-validator');
        // Lazy-import playwright so the module only loads when the tool is
        // actually invoked (keeps startup time fast for non-FB clusters).
        let chromium: import('playwright').BrowserType;
        try {
          const pw = await import('playwright');
          chromium = pw.chromium;
        } catch {
          if (runId) emitAgentDone(runId, 'facebook-validator');
          return {
            record_id,
            facility_name,
            url,
            og_title: null,
            match: 'UNREACHABLE' as const,
            fb_validation_score: 0,
            notes: 'Playwright is not installed. Run: npx playwright install chromium',
          };
        }

        let browser: import('playwright').Browser | null = null;
        let ogTitle: string | null = null;
        let matchVerdict: 'MATCH' | 'PARTIAL' | 'INCONCLUSIVE' | 'MISMATCH' | 'NOT_FOUND' | 'UNREACHABLE' = 'UNREACHABLE';
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
              // "Facebook" means login wall — inconclusive
              if (ogTitle.trim().toLowerCase() === 'facebook') {
                matchVerdict = 'INCONCLUSIVE';
                notes = 'Login wall served — og:title is "Facebook", cannot verify page identity.';
              } else {
                matchVerdict = classifyMatch(facility_name, ogTitle);
              }
            } else {
              notes = 'Could not extract og:title — page may have loaded behind a login wall.';
              matchVerdict = 'INCONCLUSIVE';
            }
          }
        } catch (err) {
          notes = err instanceof Error ? err.message : String(err);
          matchVerdict = 'UNREACHABLE';
        } finally {
          await browser?.close();
        }

        // fb_validation_score per social-validation.md rubric
        const fbValidationScore =
          matchVerdict === 'MATCH'        ? 4 :
          matchVerdict === 'PARTIAL'      ? 2 :
          matchVerdict === 'INCONCLUSIVE' ? 1 : 0;

        if (runId) emitAgentDone(runId, 'facebook-validator');
        return {
          record_id,
          facility_name,
          url,
          og_title: ogTitle,
          match: matchVerdict,
          fb_validation_score: fbValidationScore,
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
