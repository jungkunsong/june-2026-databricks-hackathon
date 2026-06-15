# Controlled Vocabulary Validation for `facilityTypeId` and `operatorTypeId`

**Table:** `workspace.default.facilities`  
**Columns:** `facilityTypeId`, `operatorTypeId`  
**Date:** 2026-06-15

## Overview

`facilityTypeId` and `operatorTypeId` are controlled-vocabulary columns — they should only contain values from a known canonical set. As new data flows in, unexpected values may appear due to new source systems, inconsistent labeling, or data entry errors. This validation detects any values outside the canonical set and flags them for agent review.

This is intentionally **not** handled in `master.sql` because:
- The correct fix may vary per record and requires human or agent confirmation
- New unexpected values will appear in future data that cannot be anticipated at cleaning time
- Synonym inconsistencies (e.g. `"government"` vs `"public"`) require a policy decision before normalization

## Canonical Value Sets

| Column | Allowed Values |
|---|---|
| `facilityTypeId` | `hospital`, `clinic`, `dentist`, `pharmacy`, `nursing_home` |
| `operatorTypeId` | `private`, `public` |

> **Note on `operatorTypeId`:** `"government"` and `"public"` appear to be synonyms (2 vs 465 rows respectively). Until a canonical value is decided, both are listed as known but `"government"` should be flagged for normalization review.

## Validation Rules

| Rule | Severity | Description |
|---|---|---|
| Value not in canonical set | ❌ Error | Any value outside the allowed list above |
| `"government"` in `operatorTypeId` | ⚠️ Warning | Likely synonym for `"public"` — flag for normalization |
| `"doctor"` in `facilityTypeId` | ⚠️ Warning | Semantically a person, not a facility type — needs review |
| NULL | ⚠️ Warning | Missing value — flag if NULL rate exceeds 1% |

## Results (as of 2026-06-15, `workspace.default.facilities`)

### `facilityTypeId`

| Value | Count | Status |
|---|---|---|
| `hospital` | 5,626 | ✅ Valid |
| `clinic` | 3,782 | ✅ Valid |
| `dentist` | 490 | ✅ Valid |
| `NULL` | 57 | ⚠️ Missing (0.57%) |
| `doctor` | 21 | ⚠️ Needs review |
| `pharmacy` | 2 | ✅ Valid |
| `nursing_home` | 1 | ✅ Valid |

### `operatorTypeId`

| Value | Count | Status |
|---|---|---|
| `private` | 8,835 | ✅ Valid |
| `NULL` | 687 | ⚠️ Missing (6.88%) |
| `public` | 465 | ✅ Valid |
| `government` | 2 | ⚠️ Synonym for `public` — normalize |

## SQL Validation Query

```sql
SELECT
  'facilityTypeId' AS column_name,
  facilityTypeId   AS value,
  COUNT(*)         AS count,
  CASE
    WHEN facilityTypeId IS NULL
      THEN 'Warning: NULL value'
    WHEN facilityTypeId = 'doctor'
      THEN 'Warning: semantically invalid for a facility type'
    WHEN facilityTypeId NOT IN ('hospital', 'clinic', 'dentist', 'pharmacy', 'nursing_home')
      THEN 'Error: value not in canonical set'
    ELSE 'Valid'
  END AS status
FROM workspace.default.facilities
GROUP BY facilityTypeId

UNION ALL

SELECT
  'operatorTypeId' AS column_name,
  operatorTypeId   AS value,
  COUNT(*)         AS count,
  CASE
    WHEN operatorTypeId IS NULL
      THEN 'Warning: NULL value'
    WHEN operatorTypeId = 'government'
      THEN 'Warning: synonym for public — normalize'
    WHEN operatorTypeId NOT IN ('private', 'public')
      THEN 'Error: value not in canonical set'
    ELSE 'Valid'
  END AS status
FROM workspace.default.facilities
GROUP BY operatorTypeId

ORDER BY column_name, count DESC;
```
