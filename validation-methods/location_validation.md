# Facility Location Validation

Cross-validates facility coordinates against the **India Post Pincode Directory** for all records in the `facilities` table that have `address_zipOrPostcode`, `latitude`, and `longitude` populated.

## Approach

1. **Pincode centroid** — the directory contains multiple post offices per pincode. We average their lat/lon to produce a single representative point per pincode.
2. **Postcode normalisation** — non-digit characters are stripped from `address_zipOrPostcode` before joining (e.g. `"201 301"` → `201301`).
3. **Haversine distance** — great-circle distance (km) between the facility's coordinates and the pincode centroid.
4. **Classification** — each facility is assigned one of four labels:

| Result | Threshold | Meaning |
|---|---|---|
| `MATCH` | ≤ 20 km | Coordinates are consistent with the postcode |
| `CLOSE` | 21–50 km | Minor discrepancy — neighbouring area, possible data entry issue |
| `MISMATCH` | > 50 km | Coordinates and postcode point to different locations |
| `PINCODE_NOT_FOUND` | — | Postcode absent from the directory (new code, typo, or non-Indian) |

## Results (9,970 qualifying facilities)

| Result | Count | % | Avg distance |
|---|---|---|---|
| `MATCH` | 7,074 | 71.0% | 3.9 km |
| `MISMATCH` | 1,836 | 18.4% | 255.1 km |
| `CLOSE` | 776 | 7.8% | 30.9 km |
| `PINCODE_NOT_FOUND` | 284 | 2.8% | — |

The **18.4% MISMATCH** facilities are the most actionable — their coordinates and postcode diverge by an average of 255 km, indicating either a wrong coordinate or a wrong postcode in the source data.

## Data Quality Notes

- The pincode directory contains a small number of malformed coordinate values (DMS format, degree symbols, embedded spaces). These are silently dropped via `TRY_CAST` and a bounding-box guard (`lat 6–38°, lon 68–98°` — the geographic extent of India).
- The `PINCODE_NOT_FOUND` group may include recently issued pincodes not yet in the directory.

## SQL

```sql
WITH pincode_centroids AS (
  SELECT
    pincode,
    -- TRY_CAST silently drops malformed rows (DMS format, degree symbols, etc.)
    -- Bounding box guard keeps only plausible India coordinates
    AVG(
      CASE
        WHEN TRY_CAST(latitude  AS DOUBLE) BETWEEN 6  AND 38
         AND TRY_CAST(longitude AS DOUBLE) BETWEEN 68 AND 98
        THEN TRY_CAST(latitude AS DOUBLE)
      END
    ) AS pin_lat,
    AVG(
      CASE
        WHEN TRY_CAST(latitude  AS DOUBLE) BETWEEN 6  AND 38
         AND TRY_CAST(longitude AS DOUBLE) BETWEEN 68 AND 98
        THEN TRY_CAST(longitude AS DOUBLE)
      END
    ) AS pin_lon,
    COUNT(*)        AS post_offices_in_pin,
    MODE(district)  AS pin_district,
    MODE(statename) AS pin_state
  FROM databricks_virtue_foundation_dataset_dais_2026.virtue_foundation_dataset.india_post_pincode_directory
  WHERE latitude  NOT IN ('NA', 'NULL', '') AND latitude  IS NOT NULL
    AND longitude NOT IN ('NA', 'NULL', '') AND longitude IS NOT NULL
  GROUP BY pincode
),

facilities_clean AS (
  SELECT
    unique_id,
    name,
    address_line1,
    address_city,
    address_stateOrRegion,
    -- Strip non-digits (e.g. "201 301" → 201301), then cast
    TRY_CAST(REGEXP_REPLACE(address_zipOrPostcode, '[^0-9]', '') AS BIGINT) AS pincode_num,
    address_zipOrPostcode AS raw_postcode,
    latitude  AS fac_lat,
    longitude AS fac_lon
  FROM databricks_virtue_foundation_dataset_dais_2026.virtue_foundation_dataset.facilities
  WHERE address_zipOrPostcode IS NOT NULL
    AND address_zipOrPostcode != ''
    AND latitude  IS NOT NULL
    AND longitude IS NOT NULL
),

joined AS (
  SELECT
    f.unique_id,
    f.name,
    f.address_line1,
    f.address_city,
    f.address_stateOrRegion,
    f.raw_postcode,
    f.pincode_num,
    ROUND(f.fac_lat, 5)  AS fac_lat,
    ROUND(f.fac_lon, 5)  AS fac_lon,
    p.pin_district,
    p.pin_state,
    ROUND(p.pin_lat, 5)  AS pin_centroid_lat,
    ROUND(p.pin_lon, 5)  AS pin_centroid_lon,
    p.post_offices_in_pin,
    -- Haversine distance in km
    ROUND(
      2 * 6371 * ASIN(SQRT(
        POWER(SIN(RADIANS(f.fac_lat - p.pin_lat) / 2), 2) +
        COS(RADIANS(p.pin_lat)) * COS(RADIANS(f.fac_lat)) *
        POWER(SIN(RADIANS(f.fac_lon - p.pin_lon) / 2), 2)
      )), 2
    ) AS distance_km,
    CASE
      WHEN p.pin_lat IS NULL THEN 'PINCODE_NOT_FOUND'
      WHEN 2 * 6371 * ASIN(SQRT(
             POWER(SIN(RADIANS(f.fac_lat - p.pin_lat) / 2), 2) +
             COS(RADIANS(p.pin_lat)) * COS(RADIANS(f.fac_lat)) *
             POWER(SIN(RADIANS(f.fac_lon - p.pin_lon) / 2), 2)
           )) <= 20 THEN 'MATCH'
      WHEN 2 * 6371 * ASIN(SQRT(
             POWER(SIN(RADIANS(f.fac_lat - p.pin_lat) / 2), 2) +
             COS(RADIANS(p.pin_lat)) * COS(RADIANS(f.fac_lat)) *
             POWER(SIN(RADIANS(f.fac_lon - p.pin_lon) / 2), 2)
           )) <= 50 THEN 'CLOSE'
      ELSE 'MISMATCH'
    END AS validation_result
  FROM facilities_clean f
  LEFT JOIN pincode_centroids p ON f.pincode_num = p.pincode
)

-- Row-level detail (worst mismatches first)
SELECT *
FROM joined
ORDER BY
  CASE validation_result
    WHEN 'MISMATCH'          THEN 1
    WHEN 'PINCODE_NOT_FOUND' THEN 2
    WHEN 'CLOSE'             THEN 3
    ELSE                          4
  END,
  distance_km DESC NULLS LAST;

-- Summary breakdown
-- SELECT
--   validation_result,
--   COUNT(*)                                               AS facility_count,
--   ROUND(COUNT(*) * 100.0 / SUM(COUNT(*)) OVER (), 1)    AS pct,
--   ROUND(AVG(distance_km), 1)                             AS avg_distance_km,
--   ROUND(MIN(distance_km), 1)                             AS min_distance_km,
--   ROUND(MAX(distance_km), 1)                             AS max_distance_km
-- FROM joined
-- GROUP BY validation_result
-- ORDER BY facility_count DESC;
```
