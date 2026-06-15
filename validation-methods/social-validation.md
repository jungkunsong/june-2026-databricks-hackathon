# Social Media Validation

Scores each facility's social media footprint across two components — a **social presence score (0–16)** across six signals and a **Facebook page validation score (0–4)** — producing a combined **social score (0–20)** that reflects how active, credible, and correctly linked the facility's online presence is.

A facility with no social media data at all scores **0**. A facility with a wide multi-platform presence, recent posts, strong engagement, and a verified Facebook link scores up to **20**.

---

## Part 1: Social Presence (0–16)

Six sub-scores are computed independently and then summed. Each sub-score is bounded so that no single signal dominates.

### NULL Handling

Three of the six signals have high NULL rates:

| Signal | NULL % |
|---|---|
| `distinct_social_media_presence_count` | 0.4% |
| `engagement_metrics_n_followers` | 11.2% |
| `engagement_metrics_n_likes` | 22.0% |
| `post_metrics_most_recent_social_media_post_date` | 50.7% |
| `engagement_metrics_n_engagements` | 51.2% |
| `post_metrics_post_count` | 62.2% |

A NULL could mean either "the scraper failed to retrieve this value" or "there is genuinely nothing here (no posts, no account)." These two cases should be treated differently, but cannot always be distinguished. The following rules apply:

| `distinct_social_media_presence_count` | Other signal is NULL | Treatment |
|---|---|---|
| ≥ 1 | NULL | **Scrape gap** — score 0, set `data_gap = TRUE`. The account exists but metrics were not retrieved. |
| 0 | NULL | **True zero** — score 0, `data_gap = FALSE`. No accounts means no metrics is consistent. |
| NULL (0.4% of rows) | NULL | **Unresolvable** — score 0, `data_gap = FALSE`. Presence unknown; no penalty, no reward. |
| NULL (0.4% of rows) | non-NULL | Score normally on available signals, `data_gap = FALSE`. |

`data_gap = TRUE` is surfaced as a separate output column so downstream consumers can distinguish a genuinely weak social presence from one that simply was not scraped.

### Sub-scores

#### 1. Platform Breadth — `distinct_social_media_presence_count` (0–2 pts)

Measures how many distinct social platforms the facility appears on.

| Value | Points |
|---|---|
| NULL or 0 | 0 |
| 1–2 | 1 |
| ≥ 3 | 2 |

#### 2. Posting Recency — `post_metrics_most_recent_social_media_post_date` (0–5 pts)

Measures how recently the facility posted. The column stores ISO dates (`YYYY-MM-DD`) for the majority of records; 18 rows contain relative strings (e.g. `"2 months ago"`, `"9h"`) which are treated as **recent** (5 pts) since they were clearly scraped while active.

NULL is scored 0. Whether that represents a scrape gap or true inactivity is determined by `distinct_social_media_presence_count` per the rules above.

| Most recent post | Points |
|---|---|
| NULL | 0 |
| Relative string (contains letters, not a full date) | 5 — treat as active |
| Within last 6 months | 5 |
| 6 months – 1 year ago | 3 |
| 1 – 2 years ago | 1 |
| Older than 2 years | 0 |

> **Note on relative date strings:** 18 rows carry relative strings scraped at crawl time (e.g. `"2 months ago"`, `"9h"`, `"April 9 at 5:54 AM"`). These are treated as recent because they indicate the page was actively posting at the time of scraping. Any value that `TRY_CAST(... AS DATE)` cannot parse and that contains at least one letter is classified as a relative string.

#### 3. Post Volume — `post_metrics_post_count` (0–1 pt)

| Value | Points |
|---|---|
| NULL or 0 | 0 |
| ≥ 1 | 1 |

Post count has a very skewed distribution (p50 = 0, p75 = 1, p90 = 2), so a binary signal is most appropriate.

#### 4. Follower Count — `engagement_metrics_n_followers` (0–4 pts)

Thresholds are derived from the actual distribution in `workspace.default.facilities` (p50 = 245, p75 = 1,000, p99 ≈ 35,500).

| Followers | Points |
|---|---|
| NULL or 0 | 0 |
| 1 – 999 | 2 |
| ≥ 1,000 | 4 |

#### 5. Likes — `engagement_metrics_n_likes` (0–2 pts)

| Value | Points |
|---|---|
| NULL or 0 | 0 |
| ≥ 1 | 2 |

#### 6. Engagements — `engagement_metrics_n_engagements` (0–2 pts)

Engagements are sparse (p75 = 13), so a binary signal is used.

