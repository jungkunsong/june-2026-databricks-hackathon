# Website Validation Report

**Table:** `databricks_virtue_foundation_dataset_dais_2026.virtue_foundation_dataset.facilities`  
**Column:** `officialWebsite`  
**Date:** 2026-06-15  
**Method:** HTTP status check via `curl` with 5s timeout and 3s connect timeout

## Results

| # | Facility Name | officialWebsite | HTTP Status | Verdict |
|---|---|---|---|---|
| 1 | Aravind Eye Hospital | aravind.org | 200 | ✅ Verified |
| 2 | Fortis Hospital, Gurugram | fortishealthcare.com | 000 | ❌ Unreachable |
| 3 | Fortis Hospital Anandapur | tmckolkata.com | 302 | ⚠️ Redirects (likely valid) |
| 4 | Wockhardt Hospital Nagpur | fortishealthcare.com | 000 | ❌ Unreachable |
| 5 | RAM HOSPITAL & RESEARCH CENTRE, KANPUR | ramahospital.com | 200 | ✅ Verified |
| 6 | HCG Manavata Cancer Centre | manavatacancercentre.com | 409 | ⚠️ Domain exists, server misconfigured |
| 7 | Rajarajeswari Medical College and Hospital | rrmch.org | 301 | ⚠️ Redirects (likely valid) |
| 8 | Medanta The Medicity, Gurgaon | medanta.org | 301 | ⚠️ Redirects (likely valid) |
| 9 | Sumitra Hospital | sumitrahospital.com | 000 | ❌ Unreachable |
| 10 | Government Medical College, Thiruvananthapuram | jmmcri.org | 200 | ✅ Verified |

## Summary

| Verdict | Count |
|---|---|
| ✅ Verified (200) | 3 |
| ⚠️ Redirecting (301/302) | 3 |
| ⚠️ Conflict/Misconfigured (409) | 1 |
| ❌ Unreachable (000) | 3 |

## Data Quality Issues

- **Duplicate website across different hospital chains:** `fortishealthcare.com` is assigned to both *Fortis Hospital, Gurugram* and *Wockhardt Hospital Nagpur*. Wockhardt and Fortis are distinct hospital chains — this is likely a data entry error.
- **3 unreachable domains:** `fortishealthcare.com` (×2) and `sumitrahospital.com` returned HTTP 000, meaning the connection could not be established. These may be blocked, taken down, or incorrectly recorded.

---

# Website & Page Presence Scoring

Scores each facility's web presence across five signals — website reachability, recency of page update, affiliated staff presence, custom logo presence, and number of facts about the organization — producing a single **page presence score (0–10)** that reflects how credible and well-maintained the facility's online profile is.

A facility with no website and no page metadata scores **0**. A facility with a live website, a recently updated profile, staff listed, a custom logo, and rich factual content scores up to **10**.

---

## Approach

Five sub-scores are computed independently and then summed. Each sub-score is bounded so that no single signal dominates.

### NULL Handling

| Signal | NULL % |
|---|---|
| `officialWebsite` | — (spot-checked, not fully profiled) |
| `recency_of_page_update` | 64.6% |
| `affiliated_staff_presence` | 0.4% |
| `custom_logo_presence` | 3.9% |
| `number_of_facts_about_the_organization` | 72.4% |

NULLs are scored as 0 throughout. A NULL on `recency_of_page_update` or `number_of_facts_about_the_organization` most likely indicates the page was never scraped or the source did not expose this metadata — treated as a true absence of signal rather than a scrape gap, since no corroborating presence indicator exists for these fields.

### Sub-scores

#### 1. Website Reachability — `officialWebsite` (0–2 pts)

Measured via HTTP status check (`curl` with 5s timeout, 3s connect timeout). See spot-check results above.

| HTTP Status | Points |
|---|---|
| NULL / no website | 0 |
| 000 (unreachable) | 0 |
| 4xx / 5xx (server error or client error) | 1 — domain exists but misconfigured |
| 301 / 302 (redirect) | 2 — likely valid |
| 200 (OK) | 2 |

#### 2. Recency of Page Update — `recency_of_page_update` (0–3 pts)

Measures how recently the facility's source profile was last updated. Stored as ISO dates (`YYYY-MM-DD`). Dates range from 2003-09-04 to 2027-07-20 in the dataset.

| Most recent update | Points |
|---|---|
| NULL | 0 |
| Within last 6 months | 3 |
| 6 months – 1 year ago | 2 |
| 1 – 2 years ago | 1 |
| Older than 2 years | 0 |

#### 3. Affiliated Staff Presence — `affiliated_staff_presence` (0–2 pts)

Boolean flag indicating whether any staff members are listed as affiliated with the facility. 92.6% of non-NULL rows are `true`.

| Value | Points |
|---|---|
| NULL or `false` | 0 |
| `true` | 2 |

#### 4. Custom Logo Presence — `custom_logo_presence` (0–1 pt)

Boolean flag indicating whether the facility has uploaded a custom logo. 86.1% of non-NULL rows are `true`.

| Value | Points |
|---|---|
| NULL or `false` | 0 |
| `true` | 1 |

#### 5. Number of Facts About the Organization — `number_of_facts_about_the_organization` (0–3 pts)

Count of structured facts (e.g. bed count, specialties, year established) present on the facility's profile. Distribution across 2,755 non-NULL rows: p25 = 3, p50 = 5, p75 = 7, p90 = 10, p99 ≈ 31. 72.4% of all rows are NULL.

