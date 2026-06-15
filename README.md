# june-2026-databricks-hackathon

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