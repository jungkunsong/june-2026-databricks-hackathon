# `"null"` String Values Across Columns in `facilities` Table

## Summary

Many columns in the `facilities` table contain the literal string `"null"` instead of a proper SQL `NULL`. This means standard null-checks (`IS NULL`, `IS NOT NULL`, `COALESCE`) will silently treat these fields as populated, leading to incorrect filtering, aggregations, and downstream logic.

- **Table**: `databricks_virtue_foundation_dataset_dais_2026.virtue_foundation_dataset.facilities`
- **Total facilities**: 10,088
- **Columns affected**: 38 out of 48 string columns

## Breakdown by Column

Columns with zero `'null'` string occurrences are omitted.

| column | `'null'` string rows | true `NULL` rows |
|---|---:|---:|
| `engagement_metrics_n_likes` | 2,170 | 117 |
| `engagement_metrics_n_followers` | 2,165 | 117 |
| `engagement_metrics_n_engagements` | 5,083 | 117 |
| `post_metrics_post_count` | 2,165 | 117 |
| `post_metrics_most_recent_social_media_post_date` | 2,165 | 117 |
| `number_of_facts_about_the_organization` | 2,165 | 117 |
| `custom_logo_presence` | 2,165 | 117 |
| `affiliated_staff_presence` | 2,165 | 117 |
| `distinct_social_media_presence_count` | 2,165 | 117 |
| `recency_of_page_update` | 2,165 | 117 |
| `capacity` | 1,996 | 117 |
| `numberDoctors` | 1,996 | 117 |
| `area` | 1,996 | 117 |
| `description` | 1,996 | 117 |
| `affiliationTypeIds` | 1,996 | 117 |
| `operatorTypeId` | 1,996 | 117 |
| `facilityTypeId` | 1,996 | 117 |
| `countries` | 1,996 | 117 |
| `address_countryCode` | 1,996 | 117 |
| `address_country` | 1,996 | 117 |
| `address_zipOrPostcode` | 1,996 | 117 |
| `address_stateOrRegion` | 1,996 | 117 |
| `address_city` | 1,996 | 117 |
| `address_line3` | 1,996 | 117 |
| `address_line2` | 1,996 | 117 |
| `address_line1` | 1,996 | 117 |
| `facebookLink` | 1,996 | 117 |
| `acceptsVolunteers` | 1,996 | 117 |
| `yearEstablished` | 1,996 | 117 |
| `officialWebsite` | 1,996 | 117 |
| `email` | 1,996 | 117 |
| `officialPhone` | 1,996 | 117 |
| `phone_numbers` | 2 | 339 |
| `websites` | 61 | 0 |
| `source_content_id` | 18 | 51 |
| `source_ids` | 41 | 46 |
| `source_types` | 37 | 41 |
| `name` | 11 | 54 |
| `organization_type` | 7 | 54 |
| `content_table_id` | 5 | 57 |

The engagement/metrics and address columns are the most affected, with ~2,000–5,000 `'null'` string rows each — likely a single batch of ~2,000 facilities that were serialized with `"null"` instead of proper `NULL` at ingestion time.

## Detection Query

```sql
SELECT column_name, COUNT(*) AS null_string_rows
FROM (
    SELECT 'engagement_metrics_n_likes'                       AS column_name FROM databricks_virtue_foundation_dataset_dais_2026.virtue_foundation_dataset.facilities WHERE engagement_metrics_n_likes = 'null'
    UNION ALL SELECT 'engagement_metrics_n_followers'         FROM databricks_virtue_foundation_dataset_dais_2026.virtue_foundation_dataset.facilities WHERE engagement_metrics_n_followers = 'null'
    UNION ALL SELECT 'engagement_metrics_n_engagements'       FROM databricks_virtue_foundation_dataset_dais_2026.virtue_foundation_dataset.facilities WHERE engagement_metrics_n_engagements = 'null'
    UNION ALL SELECT 'post_metrics_post_count'                FROM databricks_virtue_foundation_dataset_dais_2026.virtue_foundation_dataset.facilities WHERE post_metrics_post_count = 'null'
    UNION ALL SELECT 'description'                            FROM databricks_virtue_foundation_dataset_dais_2026.virtue_foundation_dataset.facilities WHERE description = 'null'
    UNION ALL SELECT 'address_line1'                          FROM databricks_virtue_foundation_dataset_dais_2026.virtue_foundation_dataset.facilities WHERE address_line1 = 'null'
    UNION ALL SELECT 'address_city'                           FROM databricks_virtue_foundation_dataset_dais_2026.virtue_foundation_dataset.facilities WHERE address_city = 'null'
    -- add remaining columns as needed
)
GROUP BY column_name
ORDER BY null_string_rows DESC;
```

## Empty Array Strings

In addition to `'null'` strings, some array-typed columns contain empty array representations that should also be treated as `NULL`:

| Format | Example | Meaning |
|---|---|---|
| `'[]'` | `[]` | Empty JSON array — no values present |
| `'[""]'` | `[""]` | Array containing a single empty string — effectively empty |