| Value | Points |
|---|---|
| NULL or 0 | 0 |
| ≥ 1 | 2 |

---

### Scoring Formula

```
social_presence_score =
    platform_breadth_score   (0–2)
  + recency_score            (0–5)
  + post_volume_score        (0–1)
  + follower_score           (0–4)
  + likes_score              (0–2)
  + engagement_score         (0–2)
```

**Total range: 0–16**

| Score | Label | Meaning |
|---|---|---|
| 14–16 | Strong | Wide multi-platform presence, recent activity, large audience |
| 10–13 | Good | Active on multiple platforms with meaningful engagement |
| 5–9 | Moderate | Some social presence but limited activity or reach |
| 1–4 | Weak | Minimal presence — few platforms, old or no posts, tiny audience |
| 0 | None | No social media signals at all |

---

### SQL Implementation

```sql
WITH scored AS (
  SELECT
    unique_id,
    name,
    distinct_social_media_presence_count,
    post_metrics_most_recent_social_media_post_date,
    post_metrics_post_count,
    engagement_metrics_n_followers,
    engagement_metrics_n_likes,
    engagement_metrics_n_engagements,

    -- data_gap: TRUE when a social account is known to exist but one or more metric fields are NULL
    -- (scrape gap, not a true zero — score is a lower bound for these facilities)
    CASE
      WHEN CAST(distinct_social_media_presence_count AS INT) >= 1
        AND (
          post_metrics_most_recent_social_media_post_date IS NULL
          OR post_metrics_post_count IS NULL
          OR engagement_metrics_n_followers IS NULL
          OR engagement_metrics_n_likes IS NULL
          OR engagement_metrics_n_engagements IS NULL
        )
      THEN TRUE
      ELSE FALSE
    END AS data_gap,

    -- Sub-score 1: Platform breadth (0–2)
    CASE
      WHEN distinct_social_media_presence_count IS NULL
        OR CAST(distinct_social_media_presence_count AS INT) = 0 THEN 0
      WHEN CAST(distinct_social_media_presence_count AS INT) <= 2 THEN 1
      ELSE 2
    END AS platform_breadth_score,

    -- Sub-score 2: Posting recency (0–5)
    -- NULL → 0 (scrape gap vs true zero resolved via data_gap flag, not by inflating the score)
    -- Relative strings (e.g. "2 months ago", "9h") → 5 (active at crawl time)
    CASE
      WHEN post_metrics_most_recent_social_media_post_date IS NULL THEN 0
      WHEN TRY_CAST(post_metrics_most_recent_social_media_post_date AS DATE) IS NULL
        AND post_metrics_most_recent_social_media_post_date RLIKE '[a-zA-Z]' THEN 5
      WHEN TRY_CAST(post_metrics_most_recent_social_media_post_date AS DATE) IS NULL THEN 0
      WHEN TRY_CAST(post_metrics_most_recent_social_media_post_date AS DATE)
             >= DATE_ADD(CURRENT_DATE(), -180) THEN 5
      WHEN TRY_CAST(post_metrics_most_recent_social_media_post_date AS DATE)
             >= DATE_ADD(CURRENT_DATE(), -365) THEN 3
      WHEN TRY_CAST(post_metrics_most_recent_social_media_post_date AS DATE)
             >= DATE_ADD(CURRENT_DATE(), -730) THEN 1
      ELSE 0
    END AS recency_score,

    -- Sub-score 3: Post volume (0–1)
    CASE
      WHEN post_metrics_post_count IS NULL
        OR CAST(post_metrics_post_count AS INT) = 0 THEN 0
      ELSE 1
    END AS post_volume_score,

    -- Sub-score 4: Follower count (0–4)
    CASE
      WHEN engagement_metrics_n_followers IS NULL
        OR CAST(engagement_metrics_n_followers AS DOUBLE) = 0 THEN 0
      WHEN CAST(engagement_metrics_n_followers AS DOUBLE) < 1000 THEN 2
      ELSE 4
    END AS follower_score,

    -- Sub-score 5: Likes (0–2)
    CASE
      WHEN engagement_metrics_n_likes IS NULL
        OR CAST(engagement_metrics_n_likes AS DOUBLE) = 0 THEN 0
      ELSE 2
    END AS likes_score,

    -- Sub-score 6: Engagements (0–2)
    CASE
      WHEN engagement_metrics_n_engagements IS NULL
        OR CAST(engagement_metrics_n_engagements AS DOUBLE) = 0 THEN 0
      ELSE 2
    END AS engagement_score

  FROM workspace.default.facilities
),

totals AS (
  SELECT
    *,
    platform_breadth_score
      + recency_score
      + post_volume_score
      + follower_score
      + likes_score
      + engagement_score AS social_presence_score
  FROM scored
)

SELECT
  unique_id,
  name,
  social_presence_score,
  data_gap,
  platform_breadth_score,
  recency_score,
  post_volume_score,
  follower_score,
  likes_score,
  engagement_score,
  distinct_social_media_presence_count,
  post_metrics_most_recent_social_media_post_date,
  post_metrics_post_count,
  engagement_metrics_n_followers,
  engagement_metrics_n_likes,
  engagement_metrics_n_engagements
FROM totals
ORDER BY social_presence_score DESC
```

