# Duplicate unique_id Values in `facilities` Table

## Summary

The `facilities` table contains 11 `unique_id` values with exactly 2 identical rows each, resulting in 22 total rows where 11 are pure duplicates. All duplicate pairs are fully identical across all 51 columns — there are no meaningful differences between them.

- **Table**: `databricks_virtue_foundation_dataset_dais_2026.virtue_foundation_dataset.facilities`
- **Affected column**: `unique_id`
- **Duplicate groups**: 11
- **Redundant rows**: 11

## Affected unique_ids

| unique_id | row count |
|-----------|-----------|
| `08344cdb-f455-4c22-8d31-a0a8e849124b` | 2 |
| `1a0f7290-f227-49fe-9b92-a8c698a165d8` | 2 |
| `277e82f0-241a-458a-b9fc-e32d2b3dfcba` | 2 |
| `9264b21d-4aea-460a-9c77-613407df8439` | 2 |
| `b36f3f71-0b8a-4d7f-8b10-12eb7f5bcf60` | 2 |
| `c11d175a-ae2b-4b31-90b5-fe73b3a040cb` | 2 |
| `c8aa3363-35eb-4c70-ae7a-0a86307f49c2` | 2 |
| `c9518151-2032-4f53-823b-d42acd0aad95` | 2 |
| `d643f869-169b-4597-bb15-1335ebaba9d7` | 2 |
| `fced074a-ce12-47a8-b52e-e40d876fc122` | 2 |
| `fe23dd4d-7cca-47b3-aad4-293b62e32cb2` | 2 |

## Detection Query

```sql
SELECT unique_id, COUNT(*) AS cnt
FROM databricks_virtue_foundation_dataset_dais_2026.virtue_foundation_dataset.facilities
GROUP BY unique_id
HAVING COUNT(*) > 1
ORDER BY cnt DESC;
```

## Deduplication Query

Since all duplicate rows are fully identical, a `ROW_NUMBER()` approach safely removes them:

```sql
SELECT * EXCEPT (rn)
FROM (
    SELECT *,
           ROW_NUMBER() OVER (PARTITION BY unique_id ORDER BY unique_id) AS rn
    FROM databricks_virtue_foundation_dataset_dais_2026.virtue_foundation_dataset.facilities
)
WHERE rn = 1;
```

## Root Cause

Likely caused by duplicate ingestion runs — the same source records were loaded more than once without deduplication logic at the pipeline level.

## Recommended Fix

Add a deduplication step in the ingestion pipeline, or apply the query above as a dbt model / view to produce a clean version of the table.
