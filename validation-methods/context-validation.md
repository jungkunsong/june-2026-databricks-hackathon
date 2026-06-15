# Context Validation

Scores each facility's contextual richness and internal consistency across seven fields — `specialties`, `procedure`, `equipment`, `capability`, `description`, `numberDoctors`, and `capacity` — producing a **context score (0–20)** that reflects how complete, sensible, and self-consistent the facility's operational profile is.

A facility with all fields populated, internally consistent, and with a meaningful description scores up to **20**. A facility with all fields null or incoherent scores **0**.

---

## Fields Evaluated

| Field | Type | NULL rate | Notes |
|---|---|---|---|
| `specialties` | JSON array of strings | 1.1% | 98.9% populated; duplicates are common (see below) |
| `procedure` | JSON array of strings | 1.1% + 7.2% empty `[]` | 98.9% populated but 724 rows are empty arrays |
| `equipment` | JSON array of strings | 1.1% + 21.6% empty `[]` | 98.9% populated but 2,180 rows are empty arrays |
| `capability` | JSON array of strings | 1.1% | 98.9% populated; 19 rows are empty arrays |
| `description` | String | 0.8% | 99.2% populated; quality varies widely |
| `numberDoctors` | String (numeric) | 62.9% stored as `"null"` | Only ~37% have a real numeric value |
| `capacity` | String (numeric) | 73.9% stored as `"null"` | Only ~26% have a real numeric value |

> **Note on `"null"` strings:** `numberDoctors` and `capacity` frequently store the literal string `"null"` rather than SQL `NULL`. These are treated as missing throughout this validation.

---

## Scoring

Five sub-scores are computed independently and summed. Each is bounded so no single signal dominates.

### Sub-score 1: Array Field Coverage (0–4 pts)

Measures how many of the four JSON array fields (`specialties`, `procedure`, `equipment`, `capability`) are non-null and non-empty. Each populated field contributes 1 point.

| Non-empty array fields | Points |
|---|---|
| 0 | 0 |
| 1 | 1 |
| 2 | 2 |
| 3 | 3 |
| 4 | 4 |

A field counts as populated if it is not NULL, not the string `"null"`, not an empty array `[]`, and parses as a valid JSON array.

---

### Sub-score 2: Specialty Depth & Deduplication (0–4 pts)

Measures how many **distinct** specialties are listed. Duplicate entries within the `specialties` array are extremely common (9,837 of 9,973 populated facilities have at least one duplicate), so raw array size is a poor signal — distinct count is used instead.

| Distinct specialties | Points |
|---|---|
| NULL / empty | 0 |
| 1–2 | 1 |
| 3–5 | 2 |
| 6–10 | 3 |
| ≥ 11 | 4 |

> **Duplicate note:** 9,837 facilities (98.6% of those with specialties) contain duplicate entries in the `specialties` array, totalling 50,681 redundant entries. Deduplication should be applied at ingestion time.

---

### Sub-score 3: Description Quality (0–4 pts)

Measures whether the `description` field contains meaningful, facility-specific content rather than a placeholder or trivially short string.

| Condition | Points |
|---|---|
| NULL, `"null"`, or empty | 0 |
| Present but ≤ 20 characters (e.g. `"Hospital"`, `"General hospital."`) | 1 |
| 21–49 characters — minimal but present | 2 |
| 50–199 characters — adequate summary | 3 |
| ≥ 200 characters — detailed description | 4 |

---

### Sub-score 4: Numeric Field Validity (0–4 pts)

Measures whether `numberDoctors` and `capacity` are present and plausible. Each field contributes up to 2 points.

#### `numberDoctors` (0–2 pts)

| Condition | Points |
|---|---|
| NULL or `"null"` | 0 |
| Non-numeric (wrong-column data, UUID, URL array) | 0 |
| Numeric but = 0 | 0 |
| Numeric and ≥ 1 | 2 |

#### `capacity` (0–2 pts)

| Condition | Points |
|---|---|
| NULL or `"null"` | 0 |
| Non-numeric (wrong-column data) | 0 |
| Numeric but = 0 | 0 |
| Numeric and ≥ 1 | 2 |

> **Wrong-column data:** A small number of records (2–3 per field) store JSON arrays or UUIDs in `numberDoctors` and `capacity` — these are column-assignment errors from the ingestion pipeline and are scored 0.

---

### Sub-score 5: Cross-field Consistency (0–4 pts)

Measures internal coherence across fields. Inconsistencies indicate data quality issues rather than missing data.

#### 5a. Doctor-to-capacity ratio (0–2 pts)

A facility cannot have more doctors than beds in any realistic scenario. When both fields are numeric and positive, the ratio is checked.

| Condition | Points |
|---|---|
| Either field is missing or non-numeric | 0 (not penalised — missing data is handled in sub-score 4) |
| `numberDoctors > capacity` and `capacity > 0` | 0 — impossible ratio; likely a data entry error |
| `numberDoctors ≤ capacity` | 2 |

