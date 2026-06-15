-- =============================================================================
-- facilities: Clean Copy
-- Target: workspace.default.facilities
-- Source: databricks_virtue_foundation_dataset_dais_2026.virtue_foundation_dataset.facilities
--
-- Fixes applied (each tied to a .md file in this directory):
--   1. duplicate-unique-ids.md         — deduplicate fully identical rows via ROW_NUMBER()
--   2. invalid-unique-id-format.md     — filter out 88 rows where unique_id is not a valid UUID
--   3. null-as-string.md               — replace literal 'null' strings with proper SQL NULL (38 columns)
--                                        also replace empty array strings '[]' and '[""]' with NULL
--   4. duplicate-array-column-entries.md — deduplicate entries within JSON array string columns
--   5. farmacy-typo.md                 — normalize 'farmacy' → 'pharmacy' in facilityTypeId (10 rows)
--   6. redundant-coordinates-column.md — drop coordinates (fully redundant with latitude/longitude)
--   7. non-standard-city-names.md      — normalize 16 colloquial/legacy city names to official
--                                        India Post district names in address_city (799 rows)
--   8. non-standard-state-names.md     — normalize 10 abbreviated/pre-rename state names to
--                                        official India Post statenames in address_stateOrRegion (103 rows)
-- =============================================================================

CREATE OR REPLACE TABLE workspace.default.facilities AS

-- Fix #1 (duplicate-unique-ids.md): Remove 11 fully identical duplicate rows
WITH deduped AS (
  SELECT * EXCEPT (rn)
  FROM (
    SELECT *,
           ROW_NUMBER() OVER (PARTITION BY unique_id ORDER BY unique_id) AS rn
    FROM databricks_virtue_foundation_dataset_dais_2026.virtue_foundation_dataset.facilities
  )
  WHERE rn = 1
),

-- Fix #2 (invalid-unique-id-format.md): Drop 88 rows where unique_id contains
-- scraped description text instead of a valid lowercase UUID v4
valid_ids AS (
  SELECT *
  FROM deduped
  WHERE unique_id RLIKE '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
),

-- Fix #3 (null-as-string.md): Normalize literal 'null' strings to proper SQL NULL
-- across all 38 affected columns. Array-backed string columns also have '[]' and
-- '[""]' (empty array strings) normalized to NULL. Non-affected columns passed through as-is.
null_fixed AS (
  SELECT
    unique_id,
    NULLIF(NULLIF(NULLIF(source_types,       'null'), '[]'), '[""]') AS source_types,
    NULLIF(NULLIF(NULLIF(source_ids,         'null'), '[]'), '[""]') AS source_ids,
    NULLIF(source_content_id,                               'null') AS source_content_id,
    NULLIF(name,                                            'null') AS name,
    NULLIF(organization_type,                               'null') AS organization_type,
    NULLIF(content_table_id,                                'null') AS content_table_id,
    NULLIF(NULLIF(NULLIF(phone_numbers,      'null'), '[]'), '[""]') AS phone_numbers,
    NULLIF(officialPhone,                                   'null') AS officialPhone,
    NULLIF(email,                                           'null') AS email,
    NULLIF(NULLIF(NULLIF(websites,           'null'), '[]'), '[""]') AS websites,
    NULLIF(officialWebsite,                                 'null') AS officialWebsite,
    NULLIF(yearEstablished,                                 'null') AS yearEstablished,
    NULLIF(acceptsVolunteers,                               'null') AS acceptsVolunteers,
    NULLIF(facebookLink,                                    'null') AS facebookLink,
    NULLIF(address_line1,                                   'null') AS address_line1,
    NULLIF(address_line2,                                   'null') AS address_line2,
    NULLIF(address_line3,                                   'null') AS address_line3,
    NULLIF(address_city,                                    'null') AS address_city,
    NULLIF(address_stateOrRegion,                           'null') AS address_stateOrRegion,
    NULLIF(address_zipOrPostcode,                           'null') AS address_zipOrPostcode,
    NULLIF(address_country,                                 'null') AS address_country,
    NULLIF(address_countryCode,                             'null') AS address_countryCode,
    NULLIF(NULLIF(NULLIF(countries,          'null'), '[]'), '[""]') AS countries,
    NULLIF(facilityTypeId,                                  'null') AS facilityTypeId,
    NULLIF(operatorTypeId,                                  'null') AS operatorTypeId,
    NULLIF(NULLIF(NULLIF(affiliationTypeIds, 'null'), '[]'), '[""]') AS affiliationTypeIds,
    NULLIF(description,                                     'null') AS description,
    NULLIF(area,                                            'null') AS area,
    NULLIF(numberDoctors,                                   'null') AS numberDoctors,
    NULLIF(capacity,                                        'null') AS capacity,
    NULLIF(NULLIF(NULLIF(specialties,        'null'), '[]'), '[""]') AS specialties,
    NULLIF(NULLIF(NULLIF(procedure,          'null'), '[]'), '[""]') AS procedure,
    NULLIF(NULLIF(NULLIF(equipment,          'null'), '[]'), '[""]') AS equipment,
    NULLIF(NULLIF(NULLIF(capability,         'null'), '[]'), '[""]') AS capability,
    NULLIF(recency_of_page_update,                          'null') AS recency_of_page_update,
    NULLIF(distinct_social_media_presence_count,            'null') AS distinct_social_media_presence_count,
    NULLIF(affiliated_staff_presence,                       'null') AS affiliated_staff_presence,
    NULLIF(custom_logo_presence,                            'null') AS custom_logo_presence,
    NULLIF(number_of_facts_about_the_organization,          'null') AS number_of_facts_about_the_organization,
    NULLIF(post_metrics_most_recent_social_media_post_date, 'null') AS post_metrics_most_recent_social_media_post_date,
    NULLIF(post_metrics_post_count,                         'null') AS post_metrics_post_count,
    NULLIF(engagement_metrics_n_followers,                  'null') AS engagement_metrics_n_followers,
    NULLIF(engagement_metrics_n_likes,                      'null') AS engagement_metrics_n_likes,
    NULLIF(engagement_metrics_n_engagements,                'null') AS engagement_metrics_n_engagements,
    source,
    latitude,
    longitude,
    cluster_id,
    NULLIF(NULLIF(NULLIF(source_urls,        'null'), '[]'), '[""]') AS source_urls
  FROM valid_ids
)

