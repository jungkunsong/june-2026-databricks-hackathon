# Facility Location Validation

Cross-validates facility coordinates, city, and state against the **India Post Pincode Directory** for all records in the `facilities` table that have `address_zipOrPostcode`, `latitude`, and `longitude` populated.

> **Pre-normalisation assumed**: This query runs against `workspace.default.facilities` (the clean copy produced by `known-data-quality-issues/master.sql`), where colloquial and legacy city/state names have already been standardised to official India Post notation (fixes #7 and #8 in `master.sql`). Running against the raw source table will produce additional false mismatches.

## Approach

1. **Pincode centroid** — the directory contains multiple post offices per pincode. We average their lat/lon to produce a single representative point per pincode. `MODE(district)` and `MODE(statename)` give the dominant district and state for each pincode.
2. **Postcode normalisation** — non-digit characters are stripped from `address_zipOrPostcode` before joining (e.g. `"201 301"` → `201301`).
3. **Haversine distance** — great-circle distance (km) between the facility's coordinates and the pincode centroid.
4. **Coordinate classification** — each facility is assigned one of four labels:

| Result | Threshold | Meaning |
|---|---|---|
| `MATCH` | ≤ 20 km | Coordinates are consistent with the postcode |
| `CLOSE` | 21–50 km | Minor discrepancy — neighbouring area, possible data entry issue |
| `MISMATCH` | > 50 km | Coordinates and postcode point to different locations |
| `PINCODE_NOT_FOUND` | — | Postcode absent from the directory (new code, typo, or non-Indian) |

5. **State validation** — `address_stateOrRegion` is uppercased and trimmed, then compared against `MODE(statename)` from the pincode directory. Result is `MATCH`, `MISMATCH`, or `PINCODE_NOT_FOUND`.
6. **City validation** — `address_city` is uppercased and trimmed, then compared against `MODE(district)` from the pincode directory. Result is `MATCH`, `MISMATCH`, or `PINCODE_NOT_FOUND`.

> **Why district, not city?** The India Post directory does not have a dedicated city column. `district` is the closest administrative unit and is used as the city proxy. A city that falls within a district but does not share its name (e.g. Haldwani in Nainital district) will appear as `MISMATCH` even when the address is correct — see Limitations.

## Results

### Coordinate Validation (9,970 qualifying facilities)

| Result | Count | % | Avg distance |
|---|---|---|---|
| `MATCH` | 7,074 | 71.0% | 3.9 km |
| `MISMATCH` | 1,836 | 18.4% | 255.1 km |
| `CLOSE` | 776 | 7.8% | 30.9 km |
| `PINCODE_NOT_FOUND` | 284 | 2.8% | — |

The **18.4% MISMATCH** facilities are the most actionable — their coordinates and postcode diverge by an average of 255 km, indicating either a wrong coordinate or a wrong postcode in the source data.

### City & State Validation (9,970 qualifying facilities with non-NULL city and state)

| State result | City result | Count | % |
|---|---|---|---|
| `MATCH` | `MATCH` | 5,761 | 57.8% |
| `MATCH` | `MISMATCH` | 3,496 | 35.1% |
| `MISMATCH` | `MISMATCH` | 306 | 3.1% |
| `PINCODE_NOT_FOUND` | `PINCODE_NOT_FOUND` | 283 | 2.8% |
| `MISMATCH` | `MATCH` | 124 | 1.2% |

The **35.1%** with a matching state but mismatching city are the most common city anomaly. Many are legitimate sub-city names (e.g. Navi Mumbai, Panvel, Haldwani) that do not match the parent district name — review against the coordinate result before flagging. The **3.1%** with both state and city mismatching are the highest-priority records.

## Data Quality Notes

- The pincode directory contains a small number of malformed coordinate values (DMS format, degree symbols, embedded spaces). These are silently dropped via `TRY_CAST` and a bounding-box guard (`lat 6–38°, lon 68–98°` — the geographic extent of India).
- The `PINCODE_NOT_FOUND` group may include recently issued pincodes not yet in the directory.
- Some `address_stateOrRegion` values contain city names instead of state names (e.g. `"Thane"`, `"Pune"`, `"Navi Mumbai"`). These will always produce a state `MISMATCH` regardless of coordinate accuracy.
- The Andhra Pradesh / Telangana split (2014) causes systematic state mismatches for facilities in Telangana that still carry `"Andhra Pradesh"` in source data. This is intentionally not auto-corrected in `master.sql` as it requires manual review.

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
  FROM workspace.default.facilities
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
    -- Coordinate validation
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
    END AS coord_result,
    -- State validation (names already normalised by master.sql fix #8)
    CASE
      WHEN p.pin_state IS NULL                                 THEN 'PINCODE_NOT_FOUND'
      WHEN UPPER(TRIM(f.address_stateOrRegion)) = p.pin_state THEN 'MATCH'
      ELSE 'MISMATCH'
    END AS state_result,
    -- City validation (address_city compared to pin_district — closest proxy in the directory)
    -- city_result = 'MISMATCH' may reflect a valid sub-city name; cross-check coord_result
    CASE
      WHEN p.pin_district IS NULL                        THEN 'PINCODE_NOT_FOUND'
      WHEN UPPER(TRIM(f.address_city)) = p.pin_district  THEN 'MATCH'
      ELSE 'MISMATCH'
    END AS city_result
  FROM facilities_clean f
  LEFT JOIN pincode_centroids p ON f.pincode_num = p.pincode
)

-- Row-level detail (worst mismatches first)
SELECT *
FROM joined
ORDER BY
  CASE
    WHEN coord_result = 'MISMATCH' AND state_result = 'MISMATCH' THEN 1  -- all three wrong
    WHEN coord_result = 'MISMATCH' AND city_result  = 'MISMATCH' THEN 2
    WHEN coord_result = 'MISMATCH'                               THEN 3
    WHEN state_result = 'MISMATCH' AND city_result  = 'MISMATCH' THEN 4
    WHEN coord_result = 'PINCODE_NOT_FOUND'                      THEN 5
    WHEN coord_result = 'CLOSE'                                  THEN 6
    ELSE                                                              7
  END,
  distance_km DESC NULLS LAST;

-- Summary breakdown
-- SELECT
--   coord_result,
--   state_result,
--   city_result,
--   COUNT(*)                                               AS facility_count,
--   ROUND(COUNT(*) * 100.0 / SUM(COUNT(*)) OVER (), 1)    AS pct,
--   ROUND(AVG(distance_km), 1)                             AS avg_distance_km
-- FROM joined
-- GROUP BY coord_result, state_result, city_result
-- ORDER BY facility_count DESC;
```

---

## Limitations

- **City ≠ district**: The India Post directory has no city column. `address_city` is compared to `district`, which is an administrative unit that may span multiple cities. Sub-city names (Navi Mumbai, Haldwani, Panvel, etc.) will produce a city `MISMATCH` even when the address is geographically correct. Always cross-check `city_result = 'MISMATCH'` against `coord_result` before treating it as a data error.
- **Andhra Pradesh / Telangana bifurcation**: Facilities in Telangana that still carry `"Andhra Pradesh"` are not auto-corrected in `master.sql`. These will produce a state `MISMATCH` and should be reviewed manually.
- **Malformed coordinates in the directory**: Rows with DMS-format or otherwise unparseable lat/lon are silently dropped via `TRY_CAST` and the bounding-box guard. A pincode whose directory entries are all malformed will appear as `PINCODE_NOT_FOUND`.
- **Static distance thresholds**: The MATCH/CLOSE/MISMATCH distance buckets (20 km, 50 km) are fixed. Re-evaluate if the dataset expands to include non-Indian facilities.