These appear in the same array-backed string columns (`source_types`, `source_ids`, `phone_numbers`, `websites`, `countries`, `affiliationTypeIds`, `specialties`, `procedure`, `equipment`, `capability`, `source_urls`) and should be normalized to `NULL` alongside `'null'` strings.

## Root Cause

The ingestion pipeline serializes missing values as the string `"null"` (likely from JSON serialization of Python `None` or JavaScript `null`) rather than omitting the field or writing a proper SQL `NULL`. Empty arrays (`[]`) and single-empty-string arrays (`[""]`) stem from the same serialization path when a list field is present but empty.

## Recommended Fix

Normalize at read time using `NULLIF` and a `CASE` expression for empty arrays:

```sql
SELECT
    -- Scalar columns: replace 'null' string with proper NULL
    NULLIF(name, 'null')                                             AS name,
    NULLIF(description, 'null')                                      AS description,
    NULLIF(address_line1, 'null')                                    AS address_line1,
    NULLIF(address_line2, 'null')                                    AS address_line2,
    NULLIF(address_line3, 'null')                                    AS address_line3,
    NULLIF(address_city, 'null')                                     AS address_city,
    NULLIF(address_stateOrRegion, 'null')                            AS address_stateOrRegion,
    NULLIF(address_zipOrPostcode, 'null')                            AS address_zipOrPostcode,
    NULLIF(address_country, 'null')                                  AS address_country,
    NULLIF(address_countryCode, 'null')                              AS address_countryCode,
    NULLIF(officialPhone, 'null')                                    AS officialPhone,
    NULLIF(email, 'null')                                            AS email,
    NULLIF(officialWebsite, 'null')                                  AS officialWebsite,
    NULLIF(facebookLink, 'null')                                     AS facebookLink,
    NULLIF(yearEstablished, 'null')                                  AS yearEstablished,
    NULLIF(acceptsVolunteers, 'null')                                AS acceptsVolunteers,
    NULLIF(facilityTypeId, 'null')                                   AS facilityTypeId,
    NULLIF(operatorTypeId, 'null')                                   AS operatorTypeId,
    NULLIF(area, 'null')                                             AS area,
    NULLIF(numberDoctors, 'null')                                    AS numberDoctors,
    NULLIF(capacity, 'null')                                         AS capacity,
    NULLIF(recency_of_page_update, 'null')                           AS recency_of_page_update,
    NULLIF(distinct_social_media_presence_count, 'null')             AS distinct_social_media_presence_count,
    NULLIF(affiliated_staff_presence, 'null')                        AS affiliated_staff_presence,
    NULLIF(custom_logo_presence, 'null')                             AS custom_logo_presence,
    NULLIF(number_of_facts_about_the_organization, 'null')           AS number_of_facts_about_the_organization,
    NULLIF(post_metrics_most_recent_social_media_post_date, 'null')  AS post_metrics_most_recent_social_media_post_date,
    NULLIF(post_metrics_post_count, 'null')                          AS post_metrics_post_count,
    NULLIF(engagement_metrics_n_followers, 'null')                   AS engagement_metrics_n_followers,
    NULLIF(engagement_metrics_n_likes, 'null')                       AS engagement_metrics_n_likes,
    NULLIF(engagement_metrics_n_engagements, 'null')                 AS engagement_metrics_n_engagements,
    NULLIF(source_content_id, 'null')                                AS source_content_id,
    NULLIF(organization_type, 'null')                                AS organization_type,
    NULLIF(content_table_id, 'null')                                 AS content_table_id,
    -- Array-backed string columns: also null out '[]' and '[""]'
    NULLIF(NULLIF(NULLIF(source_types,       'null'), '[]'), '[""]') AS source_types,
    NULLIF(NULLIF(NULLIF(source_ids,         'null'), '[]'), '[""]') AS source_ids,
    NULLIF(NULLIF(NULLIF(phone_numbers,      'null'), '[]'), '[""]') AS phone_numbers,
    NULLIF(NULLIF(NULLIF(websites,           'null'), '[]'), '[""]') AS websites,
    NULLIF(NULLIF(NULLIF(countries,          'null'), '[]'), '[""]') AS countries,
    NULLIF(NULLIF(NULLIF(affiliationTypeIds, 'null'), '[]'), '[""]') AS affiliationTypeIds,
    NULLIF(NULLIF(NULLIF(specialties,        'null'), '[]'), '[""]') AS specialties,
    NULLIF(NULLIF(NULLIF(procedure,          'null'), '[]'), '[""]') AS procedure,
    NULLIF(NULLIF(NULLIF(equipment,          'null'), '[]'), '[""]') AS equipment,
    NULLIF(NULLIF(NULLIF(capability,         'null'), '[]'), '[""]') AS capability,
    NULLIF(NULLIF(NULLIF(source_urls,        'null'), '[]'), '[""]') AS source_urls
FROM databricks_virtue_foundation_dataset_dais_2026.virtue_foundation_dataset.facilities;
```

Longer term, fix the serialization at the pipeline level so missing values are never written as `'null'`, `'[]'`, or `'[""]'`.