---

### Score Distribution (9,989 facilities, June 2026)

| Score | Label | Facility count | % |
|---|---|---|---|
| 14–16 | Strong | 44 | 0.4% |
| 10–13 | Good | 1,171 | 11.7% |
| 5–9 | Moderate | 6,392 | 64.0% |
| 1–4 | Weak | 2,125 | 21.3% |
| 0 | None | 257 | 2.6% |

> **Note:** Distribution buckets are carried over from the 0–10 scoring era and will shift once Facebook page validation results are incorporated at scale.

---

### Flags

A facility should be flagged for review if any of the following are true:

- `social_presence_score = 0 AND data_gap = FALSE` — no social media signals and no known accounts; record may be stale or fabricated
- `social_presence_score = 0 AND data_gap = TRUE` — known account exists but all metrics are missing; scrape should be retried before drawing conclusions
- `recency_score = 0 AND follower_score = 4` — large audience but no recent posts; account may be inactive or abandoned
- `platform_breadth_score = 2 AND recency_score = 0` — present on many platforms but no recent activity
- `post_volume_score = 1 AND recency_score = 0` — has posts but the most recent is over 2 years old; content is stale

---

### Limitations

- **NULL ambiguity**: NULLs on metric fields are scored as 0 regardless of cause. The `data_gap` flag surfaces cases where a known account has missing metrics, but it cannot guarantee the missing values are non-zero. Scores for `data_gap = TRUE` facilities are lower bounds.
- **Static date thresholds**: The recency buckets (6 months, 1 year, 2 years) are fixed at query time. Re-run periodically as the dataset ages.
- **Relative date strings**: 18 rows contain relative strings (`"2 months ago"`, `"9h"`, etc.) scraped at crawl time. These are treated as recent but their exact dates are unknown. If the crawl was old, these could be stale.
- **Follower count outliers**: `max_followers = 15,000,000` — likely a large hospital chain or national brand. The p99 is ~35,500, so the 1,000-follower threshold captures the top ~25% of the distribution, which is intentional.
- **Score does not validate account ownership**: A high score confirms social activity was observed, not that the accounts belong to this specific facility. See Part 2 below for Facebook identity verification.

---

## Part 2: Facebook Page Validation (0–4)

Validates whether `facebookLink` entries in the `facilities` table point to live pages that match the facility name. Contributes up to **4 points** to the combined social score.

| Result | Points |
|---|---|
| ✅ Match — og:title words overlap with facility name | 4 |
| ⚠️ Partial match — some words overlap but not conclusive | 2 |
| ⚠️ Inconclusive — login wall served, og:title = "Facebook" | 1 |
| ❌ Wrong / Dead — no overlap or page not found | 0 |
| No `facebookLink` in DB | 0 |

### Approach

Uses **Playwright (headless Chromium)** to load each Facebook URL and extract the `og:title` meta tag, which Facebook populates even for unauthenticated requests. The extracted title is then compared against the facility name in the database.

#### Why Playwright

| Method | Outcome |
|---|---|
| `robots.txt`-respecting fetchers | Blocked by Facebook's `robots.txt` |
| `curl` / raw HTTP requests | HTTP 400 — Facebook requires a session cookie |
| Meta Graph API | Requires app approval + access token; adds maintenance overhead |
| **Playwright (headless browser)** | ✅ Works — renders page, extracts `og:title` before login wall |

### Script