-- Fix #4 (duplicate-array-column-entries.md): Deduplicate entries within JSON
-- array string columns by parsing → filter out '' elements → array_distinct() → re-serializing to JSON.
-- NULL values are passed through unchanged. Arrays that become empty after filtering are set to NULL.

-- Fix #5 (farmacy-typo.md): Normalize 'farmacy' → 'pharmacy' in facilityTypeId (10 rows)

-- Fix #7 (non-standard-city-names.md): Normalize 16 colloquial/legacy/renamed city names
-- to their official India Post district names in address_city (799 rows).
-- Fix #8 (non-standard-state-names.md): Normalize 10 abbreviated/pre-rename state names
-- to official India Post statenames in address_stateOrRegion (103 rows).
SELECT
  unique_id,
  NULLIF(to_json(array_distinct(filter(from_json(source_types,      'array<string>'), x -> x != ''))), '[]') AS source_types,
  NULLIF(to_json(array_distinct(filter(from_json(source_ids,        'array<string>'), x -> x != ''))), '[]') AS source_ids,
  source_content_id,
  name,
  organization_type,
  content_table_id,
  NULLIF(to_json(array_distinct(filter(from_json(phone_numbers,     'array<string>'), x -> x != ''))), '[]') AS phone_numbers,
  officialPhone,
  email,
  NULLIF(to_json(array_distinct(filter(from_json(websites,          'array<string>'), x -> x != ''))), '[]') AS websites,
  officialWebsite,
  yearEstablished,
  acceptsVolunteers,
  facebookLink,
  address_line1,
  address_line2,
  address_line3,
  -- Fix #7: normalize colloquial/legacy/renamed city names to official India Post district names
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
  END AS address_city,
  -- Fix #8: normalize abbreviated/pre-rename state names to official India Post statenames
  -- Note: 'Andhra Pradesh' → 'Telangana' is intentionally excluded (manual review required)
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
  END AS address_stateOrRegion,
  address_zipOrPostcode,
  address_country,
  address_countryCode,
  NULLIF(to_json(array_distinct(filter(from_json(countries,         'array<string>'), x -> x != ''))), '[]') AS countries,
  CASE WHEN facilityTypeId = 'farmacy' THEN 'pharmacy' ELSE facilityTypeId END AS facilityTypeId,
  operatorTypeId,
  NULLIF(to_json(array_distinct(filter(from_json(affiliationTypeIds, 'array<string>'), x -> x != ''))), '[]') AS affiliationTypeIds,
  description,
  area,
  numberDoctors,
  capacity,
  NULLIF(to_json(array_distinct(filter(from_json(specialties,       'array<string>'), x -> x != ''))), '[]') AS specialties,
  NULLIF(to_json(array_distinct(filter(from_json(procedure,         'array<string>'), x -> x != ''))), '[]') AS procedure,
  NULLIF(to_json(array_distinct(filter(from_json(equipment,         'array<string>'), x -> x != ''))), '[]') AS equipment,
  NULLIF(to_json(array_distinct(filter(from_json(capability,        'array<string>'), x -> x != ''))), '[]') AS capability,
  recency_of_page_update,
  distinct_social_media_presence_count,
  affiliated_staff_presence,
  custom_logo_presence,
  number_of_facts_about_the_organization,
  post_metrics_most_recent_social_media_post_date,
  post_metrics_post_count,
  engagement_metrics_n_followers,
  engagement_metrics_n_likes,
  engagement_metrics_n_engagements,
  source,
  -- coordinates column dropped (Fix #6): fully redundant with latitude and longitude
  latitude,
  longitude,
  cluster_id,
  NULLIF(to_json(array_distinct(filter(from_json(source_urls,       'array<string>'), x -> x != ''))), '[]') AS source_urls
FROM null_fixed;
