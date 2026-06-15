# Non-Standard State Names in `address_stateOrRegion` Column

## Summary

103 rows in the `facilities` table use non-standard, abbreviated, or pre-rename state names in `address_stateOrRegion` that do not match the official state names used in the **India Post Pincode Directory**. Because `location_validation.md` cross-validates `address_stateOrRegion` against `statename` in the pincode directory, these rows would produce false `MISMATCH` results without normalisation.

- **Table**: `databricks_virtue_foundation_dataset_dais_2026.virtue_foundation_dataset.facilities`
- **Column**: `address_stateOrRegion`
- **Affected rows**: 103

## Affected Values

| Raw value | Canonical value (pin statename) | Affected rows | Reason |
|---|---|---|---|
| `TamilNadu` / `Tamilnadu` | `Tamil Nadu` | 22 | Missing space |
| `U.P` / `U.P.` | `Uttar Pradesh` | ~74 | Abbreviation |
| `M.P` / `M.P.` | `Madhya Pradesh` | — | Abbreviation |
| `Orissa` | `Odisha` | 7 | State officially renamed (2011) |
| `Uttaranchal` | `Uttarakhand` | — | State officially renamed (2007) |
| `Pondicherry` | `Puducherry` | — | Territory officially renamed (2006) |
| `Andaman and Nicobar` | `Andaman & Nicobar Islands` | — | Ampersand and suffix missing |
| `Jammu and Kashmir` | `Jammu & Kashmir` | — | Ampersand variant |

> Note: The `Andhra Pradesh` → `Telangana` bifurcation (2014) is intentionally **not** normalised here. Facilities in Telangana that carry `"Andhra Pradesh"` represent a genuine data staleness issue that should be reviewed manually, not silently rewritten.

## Detection Query

```sql
SELECT address_stateOrRegion, COUNT(*) AS cnt
FROM databricks_virtue_foundation_dataset_dais_2026.virtue_foundation_dataset.facilities
WHERE UPPER(TRIM(address_stateOrRegion)) IN (
  'TAMILNADU', 'ORISSA', 'UTTARANCHAL', 'PONDICHERRY',
  'ANDAMAN AND NICOBAR', 'JAMMU AND KASHMIR', 'U.P', 'U.P.', 'M.P', 'M.P.'
)
GROUP BY address_stateOrRegion
ORDER BY cnt DESC;
```

## Root Cause

State names in source data were entered using abbreviations, pre-rename spellings, or punctuation variants. Several Indian states and union territories were officially renamed between 2006 and 2011 (Orissa → Odisha, Uttaranchal → Uttarakhand, Pondicherry → Puducherry), and source scrapers have not been updated to reflect these changes.

## Fix

```sql
CASE UPPER(TRIM(address_stateOrRegion))
  WHEN 'TAMILNADU'           THEN 'Tamil Nadu'
  WHEN 'ORISSA'              THEN 'Odisha'
  WHEN 'UTTARANCHAL'         THEN 'Uttarakhand'
  WHEN 'PONDICHERRY'         THEN 'Puducherry'
  WHEN 'ANDAMAN AND NICOBAR' THEN 'Andaman & Nicobar Islands'
  WHEN 'JAMMU AND KASHMIR'   THEN 'Jammu & Kashmir'
  WHEN 'U.P'                 THEN 'Uttar Pradesh'
  WHEN 'U.P.'                THEN 'Uttar Pradesh'
  WHEN 'M.P'                 THEN 'Madhya Pradesh'
  WHEN 'M.P.'                THEN 'Madhya Pradesh'
  ELSE address_stateOrRegion
END AS address_stateOrRegion
```
