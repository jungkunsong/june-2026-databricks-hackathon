# Invalid `unique_id` Format

**Table:** `databricks_virtue_foundation_dataset_dais_2026.virtue_foundation_dataset.facilities`  
**Column:** `unique_id`  
**Date:** 2026-06-15  

## Expected Format

`unique_id` should always be a lowercase UUID v4:

```
xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
```

Regex: `^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`

## Results Summary

| Category | Count | Pct | Severity |
|---|---|---|---|
| Valid UUID | 10,000 | 99.13% | ✅ |
| Invalid (all patterns combined) | 88 | 0.87% | ❌ |

## Root Cause

The `unique_id` column has been contaminated with **scraped markdown text from facility descriptions**. All 88 invalid values are fragments of description content — sentences, bullet points, table rows, and headers. This indicates an ETL/parsing bug where a multi-line description field was split by newlines and individual lines were incorrectly written into the `unique_id` column instead of the actual UUID.

## Invalid Pattern Breakdown

| Pattern | Count | Example |
|---|---|---|
| Free text (description bleed) | 56 | `"She has 9+ years of experience in Obstetrics and Gynaecology"` |
| Markdown list items | 21 | `"  *  __Oncology\""`, `"  * **Micro Incision Cataract Surgery(MICS)**"` |
| Markdown table rows / other | 7 | `"\| **Dr. Anvita Verma** \|"` |
| Leading whitespace + text | 1 | `"  Currently"` |
| Markdown table separator | 1 | `"---|---  "` |
| Markdown bold header | 1 | `"**Services:**"` |
| Truncated ellipsis | 1 | `"... More\""` |

## Invalid Examples

```
In order to record the electrical signals in your heart
She has 9+ years of experience in Obstetrics and Gynaecology
Under the ageis of Choithram Group
We treat people of all ages with the same level of care
  *  __Oncology"
  *  __Clinical Pathology
  *  __Microbiology
  * **Micro Incision Cataract Surgery(MICS)**
**Services:**
---|---
... More"
```

## SQL Validation Query

```sql
SELECT
  CASE
    WHEN unique_id IS NULL THEN 'NULL'
    WHEN unique_id = '' THEN 'EMPTY'
    WHEN unique_id RLIKE '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN 'VALID_UUID'
    ELSE 'INVALID'
  END AS format_category,
  COUNT(*) AS row_count,
  ROUND(COUNT(*) * 100.0 / SUM(COUNT(*)) OVER (), 2) AS pct
FROM databricks_virtue_foundation_dataset_dais_2026.virtue_foundation_dataset.facilities
GROUP BY format_category
ORDER BY row_count DESC;
```

To retrieve all invalid rows:

```sql
SELECT unique_id, name, description
FROM databricks_virtue_foundation_dataset_dais_2026.virtue_foundation_dataset.facilities
WHERE NOT (unique_id RLIKE '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
  AND unique_id IS NOT NULL
  AND unique_id != ''
ORDER BY LENGTH(unique_id) DESC;
```

## Recommended Fix

Exclude invalid rows in downstream queries by filtering on the UUID regex:

```sql
WHERE unique_id RLIKE '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
```
