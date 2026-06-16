# Context Validation

> **Agent:** `ContextAgent`
> **Rubric role:** The SQL below is for data retrieval only. Sub-score thresholds and the final score are determined by the agent after fetching the raw fields. The scoring tables are calibrated defaults — the agent should apply judgment rather than mechanically applying `CASE/ELSE 0` logic. See [Agent Judgment Guidelines](#agent-judgment-guidelines).

Scores each facility's contextual fields across seven signals — `specialties`, `procedure`, `equipment`, `capability`, `description`, `numberDoctors`, and `capacity` — producing a **context score (0–20)** that reflects how well the data can be internally verified, not merely how complete or self-consistent it appears.

A high score means the fields corroborate each other in ways that are hard to fake through incomplete scraping. A low score means the record lacks the cross-field evidence needed to trust its operational profile.

> **Plausibility vs. verification:** Completeness and internal consistency are necessary but not sufficient. A record can have all fields populated with internally coherent values that are still factually wrong (e.g. boilerplate descriptions from a different branch, specialty lists copied from a template). The checks below are designed to catch those cases, not just reward presence.

---

## Fields Evaluated

| Field | Type | NULL / missing rate | Notes |
|---|---|---|---|
| `specialties` | JSON array of strings | 1.1% null + rare empty `[]` | camelCase values (e.g. `"cardiology"`, `"internalMedicine"`) |
| `procedure` | JSON array of strings | 1.1% null + 7.2% empty `[]` | Natural language sentences from scrape |
| `equipment` | JSON array of strings | 1.1% null + 21.6% empty `[]` | Natural language sentences from scrape |
| `capability` | JSON array of strings | 1.1% null + 0.2% empty `[]` | Natural language sentences from scrape |
| `description` | String | 0.8% | Quality varies widely; boilerplate is common |
| `numberDoctors` | String (numeric) | 62.9% stored as `"null"` | Only ~37% have a real numeric value |
| `capacity` | String (numeric) | 73.9% stored as `"null"` | Only ~26% have a real numeric value |
| `facilityTypeId` | String (controlled vocab) | 0.57% NULL | Canonical set: `hospital`, `clinic`, `dentist`, `pharmacy`, `nursing_home` |
| `operatorTypeId` | String (controlled vocab) | 6.88% NULL | Canonical set: `private`, `public` |

> **Note on `"null"` strings:** `numberDoctors` and `capacity` store the literal string `"null"` rather than SQL `NULL` in the majority of rows. These are treated as missing throughout.

---

## Scoring

Six sub-scores are computed independently and summed.

### Sub-score 1: Operational Field Coverage (0–4 pts)

A prerequisite check: how many of the four operational array fields are non-null and non-empty. Without populated fields there is nothing to verify. Each field contributes 1 point.

| Non-empty array fields (`specialties`, `procedure`, `equipment`, `capability`) | Points |
|---|---|
| 0 | 0 |
| 1 | 1 |
| 2 | 2 |
| 3 | 3 |
| 4 | 4 |

A field counts as populated if it is not NULL, not the string `"null"`, not an empty array `[]`, and parses as a valid JSON array with at least one non-empty item.

---

### Sub-score 2: Description–Name Corroboration (0–4 pts)

Checks whether the `description` field actually refers to this specific facility, by testing whether a meaningful word from the facility `name` appears in the description text. This catches the most common description quality failure in the dataset: boilerplate text copied from a different branch or a generic listing (e.g. `"Apollo Spectra Hospitals Pune"` stored as the description for a different Apollo facility).

**Anchor word selection:** The first word of `name` is used unless it is a title or honorific (`Dr.`, `Dr`, `The`, `Sri`, `Shri`, `Shree`, `Smt.`, `Smt`, `Late`), in which case the second word is used. Words of 4 characters or fewer are too short to be distinctive and are not used.

| Condition | Points |
|---|---|
| `description` is NULL, `"null"`, or empty | 0 |
| Anchor word is ≤ 4 characters (too short to be distinctive) | 1 — description present but unverifiable by name |
| Anchor word (> 4 chars) is **absent** from `description` | 1 — description does not reference this facility by name |
| Anchor word (> 4 chars) is **present** in `description`, description < 50 chars | 2 — name confirmed but description is too thin to add context |
| Anchor word present, description 50–199 chars | 3 |
| Anchor word present, description ≥ 200 chars | 4 |

> **Observed:** Of 7,851 facilities with a checkable anchor word (> 4 chars) and a non-empty description, 4,534 (57.8%) have the anchor word present in the description. 3,317 (42.2%) do not — these are the primary target of this check.

---

### Sub-score 3: Specialty–Description Consistency (0–4 pts)

Checks whether the `specialties` array and `description` are consistent with each other. Rather than rewarding overlap (which is weak — only ~20% of descriptions name specialties explicitly), this sub-score **penalises contradiction**: if the description mentions a named medical specialty that is entirely absent from the `specialties` array, the record is inconsistent.

The check uses a fixed vocabulary of 15 specialty keywords that are both common in the dataset and unambiguous as substrings (e.g. `"cardiology"`, `"oncology"`, `"ophthalmology"`). A keyword "mentioned in description" means it appears as a substring in `LOWER(description)`. A keyword "present in specialties" means it appears as a substring in `LOWER(specialties)`.

| Condition | Points |
|---|---|
| `specialties` is NULL/empty OR `description` is NULL/empty/short (< 50 chars) | 0 — not enough data to check |
| Description mentions ≥ 1 specialty keyword that is **absent** from `specialties` | 1 — contradiction: description claims a specialty the record doesn't list |
| Description mentions no specialty keywords at all (neutral) | 2 — description talks about other aspects (infrastructure, affiliations) |
| Description mentions ≥ 1 specialty keyword AND all mentioned keywords are covered by `specialties` | 3 — positive corroboration |

> **Specialty keyword vocabulary:** `cardiology`, `oncology`, `orthopedic` / `orthopaedic`, `neurology` / `neurosurgery`, `ophthalmology`, `gynecology` / `gynaecology`, `pediatric` / `paediatric`, `urology`, `gastroenterology`, `dermatology`, `psychiatry`, `radiology`, `pathology`, `pulmonology`, `nephrology`.

> **Rationale for asymmetry:** Rewarding overlap is a weak signal because most descriptions do not enumerate specialties. Penalising contradiction is a stronger signal because a description that names a specialty the `specialties` array omits points to a real inconsistency — either the array is incomplete or the description is from a different source.

---

### Sub-score 4: Numeric Field Presence (0–4 pts)

Checks whether `numberDoctors` and `capacity` are present and parse as positive numbers. This is a pure presence check — verification against external bounds is handled in sub-score 5.

#### `numberDoctors` (0–2 pts)

| Condition | Points |
|---|---|
| NULL, `"null"`, non-numeric, or 0 | 0 |
| Numeric and ≥ 1 | 2 |

#### `capacity` (0–2 pts)

| Condition | Points |
|---|---|
| NULL, `"null"`, non-numeric, or 0 | 0 |
| Numeric and ≥ 1 | 2 |

> **Wrong-column data:** A small number of records store JSON arrays or UUIDs in `numberDoctors` or `capacity`. `TRY_CAST` coerces these to `NULL`, scoring 0. Use `numberDoctors RLIKE '^\['` to surface these separately.

---

### Sub-score 5: Doctor-to-Capacity Ratio (0–2 pts)

`numberDoctors > capacity` (with `capacity > 0`) is an impossible operational state. When both fields are numeric and positive, the ratio is verified.

| Condition | Points |
|---|---|
| Either field is missing, non-numeric, or zero | 0 — not enough data to verify (no penalty; sub-score 4 already handles absence) |
| `numberDoctors > capacity` | 0 — impossible ratio; fields contradict each other |
| `numberDoctors ≤ capacity` | 2 — fields are mutually consistent |

> **Observed:** 82 facilities have `numberDoctors > capacity` (with `capacity > 0`). These are likely sourced from mismatched pages — doctor count from a staff directory, bed count from an insurance listing.

---

### Sub-score 6: Classification Validity (0–6 pts)

Three checks that verify the facility's classification fields are both canonical and internally consistent. Because `facilityTypeId` is a prerequisite for the type-aware numeric bounds check, vocabulary compliance and bounds verification are grouped here.

#### 6a. `facilityTypeId`-aware numeric bounds (0–2 pts)

Even when `numberDoctors ≤ capacity`, values that far exceed the p95 for their facility type are likely data errors. Thresholds are derived from the actual distribution in the dataset (June 2026).

| `facilityTypeId` | Capacity threshold | Doctors threshold |
|---|---|---|
| `hospital` | > 800 beds | > 200 doctors |
| `clinic` | > 234 beds | > 46 doctors |
| `dentist` | > 28 beds | > 18 doctors |
| Other / NULL | — (not checked) | — (not checked) |

| Condition | Points |
|---|---|
| `facilityTypeId` is not in the checked set, or either numeric field is missing | 0 — not verifiable against type bounds |
| Either field exceeds the p95 threshold for its `facilityTypeId` | 0 — value is an outlier relative to its facility type |
| Both fields are within p95 bounds for their `facilityTypeId` | 2 |

> **Observed:** 99 hospitals and 6 clinics have at least one numeric field exceeding the p95 bound for their type. Hard upper bounds (p99+) catch zero records in this dataset, confirming these are outliers rather than extreme entry errors — but they still warrant review.

#### 6b. Controlled vocabulary compliance (0–4 pts)

Checks whether `facilityTypeId` and `operatorTypeId` contain only canonical values. Out-of-vocabulary values indicate ingestion inconsistencies, labelling errors, or new source systems that have not been normalised. A record with non-canonical classification fields cannot be reliably typed or filtered downstream.

**Canonical value sets:**

| Column | Allowed Values |
|---|---|
| `facilityTypeId` | `hospital`, `clinic`, `dentist`, `pharmacy`, `nursing_home` |
| `operatorTypeId` | `private`, `public` |

`facilityTypeId` (0–2 pts):

| Condition | Points |
|---|---|
| NULL | 0 |
| Value not in canonical set (e.g. `"doctor"`) | 1 — present but unrecognised |
| Value in canonical set | 2 |

`operatorTypeId` (0–2 pts):

| Condition | Points |
|---|---|
| NULL | 0 |
| `"government"` | 1 — likely synonym for `"public"`; flag for normalisation |
| Value not in canonical set (other) | 1 — present but unrecognised |
| Value in canonical set (`private`, `public`) | 2 |

> **Observed (June 2026, `workspace.default.facilities`):**
> - `facilityTypeId`: 5,626 `hospital`, 3,782 `clinic`, 490 `dentist`, 2 `pharmacy`, 1 `nursing_home`, 57 NULL, 21 `doctor` (⚠️ needs review)
> - `operatorTypeId`: 8,835 `private`, 465 `public`, 687 NULL, 2 `government` (⚠️ synonym for `public`)

> **Note on `"government"`:** Until a canonical value is decided, `"government"` scores 1 rather than 0 — it is not an error, but it is not normalised. See `known-data-quality-issues/` for the pending fix.

---

### Scoring Formula

```
context_score =
    operational_coverage_score   (0–4)
  + description_name_score       (0–4)
  + specialty_consistency_score  (0–4)
  + numeric_presence_score       (0–4)
  + ratio_score                  (0–2)
  + classification_score         (0–6)
```

**Total range: 0–20**

| Sub-score | Range | Description |
|---|---|---|
| 1: Operational coverage | 0–4 | Array field population |
| 2: Description–name corroboration | 0–4 | Description references this facility |
| 3: Specialty–description consistency | 0–4 | Description and specialties don't contradict |
| 4: Numeric field presence | 0–4 | `numberDoctors` and `capacity` populated |
| 5: Doctor-to-capacity ratio | 0–2 | Ratio is physically plausible |
| 6: Classification validity (6a + 6b + 6c) | 0–6 | Type bounds + vocab compliance for both classification fields |
| **Total** | **0–20** | |

| Score | Label | Meaning |
|---|---|---|
| 17–20 | Strong | Fields corroborate each other; description references this facility by name; specialties and description are consistent; numeric values are present and within type bounds; classification fields are canonical |
| 12–16 | Good | Most verification checks pass; minor gaps (e.g. description doesn't name a specialty, or one numeric field is missing) |
| 7–11 | Moderate | Some corroboration present but notable gaps — description may not reference the facility, or numeric fields are absent |
| 3–6 | Weak | Little cross-field evidence; record may be a stub, boilerplate, or pipeline failure |
| 0–2 | Poor | No verifiable signals; treat as untrustworthy until enriched |

---

## SQL — Data Retrieval

The agent uses this query to fetch raw contextual fields. Sub-score computation and the final `context_score` are determined by the agent after retrieval, not inside the SQL. The scoring `CASE` expressions in the full query below are reference scaffolding only — the agent applies the scoring tables from the rubric above with judgment.

```sql
WITH parsed AS (
  SELECT
    unique_id,
    name,
    facilityTypeId,
    operatorTypeId,
    description,

    -- Array fields: parse JSON, treat "null" string and empty arrays as absent
    TRY_CAST(FROM_JSON(specialties, 'array<string>') AS ARRAY<STRING>)  AS specialties_arr,
    TRY_CAST(FROM_JSON(procedure,   'array<string>') AS ARRAY<STRING>)  AS procedure_arr,
    TRY_CAST(FROM_JSON(equipment,   'array<string>') AS ARRAY<STRING>)  AS equipment_arr,
    TRY_CAST(FROM_JSON(capability,  'array<string>') AS ARRAY<STRING>)  AS capability_arr,

    -- Numeric fields: coerce; "null" string and non-numeric become NULL
    TRY_CAST(numberDoctors AS DOUBLE) AS doctors_num,
    TRY_CAST(capacity      AS DOUBLE) AS capacity_num,

    -- Anchor word for name-corroboration check
    CASE
      WHEN LOWER(SPLIT(name, ' ')[0]) IN ('dr.','dr','the','sri','shri','shree','smt.','smt','late')
        THEN LOWER(SPLIT(name, ' ')[1])
      ELSE LOWER(SPLIT(name, ' ')[0])
    END AS anchor_word,

    -- Specialty keyword hits in description (15-keyword vocabulary)
    (CASE WHEN INSTR(LOWER(description), 'cardiology')       > 0 THEN 1 ELSE 0 END
   + CASE WHEN INSTR(LOWER(description), 'oncology')         > 0 THEN 1 ELSE 0 END
   + CASE WHEN INSTR(LOWER(description), 'orthopedic')       > 0
       OR  INSTR(LOWER(description), 'orthopaedic')          > 0 THEN 1 ELSE 0 END
   + CASE WHEN INSTR(LOWER(description), 'neurology')        > 0
       OR  INSTR(LOWER(description), 'neurosurgery')         > 0 THEN 1 ELSE 0 END
   + CASE WHEN INSTR(LOWER(description), 'ophthalmology')    > 0 THEN 1 ELSE 0 END
   + CASE WHEN INSTR(LOWER(description), 'gynecology')       > 0
       OR  INSTR(LOWER(description), 'gynaecology')          > 0 THEN 1 ELSE 0 END
   + CASE WHEN INSTR(LOWER(description), 'pediatric')        > 0
       OR  INSTR(LOWER(description), 'paediatric')           > 0 THEN 1 ELSE 0 END
   + CASE WHEN INSTR(LOWER(description), 'urology')          > 0 THEN 1 ELSE 0 END
   + CASE WHEN INSTR(LOWER(description), 'gastroenterology') > 0 THEN 1 ELSE 0 END
   + CASE WHEN INSTR(LOWER(description), 'dermatology')      > 0 THEN 1 ELSE 0 END
   + CASE WHEN INSTR(LOWER(description), 'psychiatry')       > 0 THEN 1 ELSE 0 END
   + CASE WHEN INSTR(LOWER(description), 'radiology')        > 0 THEN 1 ELSE 0 END
   + CASE WHEN INSTR(LOWER(description), 'pathology')        > 0 THEN 1 ELSE 0 END
   + CASE WHEN INSTR(LOWER(description), 'pulmonology')      > 0 THEN 1 ELSE 0 END
   + CASE WHEN INSTR(LOWER(description), 'nephrology')       > 0 THEN 1 ELSE 0 END
    ) AS desc_kw_hits,

    -- Same keyword hits in specialties array (keywords are substrings of camelCase values)
    (CASE WHEN INSTR(LOWER(specialties), 'cardiology')       > 0 THEN 1 ELSE 0 END
   + CASE WHEN INSTR(LOWER(specialties), 'oncology')         > 0 THEN 1 ELSE 0 END
   + CASE WHEN INSTR(LOWER(specialties), 'orthopedic')       > 0
       OR  INSTR(LOWER(specialties), 'orthopaedic')          > 0 THEN 1 ELSE 0 END
   + CASE WHEN INSTR(LOWER(specialties), 'neurology')        > 0
       OR  INSTR(LOWER(specialties), 'neurosurgery')         > 0 THEN 1 ELSE 0 END
   + CASE WHEN INSTR(LOWER(specialties), 'ophthalmology')    > 0 THEN 1 ELSE 0 END
   + CASE WHEN INSTR(LOWER(specialties), 'gynecology')       > 0
       OR  INSTR(LOWER(specialties), 'gynaecology')          > 0 THEN 1 ELSE 0 END
   + CASE WHEN INSTR(LOWER(specialties), 'pediatric')        > 0
       OR  INSTR(LOWER(specialties), 'paediatric')           > 0 THEN 1 ELSE 0 END
   + CASE WHEN INSTR(LOWER(specialties), 'urology')          > 0 THEN 1 ELSE 0 END
   + CASE WHEN INSTR(LOWER(specialties), 'gastroenterology') > 0 THEN 1 ELSE 0 END
   + CASE WHEN INSTR(LOWER(specialties), 'dermatology')      > 0 THEN 1 ELSE 0 END
   + CASE WHEN INSTR(LOWER(specialties), 'psychiatry')       > 0 THEN 1 ELSE 0 END
   + CASE WHEN INSTR(LOWER(specialties), 'radiology')        > 0 THEN 1 ELSE 0 END
   + CASE WHEN INSTR(LOWER(specialties), 'pathology')        > 0 THEN 1 ELSE 0 END
   + CASE WHEN INSTR(LOWER(specialties), 'pulmonology')      > 0 THEN 1 ELSE 0 END
   + CASE WHEN INSTR(LOWER(specialties), 'nephrology')       > 0 THEN 1 ELSE 0 END
    ) AS spec_kw_hits

  FROM databricks_virtue_foundation_dataset_dais_2026.virtue_foundation_dataset.facilities
),

parsed2 AS (
  SELECT
    *,
    (specialties_arr IS NOT NULL AND SIZE(specialties_arr) > 0) AS specs_populated,
    (procedure_arr   IS NOT NULL AND SIZE(procedure_arr)   > 0) AS proc_populated,
    (equipment_arr   IS NOT NULL AND SIZE(equipment_arr)   > 0) AS equip_populated,
    (capability_arr  IS NOT NULL AND SIZE(capability_arr)  > 0) AS cap_populated,
    (description IS NOT NULL AND description != 'null' AND TRIM(description) != '') AS desc_present,
    LENGTH(TRIM(COALESCE(description, ''))) AS desc_len
  FROM parsed
),

scored AS (
  SELECT
    unique_id,
    name,
    facilityTypeId,
    operatorTypeId,
    description,
    doctors_num,
    capacity_num,
    anchor_word,
    desc_kw_hits,
    spec_kw_hits,

    -- ── Sub-score 1: Operational field coverage (0–4) ────────────────────────
    (CASE WHEN specs_populated THEN 1 ELSE 0 END
   + CASE WHEN proc_populated  THEN 1 ELSE 0 END
   + CASE WHEN equip_populated THEN 1 ELSE 0 END
   + CASE WHEN cap_populated   THEN 1 ELSE 0 END) AS operational_coverage_score,

    -- ── Sub-score 2: Description–name corroboration (0–4) ────────────────────
    CASE
      WHEN NOT desc_present                                                   THEN 0
      WHEN LENGTH(anchor_word) <= 4                                           THEN 1
      WHEN INSTR(LOWER(description), anchor_word) = 0                        THEN 1
      WHEN INSTR(LOWER(description), anchor_word) > 0 AND desc_len < 50      THEN 2
      WHEN INSTR(LOWER(description), anchor_word) > 0 AND desc_len < 200     THEN 3
      ELSE 4
    END AS description_name_score,

    -- ── Sub-score 3: Specialty–description consistency (0–4) ─────────────────
    CASE
      WHEN NOT specs_populated OR NOT desc_present OR desc_len < 50          THEN 0
      WHEN desc_kw_hits > 0 AND spec_kw_hits < desc_kw_hits                 THEN 1
      WHEN desc_kw_hits = 0                                                  THEN 2
      ELSE 3
    END AS specialty_consistency_score,

    -- ── Sub-score 4: Numeric field presence (0–4) ────────────────────────────
    (CASE WHEN doctors_num IS NOT NULL AND doctors_num > 0 THEN 2 ELSE 0 END
   + CASE WHEN capacity_num IS NOT NULL AND capacity_num > 0 THEN 2 ELSE 0 END
    ) AS numeric_presence_score,

    -- ── Sub-score 5: Doctor-to-capacity ratio (0–2) ──────────────────────────
    CASE
      WHEN doctors_num IS NULL OR capacity_num IS NULL
        OR doctors_num = 0 OR capacity_num = 0                               THEN 0
      WHEN doctors_num > capacity_num                                        THEN 0
      ELSE 2
    END AS ratio_score,

    -- ── Sub-score 6: Classification validity (0–6) ───────────────────────────
    -- 6a: facilityTypeId-aware numeric bounds (0–2)
    CASE
      WHEN facilityTypeId NOT IN ('hospital', 'clinic', 'dentist')
        OR doctors_num IS NULL OR capacity_num IS NULL                       THEN 0
      WHEN facilityTypeId = 'hospital'
        AND capacity_num  <= 800
        AND doctors_num   <= 200                                             THEN 2
      WHEN facilityTypeId = 'clinic'
        AND capacity_num  <= 234
        AND doctors_num   <= 46                                              THEN 2
      WHEN facilityTypeId = 'dentist'
        AND capacity_num  <= 28
        AND doctors_num   <= 18                                              THEN 2
      ELSE 0
    END
    -- 6b: facilityTypeId vocabulary compliance (0–2)
    + CASE
      WHEN facilityTypeId IS NULL                                                          THEN 0
      WHEN facilityTypeId NOT IN ('hospital','clinic','dentist','pharmacy','nursing_home') THEN 1
      ELSE 2
    END
    -- 6c: operatorTypeId vocabulary compliance (0–2)
    + CASE
      WHEN operatorTypeId IS NULL                          THEN 0
      WHEN operatorTypeId = 'government'                   THEN 1
      WHEN operatorTypeId NOT IN ('private','public')      THEN 1
      ELSE 2
    END AS classification_score

  FROM parsed2
),

totals AS (
  SELECT
    *,
    operational_coverage_score
      + description_name_score
      + specialty_consistency_score
      + numeric_presence_score
      + ratio_score
      + classification_score AS context_score
  FROM scored
)

SELECT
  unique_id,
  name,
  facilityTypeId,
  operatorTypeId,
  context_score,
  operational_coverage_score,
  description_name_score,
  specialty_consistency_score,
  numeric_presence_score,
  ratio_score,
  classification_score,
  doctors_num,
  capacity_num,
  anchor_word,
  desc_kw_hits,
  spec_kw_hits,
  description
FROM totals
ORDER BY context_score DESC
```

---

## Score Distribution (10,088 facilities, June 2026)

| Score | Label | Facility count | % |
|---|---|---|---|
| 17–20 | Strong | 447 | 4.4% |
| 12–16 | Good | 1,457 | 14.4% |
| 7–11 | Moderate | 6,431 | 63.7% |
| 3–6 | Weak | 1,657 | 16.4% |
| 0–2 | Poor | 96 | 1.0% |

> **Note on distribution shift:** The previous completeness-based scoring had 72% of facilities in Strong/Good. The verification-based scoring has only 19% there. This is expected — the bar is harder to clear when fields must corroborate each other rather than simply be present.

> **Note on sub-score restructuring:** Sub-score 5 was split into two: the doctor-to-capacity ratio (now sub-score 5, 0–2) and a new classification validity sub-score (sub-score 6, 0–6) that absorbs the type-aware numeric bounds (6a) alongside vocabulary compliance for `facilityTypeId` (6b) and `operatorTypeId` (6c). The total remains 0–20. The distribution table above reflects the pre-restructuring baseline; rerun the query to get updated counts.

---

## Flags

A facility should be flagged for review if any of the following are true:

- `description_name_score = 1 AND LENGTH(description) > 50` — description is substantive but does not reference the facility by name; likely boilerplate from a different branch or source
- `specialty_consistency_score = 1` — description explicitly names a specialty that the `specialties` array does not contain; the two fields contradict each other
- `ratio_score = 0 AND numeric_presence_score = 4` — both numeric fields are present and positive but the ratio is impossible; likely sourced from mismatched pages
- `classification_score <= 2` — type-aware bounds fail or one/both classification fields are NULL or out-of-vocabulary; record cannot be reliably typed or filtered by facility/operator category
- `operational_coverage_score = 0` — no operational array fields at all; record has no verifiable clinical profile
- `context_score <= 2` — fewer than 3 points across all checks; treat as untrustworthy until enriched

---

## Agent Judgment Guidelines

The scoring tables above are calibrated defaults. The agent applies judgment in the following situations:

- **Specialty keyword misses:** The 15-keyword list is not exhaustive. If a facility's `specialties` or `description` contains a clearly valid specialty not in the list (e.g. `"interventional radiology"`, `"neuroimmunology"`), the agent should count it toward the specialty corroboration sub-score rather than ignoring it.
- **`numberDoctors` / `capacity` stored as `"null"` string:** These are ingestion artifacts. The agent should treat them as missing data (score 0 on those sub-scores) but note them as pipeline issues rather than data quality failures of the facility itself.
- **Doctor-to-capacity ratio edge cases:** A ratio > 1 may indicate outpatient capacity rather than inpatient beds. The agent should not penalise if the facility type (e.g. polyclinic, day-surgery centre) makes a high ratio plausible.
- **Boilerplate description detection:** If the `description` is identical or near-identical across multiple facilities in the same chain, the agent should flag it as a potential copy-paste and reduce the description sub-score accordingly, even if the anchor-word check passes.
- **Controlled vocabulary unlisted values:** New values not in the canonical set (e.g. `"polyclinic"`, `"ngo"`) should be evaluated by the agent on their merits rather than automatically scoring 1. If the value is clearly a valid facility type, award full credit.

---

## Limitations

- **`"null"` string values:** `numberDoctors` and `capacity` store the literal string `"null"` in 62.9% and 73.9% of rows respectively. `TRY_CAST` coerces these to `NULL`. The root cause is an ingestion pipeline serialising Python `None` as `"null"` rather than SQL `NULL`.
- **Anchor word for name corroboration:** The anchor-word heuristic fails for facilities whose names start with a common word that also appears in unrelated descriptions (e.g. `"Smile"`, `"Sai"`). It also cannot be applied when the anchor word is ≤ 4 characters. These cases score 1 (description present but unverifiable) rather than 0.
- **Specialty keyword vocabulary is static:** The 15-keyword list covers common named specialties but misses compound or rare ones (e.g. `"interventionalRadiology"`, `"neuroimmunology"`). Keywords not in the list cannot contribute to sub-score 3 in either direction. Expand the list as new specialty values enter the pipeline.
- **Specialty–description check is approximate:** The contradiction check (`desc_kw_hits > spec_kw_hits`) is a proxy — it detects when the description mentions *more* specialty types than the array covers, not a precise per-keyword mismatch. A facility with `desc_kw_hits = 2` and `spec_kw_hits = 1` scores 1 even if the one matching keyword is different from the two in the description.
- **`facilityTypeId`-aware bounds apply to only 3 types:** `nursing_home` and `pharmacy` are excluded due to insufficient sample sizes with both numeric fields populated. These facilities score 0 on sub-score 6a regardless of their values.
- **`procedure` / `equipment` / `capability` are not cross-checked against each other:** All three fields are natural-language sentences from the same scrape source, making cross-checks circular rather than verifying. Verification of these fields requires an external reference (e.g. matching against a procedure taxonomy or equipment registry).
- **Doctor-to-capacity ratio assumes beds = capacity:** Some facilities may report outpatient capacity rather than inpatient beds, making the ratio legitimately > 1. Manual review is needed to distinguish data errors from definitional differences.
- **Controlled vocabulary canonical sets are manually maintained:** New values entering the pipeline (e.g. a new source system using `"polyclinic"` or `"ngo"`) will silently score 1 until the canonical set is updated. Re-run the vocabulary audit query periodically to detect new out-of-vocabulary values.