> **Observed:** 82 facilities have `numberDoctors > capacity` (with `capacity > 0`). Examples include Kokilaben Dhirubhai Ambani Hospital (350 doctors, 150 beds) and Jehangir Hospital (759 doctors, 350 beds). These are likely sourced from different pages — doctor count from a staff directory, bed count from an insurance listing.

#### 5b. Specialties–procedure alignment (0–2 pts)

A facility with a populated `specialties` array should have at least some `procedure` or `equipment` entries — the absence of both when specialties are present suggests incomplete scraping or column misalignment.

| Condition | Points |
|---|---|
| `specialties` is empty/null | 0 (not penalised — already captured in sub-score 1) |
| `specialties` populated AND both `procedure` and `equipment` are empty/null | 0 — inconsistent; specialties without supporting operational data |
| `specialties` populated AND at least one of `procedure` or `equipment` is non-empty | 2 |

> **Observed:** 480 facilities have a non-empty `specialties` array but both `procedure` and `equipment` are empty or null.

---

### Scoring Formula

```
context_score =
    array_coverage_score          (0–4)
  + specialty_depth_score         (0–4)
  + description_quality_score     (0–4)
  + numeric_validity_score        (0–4)
  + cross_field_consistency_score (0–4)
```

**Total range: 0–20**

| Score | Label | Meaning |
|---|---|---|
| 17–20 | Strong | All fields populated, detailed description, plausible ratios, consistent operational profile |
| 12–16 | Good | Most fields present and consistent; minor gaps or brevity in description |
| 7–11 | Moderate | Partial coverage; some fields missing or description is thin |
| 3–6 | Weak | Multiple fields absent or inconsistent; record needs enrichment |
| 0–2 | Poor | Near-empty operational profile; likely a stub or pipeline failure |

---

## SQL Implementation

```sql
WITH parsed AS (
  SELECT
    unique_id,
    name,
    facilityTypeId,
    description,

    -- Specialties: parse JSON array, count distinct values
    CASE
      WHEN specialties IS NULL OR specialties = 'null' THEN NULL
      ELSE TRY_CAST(FROM_JSON(specialties, 'array<string>') AS ARRAY<STRING>)
    END AS specialties_arr,

    -- Procedure: parse JSON array
    CASE
      WHEN procedure IS NULL OR procedure = 'null' THEN NULL
      ELSE TRY_CAST(FROM_JSON(procedure, 'array<string>') AS ARRAY<STRING>)
    END AS procedure_arr,

    -- Equipment: parse JSON array
    CASE
      WHEN equipment IS NULL OR equipment = 'null' THEN NULL
      ELSE TRY_CAST(FROM_JSON(equipment, 'array<string>') AS ARRAY<STRING>)
    END AS equipment_arr,

    -- Capability: parse JSON array
    CASE
      WHEN capability IS NULL OR capability = 'null' THEN NULL
      ELSE TRY_CAST(FROM_JSON(capability, 'array<string>') AS ARRAY<STRING>)
    END AS capability_arr,

    -- numberDoctors: coerce to numeric; treat "null" string and non-numeric as NULL
    TRY_CAST(numberDoctors AS DOUBLE) AS doctors_num,

    -- capacity: coerce to numeric; treat "null" string and non-numeric as NULL
    TRY_CAST(capacity AS DOUBLE) AS capacity_num

  FROM databricks_virtue_foundation_dataset_dais_2026.virtue_foundation_dataset.facilities
),

scored AS (
  SELECT
    unique_id,
    name,
    facilityTypeId,
    description,
    doctors_num,
    capacity_num,

    -- ── Sub-score 1: Array field coverage (0–4) ──────────────────────────────
    (
      CASE WHEN specialties_arr IS NOT NULL AND SIZE(specialties_arr) > 0 THEN 1 ELSE 0 END
    + CASE WHEN procedure_arr  IS NOT NULL AND SIZE(procedure_arr)  > 0 THEN 1 ELSE 0 END
    + CASE WHEN equipment_arr  IS NOT NULL AND SIZE(equipment_arr)  > 0 THEN 1 ELSE 0 END
    + CASE WHEN capability_arr IS NOT NULL AND SIZE(capability_arr) > 0 THEN 1 ELSE 0 END
    ) AS array_coverage_score,

    -- ── Sub-score 2: Specialty depth — distinct count (0–4) ──────────────────
    CASE
      WHEN specialties_arr IS NULL OR SIZE(specialties_arr) = 0 THEN 0
      WHEN SIZE(ARRAY_DISTINCT(specialties_arr)) <= 2               THEN 1
      WHEN SIZE(ARRAY_DISTINCT(specialties_arr)) <= 5               THEN 2
      WHEN SIZE(ARRAY_DISTINCT(specialties_arr)) <= 10              THEN 3
      ELSE 4
    END AS specialty_depth_score,

    -- ── Sub-score 3: Description quality (0–4) ───────────────────────────────
    CASE
      WHEN description IS NULL OR description = 'null' OR TRIM(description) = '' THEN 0
      WHEN LENGTH(TRIM(description)) <= 20                                        THEN 1
      WHEN LENGTH(TRIM(description)) <= 49                                        THEN 2
      WHEN LENGTH(TRIM(description)) <= 199                                       THEN 3
      ELSE 4
    END AS description_quality_score,

    -- ── Sub-score 4: Numeric field validity (0–4) ────────────────────────────
    -- numberDoctors component (0–2)
    CASE
      WHEN doctors_num IS NULL OR doctors_num = 0 THEN 0
      ELSE 2
    END
    -- capacity component (0–2)
    + CASE
      WHEN capacity_num IS NULL OR capacity_num = 0 THEN 0
      ELSE 2
    END AS numeric_validity_score,

    -- ── Sub-score 5: Cross-field consistency (0–4) ───────────────────────────
    -- 5a: Doctor-to-capacity ratio (0–2)
    CASE
      WHEN doctors_num IS NULL OR capacity_num IS NULL THEN 0
      WHEN capacity_num = 0                            THEN 0
      WHEN doctors_num > capacity_num                  THEN 0
      ELSE 2
    END
    -- 5b: Specialties–procedure alignment (0–2)
    + CASE
      WHEN specialties_arr IS NULL OR SIZE(specialties_arr) = 0 THEN 0
      WHEN (procedure_arr IS NULL OR SIZE(procedure_arr) = 0)
        AND (equipment_arr IS NULL OR SIZE(equipment_arr) = 0)   THEN 0
      ELSE 2
    END AS cross_field_consistency_score

  FROM parsed
),

totals AS (
  SELECT
    *,
    array_coverage_score
      + specialty_depth_score
      + description_quality_score
      + numeric_validity_score
      + cross_field_consistency_score AS context_score
  FROM scored
)

SELECT
  unique_id,
  name,
  facilityTypeId,
  context_score,
  array_coverage_score,
  specialty_depth_score,
  description_quality_score,
  numeric_validity_score,
  cross_field_consistency_score,
  doctors_num,
  capacity_num,
  description
FROM totals
ORDER BY context_score DESC
```

