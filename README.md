# june-2026-databricks-hackathon

A Databricks-based trust scoring system for healthcare facilities in India. Each facility record is evaluated by five independent validation agents, producing a **trust score (0–100)** that reflects how well-evidenced, reachable, and internally consistent the record is.

---

## Trust Score Architecture

### Score Composition

The trust score is the sum of five category scores, each worth up to **20 points**:

| # | Category | Agent | File | Max Score |
|---|---|---|---|---|
| 1 | Source Authority | `SourceAuthorityAgent` | [source-authority-validation.md](validation-methods/source-authority-validation.md) | 20 |
| 2 | Website Presence | `WebsiteAgent` | [website-validation.md](validation-methods/website-validation.md) | 20 |
| 3 | Contacts Quality | `ContactsAgent` | [contacts-validation.md](validation-methods/contacts-validation.md) | 20 |
| 4 | Contextual Depth | `ContextAgent` | [context-validation.md](validation-methods/context-validation.md) | 20 |
| 5 | Social Media | `SocialAgent` | [social-validation.md](validation-methods/social-validation.md) | 20 |
| | **Total** | | | **100** |

### Score Bands

| Trust Score | Label | Interpretation |
|---|---|---|
| 85–100 | Verified | Strong evidence across all dimensions; suitable for direct use |
| 65–84 | Reliable | Most dimensions validated; minor gaps acceptable |
| 45–64 | Partial | Significant gaps in at least one dimension; use with caution |
| 25–44 | Weak | Multiple dimensions unverified; manual review recommended |
| 0–24 | Unverified | Insufficient evidence; do not use without review |

---

## Agent Architecture

### Supervisory Agent

A **supervisory agent** receives a facility record and spawns five sub-agents in parallel, one per validation category. Each sub-agent:

1. Receives the facility `unique_id` and relevant raw fields
2. Fetches data via the SQL query defined in its validation method document
3. Applies the scoring rubric from that document, using **judgment** rather than rigid SQL logic
4. Returns a sub-score (0–20) and a brief rationale

The supervisory agent collects the five sub-scores, sums them into the final trust score, and writes the result back to the output table.

### Sub-Agent Responsibilities

| Agent | Primary data source | Key judgment calls |
|---|---|---|
| `SourceAuthorityAgent` | `source_urls` array | Classify unlisted domains by reasoning, not default-to-0 |
| `WebsiteAgent` | `officialWebsite`, page metadata | HTTP status interpretation, NULL scrape-gap detection |
| `ContactsAgent` | `telephone`, `email`, coordinates, pincode | Phone regex edge cases, city/district naming gaps |
| `ContextAgent` | `specialties`, `description`, `numberDoctors`, `capacity` | Boilerplate detection, unlisted specialty keywords |
| `SocialAgent` | `social_media_*`, Facebook page link | Partial name matches, engagement outlier handling |

### Key Principle: No Automatic Zeros

Agents must **reason about edge cases** rather than defaulting to 0 for anything not explicitly covered by the rubric. Examples:

- An unlisted domain in `source_urls` → classify by domain type (Tier 4 = 8 pts), not automatic 0
- A NULL `recency_of_page_update` for a well-known hospital → treat as scrape gap, not stale profile
- A phone number that fails regex but is visually valid → score at next tier down, not 0

---

## Setup

```bash
pip install -r requirements.txt
playwright install chromium
```

---

## Data Quality Architecture

This project separates data quality concerns into two distinct layers:

### `known-data-quality-issues/` — Deterministic fixes in `master.sql`

For issues that are **confirmed, unambiguous, and have a known fix**. These are hardcoded transformations applied once to produce `workspace.default.facilities` from the raw source table.

**Criteria for inclusion:**
- The root cause is fully understood
- The fix is deterministic and will never change
- No human review is needed — the transformation is always correct

**Examples:**
- `"null"` string literals → proper SQL `NULL`
- Rows with non-UUID `unique_id` values (field-shifted/misaligned rows) → dropped
- Fully identical duplicate rows → deduplicated
- Duplicate entries within JSON array columns → deduplicated
- `"farmacy"` → `"pharmacy"` (known typo with an unambiguous correction)

---

### `validation-methods/` — Agent-handled checks in the Databricks app

For issues that need to be **detected and flagged as new data flows in**, but cannot be safely auto-corrected. These are generalized validation rules executed by agents at runtime, designed to scale beyond the current sample dataset.

**Criteria for inclusion:**
- The issue pattern is known, but the correct fix may vary per record
- A human or agent needs to review before correcting
- The rule should generalize to unseen future data
- Involves thresholds, enum enforcement, or external verification

**Examples:**
- Unexpected values in controlled-vocabulary columns (e.g. `"doctor"` in `facilityTypeId`) — needs human confirmation
- NULL rates in required columns (e.g. `operatorTypeId`, `facilityTypeId`) — flag if exceeding acceptable threshold
- Inconsistent synonyms (e.g. `"government"` vs `"public"`) — enforce canonical enum at ingestion
- External validations: phone numbers, websites, Facebook pages, location coordinates