| Facts count | Points |
|---|---|
| NULL or 0 | 0 |
| 1 – 3 | 1 |
| 4 – 7 | 2 |
| ≥ 8 | 3 |

---

### Scoring Formula

```
page_presence_score =
    website_reachability_score   (0–2)
  + recency_score                (0–3)
  + staff_score                  (0–2)
  + logo_score                   (0–1)
  + facts_score                  (0–3)
```

**Total range: 0–10** (capped at 10)

| Score | Label | Meaning |
|---|---|---|
| 9–10 | Strong | Live website, recently updated profile, staff listed, logo present, rich factual content |
| 6–8 | Good | Most signals present; minor gaps in recency or content depth |
| 3–5 | Moderate | Some page metadata present but website unreachable or profile stale |
| 1–2 | Weak | Minimal signals — likely a stub record |
| 0 | None | No website and no page metadata at all |

---

## SQL Implementation

```sql
WITH scored AS (
  SELECT
    unique_id,
    name,
    officialWebsite,
    recency_of_page_update,
    affiliated_staff_presence,
    custom_logo_presence,
    number_of_facts_about_the_organization,

    -- Sub-score 1: Website reachability (0–2)
    -- Requires HTTP check results joined from a staging table (website_http_status).
    -- Uncomment once available.
    -- CASE
    --   WHEN website_http_status IS NULL THEN 0
    --   WHEN website_http_status = 200 THEN 2
    --   WHEN website_http_status IN (301, 302) THEN 2
    --   WHEN website_http_status BETWEEN 400 AND 599 THEN 1
    --   ELSE 0
    -- END AS website_reachability_score,

    -- Sub-score 2: Recency of page update (0–3)
    CASE
      WHEN recency_of_page_update IS NULL THEN 0
      WHEN TRY_CAST(recency_of_page_update AS DATE)
             >= DATE_ADD(CURRENT_DATE(), -180) THEN 3
      WHEN TRY_CAST(recency_of_page_update AS DATE)
             >= DATE_ADD(CURRENT_DATE(), -365) THEN 2
      WHEN TRY_CAST(recency_of_page_update AS DATE)
             >= DATE_ADD(CURRENT_DATE(), -730) THEN 1
      ELSE 0
    END AS recency_score,

    -- Sub-score 3: Affiliated staff presence (0–2)
    CASE
      WHEN affiliated_staff_presence = 'true' THEN 2
      ELSE 0
    END AS staff_score,

    -- Sub-score 4: Custom logo presence (0–1)
    CASE
      WHEN custom_logo_presence = 'true' THEN 1
      ELSE 0
    END AS logo_score,

    -- Sub-score 5: Number of facts (0–3)
    CASE
      WHEN number_of_facts_about_the_organization IS NULL
        OR CAST(number_of_facts_about_the_organization AS INT) = 0 THEN 0
      WHEN CAST(number_of_facts_about_the_organization AS INT) <= 3 THEN 1
      WHEN CAST(number_of_facts_about_the_organization AS INT) <= 7 THEN 2
      ELSE 3
    END AS facts_score

  FROM workspace.default.facilities
),

totals AS (
  SELECT
    *,
    LEAST(
      recency_score + staff_score + logo_score + facts_score,
      10
    ) AS page_presence_score
  FROM scored
)

SELECT
  unique_id,
  name,
  page_presence_score,
  recency_score,
  staff_score,
  logo_score,
  facts_score,
  officialWebsite,
  recency_of_page_update,
  affiliated_staff_presence,
  custom_logo_presence,
  number_of_facts_about_the_organization
FROM totals
ORDER BY page_presence_score DESC
```

> **Note on website reachability:** The `website_reachability_score` sub-score requires an HTTP check run outside SQL. The query above omits it and scores out of 8 until HTTP results are joined back in.

---

## Flags

A facility should be flagged for review if any of the following are true:

- `page_presence_score = 0` — no web presence signals at all; record may be a stub or fabricated
- `recency_score = 0 AND staff_score = 2` — staff are listed but the profile has never been updated or is very stale; staff list may be outdated
- `facts_score = 0 AND staff_score = 2` — staff present but no structured facts; profile is incomplete
- `logo_score = 0 AND recency_score = 3` — recently updated but no logo; may indicate an auto-populated record rather than a self-managed profile
- HTTP status 000 on `officialWebsite` — domain unreachable; website link should be re-verified

---

## Limitations

- **Website reachability requires an external HTTP check:** The SQL score excludes `website_reachability_score` until HTTP results are joined in. Scores without it are out of 8, not 10.
- **NULL ambiguity on `recency_of_page_update` and `number_of_facts_about_the_organization`:** 64.6% and 72.4% of rows are NULL respectively. These are treated as true absences, but some NULLs may reflect scrape failures rather than genuinely missing data.
- **Boolean fields are stored as strings:** `affiliated_staff_presence` and `custom_logo_presence` are `STRING` columns containing `'true'`/`'false'`. Any other value (e.g. `'null'` as a string) is scored 0.
- **Static date thresholds:** Recency buckets are fixed at query time. Re-run periodically as the dataset ages.
- **Facts count is a raw count, not a quality score:** A facility with 8 trivial facts scores the same as one with 8 substantive facts. Consider weighting specific fact types in a future iteration.
