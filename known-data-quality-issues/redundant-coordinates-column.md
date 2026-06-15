# Redundant `coordinates` Column in `facilities` Table

## Summary

The `coordinates` column is fully redundant with the `latitude` and `longitude` columns. All three are always populated or null together, and the values are identical across all rows.

- **Table**: `databricks_virtue_foundation_dataset_dais_2026.virtue_foundation_dataset.facilities`
- **Total facilities**: 9,989
- **Rows with coordinates**: 9,959
- **Rows with no coordinates (all three null)**: 30
- **Mismatches between `coordinates` and `latitude`/`longitude`**: 0

## Structure of `coordinates`

The column is a JSON string with exactly two keys:

```json
{"type": "Point", "coordinates": [longitude, latitude]}
```

- `coordinates[0]` = `longitude`
- `coordinates[1]` = `latitude`

No other keys are present.

## Verification Query

```sql
SELECT
  SUM(CASE WHEN coordinates IS NOT NULL THEN 1 ELSE 0 END)                          AS has_coordinates,
  SUM(CASE WHEN latitude IS NOT NULL THEN 1 ELSE 0 END)                             AS has_latitude,
  SUM(CASE WHEN longitude IS NOT NULL THEN 1 ELSE 0 END)                            AS has_longitude,
  SUM(CASE WHEN coordinates IS NOT NULL AND latitude IS NULL THEN 1 ELSE 0 END)     AS coord_present_lat_null,
  SUM(CASE WHEN coordinates IS NULL AND latitude IS NOT NULL THEN 1 ELSE 0 END)     AS coord_null_lat_present,
  SUM(CASE WHEN
    coordinates IS NOT NULL AND latitude IS NOT NULL AND longitude IS NOT NULL
    AND (
      ABS(CAST(get_json_object(coordinates, '$.coordinates[1]') AS DOUBLE) - latitude)  > 0.0001
      OR ABS(CAST(get_json_object(coordinates, '$.coordinates[0]') AS DOUBLE) - longitude) > 0.0001
    )
  THEN 1 ELSE 0 END)                                                                AS coord_vs_latlon_mismatch
FROM workspace.default.facilities;
-- Result: has_coordinates=9959, has_latitude=9959, has_longitude=9959,
--         coord_present_lat_null=0, coord_null_lat_present=0, coord_vs_latlon_mismatch=0
```

## Recommended Fix

Drop `coordinates` from the clean copy and rely solely on `latitude` and `longitude`.