```python
from playwright.sync_api import sync_playwright
import re

facilities = [
    ("Facility DB Name", "https://www.facebook.com/<page_id_or_slug>"),
    # ...
]

def normalize(s):
    return re.sub(r'\s+', ' ', s.lower().strip())

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    context = browser.new_context(
        user_agent="Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        locale="en-US",
    )

    for db_name, url in facilities:
        page = context.new_page()
        try:
            response = page.goto(url, wait_until="domcontentloaded", timeout=15000)
            status = response.status if response else "???"

            # Extract og:title (populated by Facebook before login wall)
            og_title = page.evaluate("""
                () => {
                    const el = document.querySelector('meta[property="og:title"]');
                    return el ? el.getAttribute('content') : null;
                }
            """)

            # Fallback to <title>
            if not og_title:
                og_title = page.title()

            og_title = og_title.strip() if og_title else "(none)"
            og_title_clean = re.sub(r'\s*\|.*$', '', og_title).strip()  # strip " | Facebook" suffix

            # Detect dead pages
            not_found = any(x in og_title.lower() for x in [
                "page not found", "content not found", "this page isn't available"
            ])

            # Detect login wall
            inconclusive = og_title_clean.lower() == "facebook"

            if not_found:
                match = "DEAD"
                score = 0
            elif inconclusive:
                match = "INCONCLUSIVE"
                score = 1
            else:
                db_words = set(w for w in normalize(db_name).split() if len(w) > 3)
                og_words = normalize(og_title_clean)
                matched_words = [w for w in db_words if w in og_words]
                ratio = len(matched_words) / len(db_words) if db_words else 0
                if ratio >= 0.5:
                    match = f"YES ({len(matched_words)}/{len(db_words)} words)"
                    score = 4
                elif matched_words:
                    match = f"PARTIAL ({len(matched_words)}/{len(db_words)} words)"
                    score = 2
                else:
                    match = "NO"
                    score = 0

            print(f"{db_name} | {status} | {og_title_clean} | {match} | fb_score={score}")

        except Exception as e:
            print(f"{db_name} | ERROR | {e}")
        finally:
            page.close()

    browser.close()
```

### Sample Results (10 rows, June 2026)

| DB Name | HTTP | OG Title | Match | FB Score |
|---|---|---|---|---|
| Aravind Eye Hospital | 200 | Facebook (login wall) | ⚠️ Inconclusive | 1 |
| Fortis Hospital, Gurugram | 200 | Fortis Memorial Research Institute | ⚠️ Partial match | 2 |
| Fortis Hospital Anandapur | 200 | Kothari Medical Centre | ❌ Wrong hospital | 0 |
| Wockhardt Hospital Nagpur | 200 | Fortis Hospital, Mulund | ❌ Wrong hospital | 0 |
| RAM HOSPITAL & RESEARCH CENTRE, KANPUR | 200 | Rama Medical College Ghaziabad | ❌ Wrong hospital | 0 |
| HCG Manavata Cancer Centre | 200 | HCG Cancer Centre Nagpur | ⚠️ Partial match | 2 |
| Rajarajeswari Medical College and Hospital | 200 | MVJ Medical College and Research Hospital | ❌ Wrong hospital | 0 |
| Medanta The Medicity, Gurgaon, Haryana | 200 | Medanta, The Medicity | ✅ Match | 4 |
| Sumitra Hospital | 200 | Sumitra Hospital | ✅ Match | 4 |
| Government Medical College, Thiruvananthapuram | 200 | T D Medical College, Alappuzha | ❌ Wrong institution | 0 |

**1 out of 10** links cleanly matched. The data quality issue is significant — Facebook links appear to have been assigned by page ID without verification against the facility name.

### Limitations

- **Login wall**: If Facebook serves only a generic login wall (og:title = "Facebook"), the page cannot be validated — awarded 1 pt rather than 0 to avoid penalising facilities where the link may be correct but unverifiable.
- **Loose name matching**: Word-overlap matching can produce false positives for facilities that share common words (e.g. "Hospital", "Medical", "Centre"). Consider tuning the minimum word length threshold or using fuzzy matching.
- **Page reassignment**: A Facebook page ID may have been reassigned or renamed since the DB record was created — a name mismatch doesn't always mean the link is wrong, but it warrants manual review.
- **Rate limiting**: Running this at scale (full facilities table) may trigger Facebook's bot detection. Add delays between requests and consider rotating user agents.

---

## Combined Score

```
social_score = social_presence_score (0–16) + fb_validation_score (0–4)
```

**Total range: 0–20**

| Score | Label | Meaning |
|---|---|---|
| 17–20 | Strong | Active multi-platform presence, large audience, verified Facebook link |
| 12–16 | Good | Solid social activity with mostly verified identity |
| 6–11 | Moderate | Some presence but limited activity, reach, or identity confidence |
| 2–5 | Weak | Minimal signals and/or unverified links |
| 0–1 | None | No social media signals at all |