---

## Score Distribution (10,088 facilities, June 2026)

| Score | Label | Facility count | % |
|---|---|---|---|
| 17–20 | Strong | 1,235 | 12.2% |
| 12–16 | Good | 6,052 | 60.0% |
| 7–11 | Moderate | 2,518 | 25.0% |
| 3–6 | Weak | 193 | 1.9% |
| 0–2 | Poor | 90 | 0.9% |

---

## Flags

A facility should be flagged for review if any of the following are true:

- `context_score <= 2` — near-empty operational profile; likely a stub or pipeline failure
- `array_coverage_score = 0` — all four array fields are null or empty; record has no operational data
- `cross_field_consistency_score = 0 AND numeric_validity_score = 4` — both numeric fields are present and valid but the ratio is impossible (`numberDoctors > capacity`); likely sourced from mismatched pages
- `specialty_depth_score >= 3 AND array_coverage_score <= 1` — many distinct specialties but no supporting procedure/equipment data; possible column misalignment
- `description_quality_score = 1` — description is present but ≤ 20 characters (e.g. `"Hospital"`, `"General hospital."`) — a placeholder rather than a real description

---

## Limitations

- **`"null"` string values:** `numberDoctors` and `capacity` store the literal string `"null"` in 62.9% and 73.9% of rows respectively. These are treated as missing. The root cause is an ingestion pipeline that serialises Python `None` as the string `"null"` rather than SQL `NULL`.
- **Duplicate specialties:** 98.6% of facilities with a `specialties` array contain duplicates. The `specialty_depth_score` uses `ARRAY_DISTINCT` to avoid inflating scores, but the duplicates themselves are a data quality issue that should be fixed at source.
- **Wrong-column data:** A small number of records have JSON arrays or UUIDs stored in `numberDoctors` or `capacity`. `TRY_CAST` silently coerces these to `NULL`, which means they score 0 on `numeric_validity_score` — the same as genuinely missing data. A separate check for `numberDoctors RLIKE '^\['` can surface these specifically.
- **Doctor-to-capacity ratio:** The ratio check assumes beds = capacity. Some facilities may report outpatient capacity rather than inpatient beds, making the ratio legitimately > 1. Manual review is needed to distinguish data errors from definitional differences.
- **Description boilerplate:** The length-based `description_quality_score` cannot detect boilerplate text (e.g. `"Apollo Spectra Hospitals Pune"` stored as the description for a different Apollo branch). A semantic similarity check against `name` would improve precision but is not implemented here.
- **Empty `[]` arrays:** `procedure` (724 rows), `equipment` (2,180 rows), and `capability` (19 rows) contain empty JSON arrays. These are treated as missing for scoring purposes. Whether they represent "no data collected" or "genuinely none" cannot be determined from the data alone.
