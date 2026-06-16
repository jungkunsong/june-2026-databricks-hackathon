# Contacts Validation

Validates three contact-quality dimensions for every facility record in `workspace.default.facilities`: **location** (coordinates, postcode, city, state), **phone number**, and **email address**. Each dimension contributes up to 20 points, for a maximum score of **20 points per record**.

> **Pre-normalisation assumed**: This query runs against `workspace.default.facilities` (the clean copy produced by `known-data-quality-issues/master.sql`), where colloquial and legacy city/state names have already been standardised to official India Post notation (fixes #7 and #8 in `master.sql`). Running against the raw source table will produce additional false mismatches on the location dimension.

---

## Scoring Model

### Location (max 20 pts)

Points are awarded across three sub-checks. The sub-scores are summed and capped at 20.

| Sub-check | Condition | Points |
|---|---|---|
| **Coordinates** | `coord_result = 'MATCH'` (≤ 20 km from pincode centroid) | +10 |
| | `coord_result = 'CLOSE'` (21–50 km) | +5 |
| | `coord_result = 'MISMATCH'` (> 50 km) or `PINCODE_NOT_FOUND` | +0 |
| **State** | `state_result = 'MATCH'` | +5 |
| | `state_result = 'MISMATCH'` or `PINCODE_NOT_FOUND` | +0 |
| **City** | `city_result = 'MATCH'` | +5 |
| | `city_result = 'MISMATCH'` or `PINCODE_NOT_FOUND` | +0 |

A perfect location record (coordinates within 20 km, correct state, correct city) scores **20/20**.

### Phone Number (max 20 pts)

| Condition | Points |
|---|---|
| Valid mobile with `+91` prefix | 20 |
| Valid mobile with `0` prefix or bare 10-digit mobile | 18 |
| Landline / toll-free (prefix 1–5 after `+91`) — structurally valid but unverified | 10 |
| Too many digits (> 12 total) | 5 |
| Too few digits (< 10 total) | 5 |
| Other invalid format | 2 |
| Null / missing (SQL `NULL`, empty string, or literal `"null"`) | 0 |

### Email Address (max 20 pts)

| Condition | Points |
|---|---|
| Well-formed address with a recognised TLD (e.g. `.org`, `.com`, `.in`, `.net`) | 20 |
| Well-formed address with an unrecognised or uncommon TLD | 15 |
| Syntactically valid but suspicious (role address: `info@`, `admin@`, `noreply@`, etc.) | 10 |
| Syntactically invalid (missing `@`, missing domain, illegal characters) | 2 |
| Null / missing (SQL `NULL`, empty string, or literal `"null"`) | 0 |

---

## Location Validation Detail

### Approach

1. **Pincode centroid** — the India Post Pincode Directory contains multiple post offices per pincode. We average their lat/lon to produce a single representative point per pincode. `MODE(district)` and `MODE(statename)` give the dominant district and state for each pincode.
2. **Postcode normalisation** — non-digit characters are stripped from `address_zipOrPostcode` before joining (e.g. `"201 301"` → `201301`).
3. **Haversine distance** — great-circle distance (km) between the facility's coordinates and the pincode centroid.
4. **Coordinate classification** — each facility is assigned one of four labels:

| Result | Threshold | Meaning |
|---|---|---|
| `MATCH` | ≤ 20 km | Coordinates are consistent with the postcode |
| `CLOSE` | 21–50 km | Minor discrepancy — neighbouring area, possible data entry issue |
| `MISMATCH` | > 50 km | Coordinates and postcode point to different locations |
| `PINCODE_NOT_FOUND` | — | Postcode absent from the directory (new code, typo, or non-Indian) |

5. **State validation** — `address_stateOrRegion` is uppercased and trimmed, then compared against `MODE(statename)` from the pincode directory.
6. **City validation** — `address_city` is uppercased and trimmed, then compared against `MODE(district)` from the pincode directory.

> **Why district, not city?** The India Post directory does not have a dedicated city column. `district` is the closest administrative unit and is used as the city proxy. A city that falls within a district but does not share its name (e.g. Haldwani in Nainital district) will appear as `MISMATCH` even when the address is correct — see Limitations.

### Results (9,970 qualifying facilities)

#### Coordinate Validation

| Result | Count | % | Avg distance |
|---|---|---|---|
| `MATCH` | 7,074 | 71.0% | 3.9 km |
| `MISMATCH` | 1,836 | 18.4% | 255.1 km |
| `CLOSE` | 776 | 7.8% | 30.9 km |
| `PINCODE_NOT_FOUND` | 284 | 2.8% | — |

The **18.4% MISMATCH** facilities are the most actionable — their coordinates and postcode diverge by an average of 255 km, indicating either a wrong coordinate or a wrong postcode in the source data.

#### City & State Validation

| State result | City result | Count | % |
|---|---|---|---|
| `MATCH` | `MATCH` | 5,761 | 57.8% |
| `MATCH` | `MISMATCH` | 3,496 | 35.1% |
| `MISMATCH` | `MISMATCH` | 306 | 3.1% |
| `PINCODE_NOT_FOUND` | `PINCODE_NOT_FOUND` | 283 | 2.8% |
| `MISMATCH` | `MATCH` | 124 | 1.2% |

---

## Phone Number Validation Detail

**Column:** `officialPhone` | **Scope:** Indian facilities (`address_countryCode = 'IN'`)

### Validation Rules

Indian phone numbers are considered valid if they match one of the following formats:

| Format | Pattern | Example |
|---|---|---|
| Mobile with country code | `+91` followed by a digit `6–9`, then 9 more digits | `+919693969347` |
| Mobile with leading zero | `0` followed by a digit `6–9`, then 9 more digits | `09693969347` |
| Mobile without prefix | Digit `6–9` followed by 9 more digits | `9693969347` |

**Total digits after country code:** always 10 for mobile numbers.  
**Valid mobile prefixes:** 6, 7, 8, 9 (TRAI-assigned mobile ranges).  
Landline and toll-free numbers (prefixes 1–5 after `+91`) require a separate validation rule and are flagged as warnings, not hard errors.

### Results Summary

| Category | Count | Severity |
|---|---|---|
| Valid (+91 mobile) | 7,423 | ✅ |
| Landline / Toll-free (prefix 1–5 after +91) | 2,025 | ⚠️ |
| Null / Missing (stored as string `"null"` or empty) | 497 | ❌ |
| Too many digits (> 12 total digits) | 48 | ❌ |
| Other invalid format | 7 | ❌ |

### Invalid Examples

#### Too Many Digits (> 12)
Numbers with 13+ digits — one digit too many after `+91`. Likely a data entry error (e.g. duplicate digit, merged STD code).

| officialPhone | Digit Count | Issue |
|---|---|---|
| `+9118003456264` | 13 | 11 digits after `+91` instead of 10 |

#### Landline / Toll-free (⚠️ Warning)
Numbers starting with `+911x` or `+912x` are landlines or toll-free numbers. These are not inherently invalid but require a separate validation rule accounting for STD codes (2–4 digits) + subscriber number.

| officialPhone | Issue |
|---|---|
| `+914061626364` | Landline prefix (`+9140` = Hyderabad STD) |
| `+911143364336` | Landline prefix (`+9111` = Delhi STD) |
| `+911616617111` | Landline prefix |

#### Null / Missing
497 records store the literal string `"null"` instead of a proper SQL `NULL`, or have an empty string.

---

## Email Address Validation Detail

**Column:** `officialEmail` | **Scope:** All facilities

### Validation Rules

Email addresses are validated in two passes:

1. **Syntax check** — the value must match the pattern `<local>@<domain>.<tld>` with no illegal characters.
2. **Quality classification** — valid addresses are further classified by TLD recognition and role-address detection.

**Recognised TLDs** (non-exhaustive): `.com`, `.org`, `.net`, `.edu`, `.gov`, `.in`, `.co.in`, `.org.in`, `.ngo`, `.ngo.in`.

**Role addresses** flagged as suspicious: `info`, `admin`, `contact`, `support`, `noreply`, `no-reply`, `webmaster`, `postmaster`, `hello`, `enquiry`, `enquiries`.

### Results Summary

| Category | Count | Severity |
|---|---|---|
| Valid — recognised TLD | — | ✅ |
| Valid — unrecognised TLD | — | ⚠️ |
| Valid syntax — role address | — | ⚠️ |
| Invalid syntax | — | ❌ |
| Null / Missing | — | ❌ |

> Results to be populated after the query is run against the facilities table.

---

## SQL

### Location Score

```sql
WITH pincode_centroids AS (
  SELECT
    pincode,
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
    address_city,
    address_stateOrRegion,
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
    f.address_city,
    f.address_stateOrRegion,
    f.raw_postcode,
    ROUND(f.fac_lat, 5)  AS fac_lat,
    ROUND(f.fac_lon, 5)  AS fac_lon,
    p.pin_district,
    p.pin_state,
    ROUND(p.pin_lat, 5)  AS pin_centroid_lat,
    ROUND(p.pin_lon, 5)  AS pin_centroid_lon,
    p.post_offices_in_pin,
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
    END AS coord_result,
    CASE
      WHEN p.pin_state IS NULL                                 THEN 'PINCODE_NOT_FOUND'
      WHEN UPPER(TRIM(f.address_stateOrRegion)) = p.pin_state THEN 'MATCH'
      ELSE 'MISMATCH'
    END AS state_result,
    CASE
      WHEN p.pin_district IS NULL                        THEN 'PINCODE_NOT_FOUND'
      WHEN UPPER(TRIM(f.address_city)) = p.pin_district  THEN 'MATCH'
      ELSE 'MISMATCH'
    END AS city_result
  FROM facilities_clean f
  LEFT JOIN pincode_centroids p ON f.pincode_num = p.pincode
)

SELECT
  *,
  -- Location score (max 20)
  LEAST(20,
    CASE coord_result
      WHEN 'MATCH' THEN 10
      WHEN 'CLOSE' THEN 5
      ELSE 0
    END
    + CASE state_result WHEN 'MATCH' THEN 5 ELSE 0 END
    + CASE city_result  WHEN 'MATCH' THEN 5 ELSE 0 END
  ) AS location_score
FROM joined
ORDER BY location_score ASC, distance_km DESC NULLS LAST;
```

### Phone Score

```sql
SELECT
  unique_id,
  officialPhone,
  CASE
    WHEN officialPhone = 'null' OR officialPhone IS NULL OR TRIM(officialPhone) = ''
      THEN 'Null / Missing'
    WHEN NOT officialPhone RLIKE '^[\\+0-9][\\s\\-0-9().]+$'
      THEN 'Invalid characters'
    WHEN officialPhone RLIKE '^\\+91[\\s\\-]?[6-9][0-9]{9}$'
      THEN 'Valid (+91 mobile)'
    WHEN officialPhone RLIKE '^0[6-9][0-9]{9}$'
      THEN 'Valid (0 + 10 digit mobile)'
    WHEN officialPhone RLIKE '^[6-9][0-9]{9}$'
      THEN 'Valid (10 digit mobile)'
    WHEN LENGTH(REGEXP_REPLACE(officialPhone, '[^0-9]', '')) > 12
      THEN 'Too many digits (>12)'
    WHEN LENGTH(REGEXP_REPLACE(officialPhone, '[^0-9]', '')) < 10
      THEN 'Too few digits (<10)'
    WHEN officialPhone RLIKE '^\\+91[\\s\\-]?[0-5][0-9]{9}$'
      THEN 'Landline / Toll-free'
    ELSE 'Other invalid format'
  END AS phone_category,
  CASE
    WHEN officialPhone RLIKE '^\\+91[\\s\\-]?[6-9][0-9]{9}$'                  THEN 20
    WHEN officialPhone RLIKE '^(0[6-9][0-9]{9}|[6-9][0-9]{9})$'               THEN 18
    WHEN officialPhone RLIKE '^\\+91[\\s\\-]?[0-5][0-9]{9}$'                  THEN 10
    WHEN LENGTH(REGEXP_REPLACE(officialPhone, '[^0-9]', '')) > 12              THEN 5
    WHEN LENGTH(REGEXP_REPLACE(officialPhone, '[^0-9]', '')) < 10              THEN 5
    WHEN NOT officialPhone RLIKE '^[\\+0-9][\\s\\-0-9().]+$'                  THEN 2
    WHEN officialPhone = 'null' OR officialPhone IS NULL OR TRIM(officialPhone) = '' THEN 0
    ELSE 2
  END AS phone_score
FROM workspace.default.facilities
WHERE address_countryCode = 'IN';
```

### Email Score

```sql
SELECT
  unique_id,
  officialEmail,
  CASE
    WHEN officialEmail IS NULL OR TRIM(officialEmail) = '' OR officialEmail = 'null'
      THEN 'Null / Missing'
    WHEN NOT officialEmail RLIKE '^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$'
      THEN 'Invalid syntax'
    WHEN LOWER(REGEXP_EXTRACT(officialEmail, '^([^@]+)@', 1))
           RLIKE '^(info|admin|contact|support|noreply|no-reply|webmaster|postmaster|hello|enquiry|enquiries)$'
      THEN 'Valid syntax — role address'
    WHEN LOWER(officialEmail) RLIKE '\\.(com|org|net|edu|gov|in|ngo)(\\.in)?$'
      THEN 'Valid — recognised TLD'
    ELSE 'Valid — unrecognised TLD'
  END AS email_category,
  CASE
    WHEN officialEmail IS NULL OR TRIM(officialEmail) = '' OR officialEmail = 'null'
      THEN 0
    WHEN NOT officialEmail RLIKE '^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$'
      THEN 2
    WHEN LOWER(REGEXP_EXTRACT(officialEmail, '^([^@]+)@', 1))
           RLIKE '^(info|admin|contact|support|noreply|no-reply|webmaster|postmaster|hello|enquiry|enquiries)$'
      THEN 10
    WHEN LOWER(officialEmail) RLIKE '\\.(com|org|net|edu|gov|in|ngo)(\\.in)?$'
      THEN 20
    ELSE 15
  END AS email_score
FROM workspace.default.facilities;
```

### Combined Score

```sql
WITH pincode_centroids AS (
  SELECT
    pincode,
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
    MODE(district)  AS pin_district,
    MODE(statename) AS pin_state
  FROM databricks_virtue_foundation_dataset_dais_2026.virtue_foundation_dataset.india_post_pincode_directory
  WHERE latitude  NOT IN ('NA', 'NULL', '') AND latitude  IS NOT NULL
    AND longitude NOT IN ('NA', 'NULL', '') AND longitude IS NOT NULL
  GROUP BY pincode
),

base AS (
  SELECT
    unique_id,
    name,
    address_city,
    address_stateOrRegion,
    address_zipOrPostcode,
    latitude,
    longitude,
    officialPhone,
    officialEmail,
    address_countryCode,
    TRY_CAST(REGEXP_REPLACE(address_zipOrPostcode, '[^0-9]', '') AS BIGINT) AS pincode_num
  FROM workspace.default.facilities
),

location_scored AS (
  SELECT
    b.unique_id,
    LEAST(20,
      CASE
        WHEN p.pin_lat IS NULL OR b.latitude IS NULL OR b.longitude IS NULL THEN 0
        WHEN 2 * 6371 * ASIN(SQRT(
               POWER(SIN(RADIANS(b.latitude  - p.pin_lat) / 2), 2) +
               COS(RADIANS(p.pin_lat)) * COS(RADIANS(b.latitude)) *
               POWER(SIN(RADIANS(b.longitude - p.pin_lon) / 2), 2)
             )) <= 20 THEN 10
        WHEN 2 * 6371 * ASIN(SQRT(
               POWER(SIN(RADIANS(b.latitude  - p.pin_lat) / 2), 2) +
               COS(RADIANS(p.pin_lat)) * COS(RADIANS(b.latitude)) *
               POWER(SIN(RADIANS(b.longitude - p.pin_lon) / 2), 2)
             )) <= 50 THEN 5
        ELSE 0
      END
      + CASE WHEN p.pin_state    IS NOT NULL AND UPPER(TRIM(b.address_stateOrRegion)) = p.pin_state    THEN 5 ELSE 0 END
      + CASE WHEN p.pin_district IS NOT NULL AND UPPER(TRIM(b.address_city))          = p.pin_district THEN 5 ELSE 0 END
    ) AS location_score
  FROM base b
  LEFT JOIN pincode_centroids p ON b.pincode_num = p.pincode
),

phone_scored AS (
  SELECT
    unique_id,
    CASE
      WHEN officialPhone RLIKE '^\\+91[\\s\\-]?[6-9][0-9]{9}$'                       THEN 20
      WHEN officialPhone RLIKE '^(0[6-9][0-9]{9}|[6-9][0-9]{9})$'                    THEN 18
      WHEN officialPhone RLIKE '^\\+91[\\s\\-]?[0-5][0-9]{9}$'                       THEN 10
      WHEN LENGTH(REGEXP_REPLACE(officialPhone, '[^0-9]', '')) > 12                   THEN 5
      WHEN LENGTH(REGEXP_REPLACE(officialPhone, '[^0-9]', '')) < 10
           AND officialPhone IS NOT NULL AND TRIM(officialPhone) != ''
           AND officialPhone != 'null'                                                 THEN 5
      WHEN NOT officialPhone RLIKE '^[\\+0-9][\\s\\-0-9().]+$'
           AND officialPhone IS NOT NULL AND TRIM(officialPhone) != ''
           AND officialPhone != 'null'                                                 THEN 2
      ELSE 0  -- Null / Missing / other invalid
    END AS phone_score
  FROM base
),

email_scored AS (
  SELECT
    unique_id,
    CASE
      WHEN officialEmail IS NULL OR TRIM(officialEmail) = '' OR officialEmail = 'null'
        THEN 0
      WHEN NOT officialEmail RLIKE '^[^@\\s]+@[^@\\s]+\\.[^@\\s]+'
        THEN 2
      WHEN LOWER(REGEXP_EXTRACT(officialEmail, '^([^@]+)@', 1))
             RLIKE '^(info|admin|contact|support|noreply|no-reply|webmaster|postmaster|hello|enquiry|enquiries)$'
        THEN 10
      WHEN LOWER(officialEmail) RLIKE '\\.(com|org|net|edu|gov|in|ngo)(\\.in)?$'
        THEN 20
      ELSE 15
    END AS email_score
  FROM base
)

SELECT
  b.unique_id,
  b.name,
  b.address_city,
  b.address_stateOrRegion,
  b.address_zipOrPostcode,
  b.officialPhone,
  b.officialEmail,
  l.location_score,
  p.phone_score,
  e.email_score,
  ROUND((l.location_score + p.phone_score + e.email_score) / 3.0, 1) AS contacts_score_avg,
  l.location_score + p.phone_score + e.email_score                    AS contacts_score_total
FROM base b
JOIN location_scored l USING (unique_id)
JOIN phone_scored     p USING (unique_id)
JOIN email_scored     e USING (unique_id)
ORDER BY contacts_score_total ASC;
```

---

## Data Quality Notes

### Location
- The pincode directory contains a small number of malformed coordinate values (DMS format, degree symbols, embedded spaces). These are silently dropped via `TRY_CAST` and a bounding-box guard (`lat 6–38°, lon 68–98°`).
- The `PINCODE_NOT_FOUND` group may include recently issued pincodes not yet in the directory.
- Some `address_stateOrRegion` values contain city names instead of state names (e.g. `"Thane"`, `"Pune"`, `"Navi Mumbai"`). These will always produce a state `MISMATCH` regardless of coordinate accuracy.
- The Andhra Pradesh / Telangana split (2014) causes systematic state mismatches for facilities in Telangana that still carry `"Andhra Pradesh"` in source data. This is intentionally not auto-corrected in `master.sql` as it requires manual review.

### Phone
- **`"null"` string values:** 497 records store the literal string `"null"` instead of SQL `NULL`. These should be coerced to proper `NULL` during ingestion.
- **Too many digits:** 48 records have 13+ total digits (e.g. `+9118003456264`). Likely caused by a duplicate digit or an STD code being prepended to an already-complete number.
- **Landline numbers lack STD-aware validation:** 2,025 numbers use landline/toll-free prefixes. A proper landline rule must account for variable-length STD codes (2–4 digits) and is not currently implemented.

### Email
- Role addresses (`info@`, `admin@`, etc.) are penalised but not disqualified — they are common for NGOs and may be the only contact on record.
- The TLD recognition list is non-exhaustive; `.ngo.in` and `.org.in` are explicitly included as they are common for Indian non-profits.
- Duplicate-domain detection (e.g. multiple facilities sharing the same email domain) is not performed here; see `context-validation.md`.

---

## Limitations

- **City ≠ district**: The India Post directory has no city column. `address_city` is compared to `district`, which is an administrative unit that may span multiple cities. Sub-city names (Navi Mumbai, Haldwani, Panvel, etc.) will produce a city `MISMATCH` even when the address is geographically correct. Always cross-check `city_result = 'MISMATCH'` against `coord_result` before treating it as a data error.
- **Andhra Pradesh / Telangana bifurcation**: Facilities in Telangana that still carry `"Andhra Pradesh"` are not auto-corrected in `master.sql`. These will produce a state `MISMATCH` and should be reviewed manually.
- **Malformed coordinates in the directory**: Rows with DMS-format or otherwise unparseable lat/lon are silently dropped via `TRY_CAST` and the bounding-box guard. A pincode whose directory entries are all malformed will appear as `PINCODE_NOT_FOUND`.
- **Static distance thresholds**: The MATCH/CLOSE/MISMATCH distance buckets (20 km, 50 km) are fixed. Re-evaluate if the dataset expands to include non-Indian facilities.
- **Phone scope**: Phone validation is scoped to `address_countryCode = 'IN'`. International facilities will score 0 on phone unless the combined query is extended with country-specific rules.
- **Email deliverability**: Syntax and TLD checks do not verify deliverability. MX record lookups or a dedicated email verification service would be required for that.
