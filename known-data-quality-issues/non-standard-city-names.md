# Non-Standard City Names in `address_city` Column

## Summary

799 rows in the `facilities` table use colloquial, legacy, or abbreviated city names in `address_city` that do not match the official district names used in the **India Post Pincode Directory**. Because `location_validation.md` cross-validates `address_city` against `district` in the pincode directory, these rows would produce false `MISMATCH` results without normalisation.

- **Table**: `databricks_virtue_foundation_dataset_dais_2026.virtue_foundation_dataset.facilities`
- **Column**: `address_city`
- **Affected rows**: 799

## Affected Values

| Raw value | Canonical value (pin district) | Affected rows | Reason |
|---|---|---|---|
| `Ahmedabad` | `Ahmadabad` | 326 | Official postal spelling |
| `Bangalore` | `Bengaluru Urban` | 204 | City renamed + district suffix |
| `Gurgaon` | `Gurugram` | 82 | City officially renamed (2016) |
| `Kanpur` | `Kanpur Nagar` | 63 | District suffix missing |
| `Allahabad` | `Prayagraj` | 29 | City officially renamed (2018) |
| `Trivandrum` | `Thiruvananthapuram` | 20 | Anglicised name |
| `Mangalore` | `Dakshina Kannada` | 15 | City is within this district |
| `Calicut` | `Kozhikode` | 14 | Anglicised name |
| `Hubli` | `Dharwad` | 11 | City is within this district |
| `Cochin` | `Ernakulam` | 11 | Anglicised name |
| `Mysore` | `Mysuru` | 9 | City officially renamed (2014) |
| `Vizag` | `Visakhapatnam` | 7 | Abbreviation |
| `Baroda` | `Vadodara` | 5 | City officially renamed |
| `Pondicherry` | `Puducherry` | 2 | Territory officially renamed (2006) |
| `Ahemdabad` | `Ahmadabad` | 1 | Misspelling of Ahmedabad |

## Detection Query

```sql
SELECT address_city, COUNT(*) AS cnt
FROM databricks_virtue_foundation_dataset_dais_2026.virtue_foundation_dataset.facilities
WHERE UPPER(TRIM(address_city)) IN (
  'AHMEDABAD', 'AHEMDABAD', 'BANGALORE', 'BOMBAY', 'GURGAON', 'KANPUR',
  'MYSORE', 'MANGALORE', 'CALICUT', 'COCHIN', 'TRIVANDRUM', 'ALLAHABAD',
  'VIZAG', 'PONDICHERRY', 'BARODA', 'HUBLI'
)
GROUP BY address_city
ORDER BY cnt DESC;
```

## Root Cause

City names in source data were entered using colloquial, anglicised, or pre-rename spellings rather than the current official names used by India Post. Several Indian cities were officially renamed between 2006 and 2018 (Bangalore → Bengaluru, Gurgaon → Gurugram, Allahabad → Prayagraj, etc.), and source scrapers have not been updated to reflect these changes.

## Fix

```sql
CASE UPPER(TRIM(address_city))
  WHEN 'AHMEDABAD'   THEN 'Ahmadabad'
  WHEN 'AHEMDABAD'   THEN 'Ahmadabad'
  WHEN 'BANGALORE'   THEN 'Bengaluru Urban'
  WHEN 'BOMBAY'      THEN 'Mumbai'
  WHEN 'GURGAON'     THEN 'Gurugram'
  WHEN 'KANPUR'      THEN 'Kanpur Nagar'
  WHEN 'MYSORE'      THEN 'Mysuru'
  WHEN 'MANGALORE'   THEN 'Dakshina Kannada'
  WHEN 'CALICUT'     THEN 'Kozhikode'
  WHEN 'COCHIN'      THEN 'Ernakulam'
  WHEN 'TRIVANDRUM'  THEN 'Thiruvananthapuram'
  WHEN 'ALLAHABAD'   THEN 'Prayagraj'
  WHEN 'VIZAG'       THEN 'Visakhapatnam'
  WHEN 'PONDICHERRY' THEN 'Puducherry'
  WHEN 'BARODA'      THEN 'Vadodara'
  WHEN 'HUBLI'       THEN 'Dharwad'
  ELSE address_city
END AS address_city
```

## Note on `Andhra Pradesh` / `Telangana`

Facilities in Telangana that carry `"Andhra Pradesh"` in `address_stateOrRegion` are handled separately in `non-standard-state-names.md`. The city names for those facilities are not affected by this fix.
