# Phone Number Validation Report

**Table:** `databricks_virtue_foundation_dataset_dais_2026.virtue_foundation_dataset.facilities`  
**Column:** `officialPhone`  
**Date:** 2026-06-15  
**Scope:** Indian facilities only (`address_countryCode = 'IN'`)

## Validation Rules

Indian phone numbers are considered valid if they match one of the following formats:

| Format | Pattern | Example |
|---|---|---|
| Mobile with country code | `+91` followed by a digit `6–9`, then 9 more digits | `+919693969347` |
| Mobile with leading zero | `0` followed by a digit `6–9`, then 9 more digits | `09693969347` |
| Mobile without prefix | Digit `6–9` followed by 9 more digits | `9693969347` |

**Total digits after country code:** always 10 for mobile numbers.  
**Valid mobile prefixes:** 6, 7, 8, 9 (TRAI-assigned mobile ranges).  
Landline and toll-free numbers (prefixes 1–5 after `+91`) require a separate validation rule and are flagged as warnings, not hard errors.

## Results Summary

| Category | Count | Severity |
|---|---|---|
| Valid (+91 mobile) | 7,423 | ✅ |
| Landline / Toll-free (prefix 1–5 after +91) | 2,025 | ⚠️ |
| Null / Missing (stored as string `"null"` or empty) | 497 | ❌ |
| Too many digits (>12 total digits) | 48 | ❌ |
| Other invalid format | 7 | ❌ |

## Invalid Examples

### Too Many Digits (>12)
Numbers with 13+ digits — one digit too many after `+91`. Likely a data entry error (e.g. duplicate digit, merged STD code).

| officialPhone | Digit Count | Issue |
|---|---|---|
| `+9118003456264` | 13 | 11 digits after `+91` instead of 10 |

### Landline / Toll-free (⚠️ Warning)
Numbers starting with `+911x` or `+912x` are landlines or toll-free numbers. These are not inherently invalid but require a separate validation rule accounting for STD codes (2–4 digits) + subscriber number.

| officialPhone | Issue |
|---|---|
| `+914061626364` | Landline prefix (`+9140` = Hyderabad STD) |
| `+911143364336` | Landline prefix (`+9111` = Delhi STD) |
| `+911616617111` | Landline prefix |

### Null / Missing
497 records store the literal string `"null"` instead of a proper SQL `NULL`, or have an empty string.

## SQL Validation Query

```sql
SELECT
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
      THEN 'Landline / Toll-free (not mobile prefix)'
    ELSE 'Other invalid format'
  END AS issue,
  COUNT(*) AS count
FROM databricks_virtue_foundation_dataset_dais_2026.virtue_foundation_dataset.facilities
WHERE address_countryCode = 'IN'
GROUP BY officialPhone, issue
ORDER BY issue, count DESC;
```

## Data Quality Issues

- **`"null"` string values:** 497 records store the literal string `"null"` instead of SQL `NULL`. These should be coerced to proper `NULL` during ingestion.
- **Too many digits:** 48 records have 13+ total digits (e.g. `+9118003456264`). Likely caused by a duplicate digit or an STD code being prepended to an already-complete number.
- **Landline numbers lack STD-aware validation:** 2,025 numbers use landline/toll-free prefixes. A proper landline rule must account for variable-length STD codes (2–4 digits) and is not currently implemented.
