# `"farmacy"` Typo in `facilityTypeId` Column

## Summary

10 rows in the `facilities` table contain `"farmacy"` in the `facilityTypeId` column — a misspelling of `"pharmacy"`. This is an unambiguous typo with a known correction and should be normalized to `"pharmacy"` to be consistent with the 2 rows that already use the correct spelling.

- **Table**: `databricks_virtue_foundation_dataset_dais_2026.virtue_foundation_dataset.facilities`
- **Column**: `facilityTypeId`
- **Affected rows**: 10

## Detection Query

```sql
SELECT facilityTypeId, COUNT(*) AS count
FROM databricks_virtue_foundation_dataset_dais_2026.virtue_foundation_dataset.facilities
WHERE facilityTypeId = 'farmacy'
GROUP BY facilityTypeId;
```

## Root Cause

Data entry error at the source — `"farmacy"` was entered instead of `"pharmacy"`. The correct value `"pharmacy"` exists in the same column (2 rows), confirming the intended value.

## Fix

```sql
CASE WHEN facilityTypeId = 'farmacy' THEN 'pharmacy' ELSE facilityTypeId END AS facilityTypeId
```
