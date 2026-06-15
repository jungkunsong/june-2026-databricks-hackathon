# Facebook Page Validation

Validates whether `facebookLink` entries in the `facilities` table point to live pages that match the facility name.

## Approach

Uses **Playwright (headless Chromium)** to load each Facebook URL and extract the `og:title` meta tag, which Facebook populates even for unauthenticated requests. The extracted title is then compared against the facility name in the database.

### Why Playwright

| Method | Outcome |
|---|---|
| `robots.txt`-respecting fetchers | Blocked by Facebook's `robots.txt` |
| `curl` / raw HTTP requests | HTTP 400 — Facebook requires a session cookie |
| Meta Graph API | Requires app approval + access token; adds maintenance overhead |
| **Playwright (headless browser)** | ✅ Works — renders page, extracts `og:title` before login wall |

## Script

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

            if not_found:
                match = "DEAD"
            else:
                db_words = set(w for w in normalize(db_name).split() if len(w) > 3)
                og_words = normalize(og_title_clean)
                matched_words = [w for w in db_words if w in og_words]
                match = f"YES ({len(matched_words)}/{len(db_words)} words)" if matched_words else "NO"

            print(f"{db_name} | {status} | {og_title_clean} | {match}")

        except Exception as e:
            print(f"{db_name} | ERROR | {e}")
        finally:
            page.close()

    browser.close()
```

## Limitations

- **Login wall**: If Facebook serves only a generic login wall (og:title = "Facebook"), the page cannot be validated — result is inconclusive.
- **Loose name matching**: Word-overlap matching can produce false positives for facilities that share common words (e.g. "Hospital", "Medical", "Centre"). Consider tuning the minimum word length threshold or using fuzzy matching.
- **Page reassignment**: A Facebook page ID may have been reassigned or renamed since the DB record was created — a name mismatch doesn't always mean the link is wrong, but it warrants manual review.
- **Rate limiting**: Running this at scale (full facilities table) may trigger Facebook's bot detection. Add delays between requests and consider rotating user agents.

## Sample Results (10 rows, June 2026)

| DB Name | HTTP | OG Title | Match |
|---|---|---|---|
| Aravind Eye Hospital | 200 | Facebook (login wall) | ⚠️ Inconclusive |
| Fortis Hospital, Gurugram | 200 | Fortis Memorial Research Institute | ⚠️ Wrong branch |
| Fortis Hospital Anandapur | 200 | Kothari Medical Centre | ❌ Wrong hospital |
| Wockhardt Hospital Nagpur | 200 | Fortis Hospital, Mulund | ❌ Wrong hospital |
| RAM HOSPITAL & RESEARCH CENTRE, KANPUR | 200 | Rama Medical College Ghaziabad | ❌ Wrong hospital |
| HCG Manavata Cancer Centre | 200 | HCG Cancer Centre Nagpur | ⚠️ Partial match |
| Rajarajeswari Medical College and Hospital | 200 | MVJ Medical College and Research Hospital | ❌ Wrong hospital |
| Medanta The Medicity, Gurgaon, Haryana | 200 | Medanta, The Medicity | ✅ Match |
| Sumitra Hospital | 200 | Sumitra Hospital | ✅ Match |
| Government Medical College, Thiruvananthapuram | 200 | T D Medical College, Alappuzha | ❌ Wrong institution |

**1 out of 10** links cleanly matched. The data quality issue is significant — Facebook links appear to have been assigned by page ID without verification against the facility name.
