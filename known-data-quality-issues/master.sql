-- =============================================================================
-- facilities: Clean Copy
-- Target: workspace.default.facilities
-- Source: databricks_virtue_foundation_dataset_dais_2026.virtue_foundation_dataset.facilities
--
-- Fixes applied (each tied to a .md file in this directory):
--   1. duplicate-unique-ids.md       — deduplicate fully identical rows via ROW_NUMBER()
--   2. invalid-unique-id-format.md   — filter out 88 rows where unique_id is not a valid UUID
--   3. null-as-string.md             — replace literal 'null' strings with proper SQL NULL (38 columns)
--   4. duplicate-array-column-entries.md — deduplicate entries within JSON array string columns
--   5. farmacy-typo.md               — normalize 'farmacy' → 'pharmacy' in facilityTypeId (10 rows)
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
-- across all 38 affected columns. Columns not in the affected list are passed through as-is.
null_fixed AS (
  SELECT
    unique_id,
    NULLIF(source_types,                                    'null') AS source_types,
    NULLIF(source_ids,                                      'null') AS source_ids,
    NULLIF(source_content_id,                               'null') AS source_content_id,
    NULLIF(name,                                            'null') AS name,
    NULLIF(organization_type,                               'null') AS organization_type,
    NULLIF(content_table_id,                                'null') AS content_table_id,
    NULLIF(phone_numbers,                                   'null') AS phone_numbers,
    NULLIF(officialPhone,                                   'null') AS officialPhone,
    NULLIF(email,                                           'null') AS email,
    NULLIF(websites,                                        'null') AS websites,
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
    NULLIF(countries,                                       'null') AS countries,
    NULLIF(facilityTypeId,                                  'null') AS facilityTypeId,
    NULLIF(operatorTypeId,                                  'null') AS operatorTypeId,
    NULLIF(affiliationTypeIds,                              'null') AS affiliationTypeIds,
    NULLIF(description,                                     'null') AS description,
    NULLIF(area,                                            'null') AS area,
    NULLIF(numberDoctors,                                   'null') AS numberDoctors,
    NULLIF(capacity,                                        'null') AS capacity,
    specialties,   -- array column; 'null' handled in Fix #4 below
    procedure,     -- array column; 'null' handled in Fix #4 below
    equipment,     -- array column; 'null' handled in Fix #4 below
    capability,    -- array column; 'null' handled in Fix #4 below
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
    coordinates,
    latitude,
    longitude,
    cluster_id,
    NULLIF(source_urls,                                     'null') AS source_urls
  FROM valid_ids
)

-- Fix #4 (duplicate-array-column-entries.md): Deduplicate entries within JSON
-- array string columns by parsing → array_distinct() → re-serializing to JSON.
-- NULL and empty array '[]' values are passed through unchanged.

-- Fix #5 (farmacy-typo.md): Normalize 'farmacy' → 'pharmacy' in facilityTypeId (10 rows)
SELECT
  unique_id,
  CASE WHEN source_types      IS NULL OR source_types      = '[]' THEN source_types      ELSE to_json(array_distinct(from_json(source_types,      'array<string>'))) END AS source_types,
  CASE WHEN source_ids        IS NULL OR source_ids        = '[]' THEN source_ids        ELSE to_json(array_distinct(from_json(source_ids,        'array<string>'))) END AS source_ids,
  source_content_id,
  name,
  organization_type,
  content_table_id,
  CASE WHEN phone_numbers     IS NULL OR phone_numbers     = '[]' THEN phone_numbers     ELSE to_json(array_distinct(from_json(phone_numbers,     'array<string>'))) END AS phone_numbers,
  officialPhone,
  email,
  CASE WHEN websites          IS NULL OR websites          = '[]' THEN websites          ELSE to_json(array_distinct(from_json(websites,          'array<string>'))) END AS websites,
  officialWebsite,
  yearEstablished,
  acceptsVolunteers,
  facebookLink,
  address_line1,
  address_line2,
  address_line3,
  address_city,
  address_stateOrRegion,
  address_zipOrPostcode,
  address_country,
  address_countryCode,
  CASE WHEN countries         IS NULL OR countries         = '[]' THEN countries         ELSE to_json(array_distinct(from_json(countries,         'array<string>'))) END AS countries,
  CASE WHEN facilityTypeId = 'farmacy' THEN 'pharmacy' ELSE facilityTypeId END AS facilityTypeId,
  operatorTypeId,
  CASE WHEN affiliationTypeIds IS NULL OR affiliationTypeIds = '[]' THEN affiliationTypeIds ELSE to_json(array_distinct(from_json(affiliationTypeIds, 'array<string>'))) END AS affiliationTypeIds,
  description,
  area,
  numberDoctors,
  capacity,
  CASE WHEN specialties       IS NULL OR specialties       = '[]' THEN specialties       ELSE to_json(array_distinct(from_json(specialties,       'array<string>'))) END AS specialties,
  CASE WHEN procedure         IS NULL OR procedure         = '[]' THEN procedure         ELSE to_json(array_distinct(from_json(procedure,         'array<string>'))) END AS procedure,
  CASE WHEN equipment         IS NULL OR equipment         = '[]' THEN equipment         ELSE to_json(array_distinct(from_json(equipment,         'array<string>'))) END AS equipment,
  CASE WHEN capability        IS NULL OR capability        = '[]' THEN capability        ELSE to_json(array_distinct(from_json(capability,        'array<string>'))) END AS capability,
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
  coordinates,
  latitude,
  longitude,
  cluster_id,
  CASE WHEN source_urls       IS NULL OR source_urls       = '[]' THEN source_urls       ELSE to_json(array_distinct(from_json(source_urls,       'array<string>'))) END AS source_urls
FROM null_fixed;
