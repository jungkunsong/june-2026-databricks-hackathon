# Databricks notebook source

# MAGIC %md
# MAGIC # Copy Facilities + India Post Pincode Directory → Lakebase (one-time)
# MAGIC
# MAGIC Syncs two tables into Lakebase Postgres:
# MAGIC   1. `databricks_virtue_foundation_dataset_dais_2026.virtue_foundation_dataset.facilities` (cleaned inline via master.sql logic) → `virtue_foundation_dataset.facilities`
# MAGIC   2. `databricks_virtue_foundation_dataset_dais_2026.virtue_foundation_dataset.india_post_pincode_directory` → `virtue_foundation_dataset.india_post_pincode_directory`
# MAGIC
# MAGIC Idempotent: drops and recreates each target table on each run.
# MAGIC
# MAGIC Uses the native `postgresql` datasource (supported on serverless compute)
# MAGIC rather than the generic JDBC driver.

# COMMAND ----------

import requests

LAKEBASE_HOST     = "ep-royal-star-d8a89byj.database.us-east-2.cloud.databricks.com"
LAKEBASE_PORT     = 5432
LAKEBASE_DB       = "databricks_postgres"
LAKEBASE_USER     = "jksong@enrollhere.com"
LAKEBASE_ENDPOINT = "projects/entity-resolution/branches/production/endpoints/primary"
DATABRICKS_HOST   = "https://dbc-6806e9e0-845a.cloud.databricks.com"
SP_APP_ID         = "4b31d812-e085-4472-9efa-c5b6ffef764d"

TARGET_SCHEMA = "virtue_foundation_dataset"

# ── Obtain a Lakebase-scoped JWT ─────────────────────────────────────────────
PAT = dbutils.notebook.entry_point.getDbutils().notebook().getContext().apiToken().get()

cred_resp = requests.post(
    f"{DATABRICKS_HOST}/api/2.0/postgres/credentials",
    headers={"Authorization": f"Bearer {PAT}", "Content-Type": "application/json"},
    json={"endpoint": LAKEBASE_ENDPOINT},
)
cred_resp.raise_for_status()
LAKEBASE_TOKEN = cred_resp.json()["token"]
print("Lakebase JWT obtained.")

# COMMAND ----------

# MAGIC %md ## Table 1: facilities

# COMMAND ----------

# MAGIC %md ### Step 1 — Clean raw source inline (master.sql logic)

# COMMAND ----------

# Applies all deterministic fixes from known-data-quality-issues/master.sql directly
# against the raw source table. No intermediate workspace table required.
facilities_df = spark.sql("""
WITH deduped AS (
  SELECT * EXCEPT (rn)
  FROM (
    SELECT *,
           ROW_NUMBER() OVER (PARTITION BY unique_id ORDER BY unique_id) AS rn
    FROM databricks_virtue_foundation_dataset_dais_2026.virtue_foundation_dataset.facilities
  )
  WHERE rn = 1
),

valid_ids AS (
  SELECT *
  FROM deduped
  WHERE unique_id RLIKE '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
),

null_fixed AS (
  SELECT
    unique_id,
    CASE WHEN regexp_replace(source_types,       '\x00', '')  IN ('null', '[]', '[""]') THEN '' ELSE regexp_replace(source_types,       '\x00', '')  END AS source_types,
    CASE WHEN regexp_replace(source_ids,         '\x00', '')  IN ('null', '[]', '[""]') THEN '' ELSE regexp_replace(source_ids,         '\x00', '')  END AS source_ids,
    REPLACE(regexp_replace(source_content_id,                               '\x00', ''), 'null', '') AS source_content_id,
    REPLACE(regexp_replace(name,                                             '\x00', ''), 'null', '') AS name,
    REPLACE(regexp_replace(organization_type,                                '\x00', ''), 'null', '') AS organization_type,
    REPLACE(regexp_replace(content_table_id,                                 '\x00', ''), 'null', '') AS content_table_id,
    CASE WHEN regexp_replace(phone_numbers,      '\x00', '')  IN ('null', '[]', '[""]') THEN '' ELSE regexp_replace(phone_numbers,      '\x00', '')  END AS phone_numbers,
    REPLACE(regexp_replace(officialPhone,                                    '\x00', ''), 'null', '') AS officialPhone,
    REPLACE(regexp_replace(email,                                            '\x00', ''), 'null', '') AS email,
    CASE WHEN regexp_replace(websites,           '\x00', '')  IN ('null', '[]', '[""]') THEN '' ELSE regexp_replace(websites,           '\x00', '')  END AS websites,
    REPLACE(regexp_replace(officialWebsite,                                  '\x00', ''), 'null', '') AS officialWebsite,
    REPLACE(regexp_replace(yearEstablished,                                  '\x00', ''), 'null', '') AS yearEstablished,
    REPLACE(regexp_replace(acceptsVolunteers,                                '\x00', ''), 'null', '') AS acceptsVolunteers,
    REPLACE(regexp_replace(facebookLink,                                     '\x00', ''), 'null', '') AS facebookLink,
    REPLACE(regexp_replace(address_line1,                                    '\x00', ''), 'null', '') AS address_line1,
    REPLACE(regexp_replace(address_line2,                                    '\x00', ''), 'null', '') AS address_line2,
    REPLACE(regexp_replace(address_line3,                                    '\x00', ''), 'null', '') AS address_line3,
    REPLACE(regexp_replace(address_city,                                     '\x00', ''), 'null', '') AS address_city,
    REPLACE(regexp_replace(address_stateOrRegion,                            '\x00', ''), 'null', '') AS address_stateOrRegion,
    REPLACE(regexp_replace(address_zipOrPostcode,                            '\x00', ''), 'null', '') AS address_zipOrPostcode,
    REPLACE(regexp_replace(address_country,                                  '\x00', ''), 'null', '') AS address_country,
    REPLACE(regexp_replace(address_countryCode,                              '\x00', ''), 'null', '') AS address_countryCode,
    CASE WHEN regexp_replace(countries,          '\x00', '')  IN ('null', '[]', '[""]') THEN '' ELSE regexp_replace(countries,          '\x00', '')  END AS countries,
    REPLACE(regexp_replace(facilityTypeId,                                   '\x00', ''), 'null', '') AS facilityTypeId,
    REPLACE(regexp_replace(operatorTypeId,                                   '\x00', ''), 'null', '') AS operatorTypeId,
    CASE WHEN regexp_replace(affiliationTypeIds, '\x00', '')  IN ('null', '[]', '[""]') THEN '' ELSE regexp_replace(affiliationTypeIds, '\x00', '')  END AS affiliationTypeIds,
    REPLACE(regexp_replace(description,                                      '\x00', ''), 'null', '') AS description,
    REPLACE(regexp_replace(area,                                             '\x00', ''), 'null', '') AS area,
    REPLACE(regexp_replace(numberDoctors,                                    '\x00', ''), 'null', '') AS numberDoctors,
    REPLACE(regexp_replace(capacity,                                         '\x00', ''), 'null', '') AS capacity,
    CASE WHEN regexp_replace(specialties,        '\x00', '')  IN ('null', '[]', '[""]') THEN '' ELSE regexp_replace(specialties,        '\x00', '')  END AS specialties,
    CASE WHEN regexp_replace(procedure,          '\x00', '')  IN ('null', '[]', '[""]') THEN '' ELSE regexp_replace(procedure,          '\x00', '')  END AS procedure,
    CASE WHEN regexp_replace(equipment,          '\x00', '')  IN ('null', '[]', '[""]') THEN '' ELSE regexp_replace(equipment,          '\x00', '')  END AS equipment,
    CASE WHEN regexp_replace(capability,         '\x00', '')  IN ('null', '[]', '[""]') THEN '' ELSE regexp_replace(capability,         '\x00', '')  END AS capability,
    REPLACE(regexp_replace(recency_of_page_update,                           '\x00', ''), 'null', '') AS recency_of_page_update,
    REPLACE(regexp_replace(distinct_social_media_presence_count,             '\x00', ''), 'null', '') AS distinct_social_media_presence_count,
    REPLACE(regexp_replace(affiliated_staff_presence,                        '\x00', ''), 'null', '') AS affiliated_staff_presence,
    REPLACE(regexp_replace(custom_logo_presence,                             '\x00', ''), 'null', '') AS custom_logo_presence,
    REPLACE(regexp_replace(number_of_facts_about_the_organization,           '\x00', ''), 'null', '') AS number_of_facts_about_the_organization,
    REPLACE(regexp_replace(post_metrics_most_recent_social_media_post_date,  '\x00', ''), 'null', '') AS post_metrics_most_recent_social_media_post_date,
    REPLACE(regexp_replace(post_metrics_post_count,                          '\x00', ''), 'null', '') AS post_metrics_post_count,
    REPLACE(regexp_replace(engagement_metrics_n_followers,                   '\x00', ''), 'null', '') AS engagement_metrics_n_followers,
    REPLACE(regexp_replace(engagement_metrics_n_likes,                       '\x00', ''), 'null', '') AS engagement_metrics_n_likes,
    REPLACE(regexp_replace(engagement_metrics_n_engagements,                 '\x00', ''), 'null', '') AS engagement_metrics_n_engagements,
    regexp_replace(source,                                                   '\x00', '') AS source,
    latitude,
    longitude,
    cluster_id,
    CASE WHEN regexp_replace(source_urls,        '\x00', '')  IN ('null', '[]', '[""]') THEN '' ELSE regexp_replace(source_urls,        '\x00', '')  END AS source_urls
  FROM valid_ids
)

SELECT
  unique_id,
  CASE WHEN to_json(array_distinct(filter(from_json(source_types,      'array<string>'), x -> x IS NOT NULL AND x != ''))) = '[]' THEN '' ELSE to_json(array_distinct(filter(from_json(source_types,      'array<string>'), x -> x IS NOT NULL AND x != ''))) END AS source_types,
  CASE WHEN to_json(array_distinct(filter(from_json(source_ids,        'array<string>'), x -> x IS NOT NULL AND x != ''))) = '[]' THEN '' ELSE to_json(array_distinct(filter(from_json(source_ids,        'array<string>'), x -> x IS NOT NULL AND x != ''))) END AS source_ids,
  source_content_id,
  name,
  organization_type,
  content_table_id,
  CASE WHEN to_json(array_distinct(filter(from_json(phone_numbers,     'array<string>'), x -> x IS NOT NULL AND x != ''))) = '[]' THEN '' ELSE to_json(array_distinct(filter(from_json(phone_numbers,     'array<string>'), x -> x IS NOT NULL AND x != ''))) END AS phone_numbers,
  officialPhone,
  email,
  CASE WHEN to_json(array_distinct(filter(from_json(websites,          'array<string>'), x -> x IS NOT NULL AND x != ''))) = '[]' THEN '' ELSE to_json(array_distinct(filter(from_json(websites,          'array<string>'), x -> x IS NOT NULL AND x != ''))) END AS websites,
  officialWebsite,
  yearEstablished,
  acceptsVolunteers,
  facebookLink,
  address_line1,
  address_line2,
  address_line3,
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
  CASE WHEN to_json(array_distinct(filter(from_json(countries,         'array<string>'), x -> x IS NOT NULL AND x != ''))) = '[]' THEN '' ELSE to_json(array_distinct(filter(from_json(countries,         'array<string>'), x -> x IS NOT NULL AND x != ''))) END AS countries,
  CASE WHEN facilityTypeId = 'farmacy' THEN 'pharmacy' ELSE facilityTypeId END AS facilityTypeId,
  operatorTypeId,
  CASE WHEN to_json(array_distinct(filter(from_json(affiliationTypeIds, 'array<string>'), x -> x IS NOT NULL AND x != ''))) = '[]' THEN '' ELSE to_json(array_distinct(filter(from_json(affiliationTypeIds, 'array<string>'), x -> x IS NOT NULL AND x != ''))) END AS affiliationTypeIds,
  description,
  area,
  numberDoctors,
  capacity,
  CASE WHEN to_json(array_distinct(filter(from_json(specialties,       'array<string>'), x -> x IS NOT NULL AND x != ''))) = '[]' THEN '' ELSE to_json(array_distinct(filter(from_json(specialties,       'array<string>'), x -> x IS NOT NULL AND x != ''))) END AS specialties,
  CASE WHEN to_json(array_distinct(filter(from_json(procedure,         'array<string>'), x -> x IS NOT NULL AND x != ''))) = '[]' THEN '' ELSE to_json(array_distinct(filter(from_json(procedure,         'array<string>'), x -> x IS NOT NULL AND x != ''))) END AS procedure,
  CASE WHEN to_json(array_distinct(filter(from_json(equipment,         'array<string>'), x -> x IS NOT NULL AND x != ''))) = '[]' THEN '' ELSE to_json(array_distinct(filter(from_json(equipment,         'array<string>'), x -> x IS NOT NULL AND x != ''))) END AS equipment,
  CASE WHEN to_json(array_distinct(filter(from_json(capability,        'array<string>'), x -> x IS NOT NULL AND x != ''))) = '[]' THEN '' ELSE to_json(array_distinct(filter(from_json(capability,        'array<string>'), x -> x IS NOT NULL AND x != ''))) END AS capability,
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
  latitude,
  longitude,
  cluster_id,
  CASE WHEN to_json(array_distinct(filter(from_json(source_urls,       'array<string>'), x -> x IS NOT NULL AND x != ''))) = '[]' THEN '' ELSE to_json(array_distinct(filter(from_json(source_urls,       'array<string>'), x -> x IS NOT NULL AND x != ''))) END AS source_urls
FROM null_fixed
""")
print(f"facilities cleaned rows: {facilities_df.count()}")

# COMMAND ----------

# MAGIC %md ### Step 2 — Create target schema and table via psycopg2

# COMMAND ----------

import psycopg2

conn = psycopg2.connect(
    host=LAKEBASE_HOST, port=LAKEBASE_PORT,
    dbname=LAKEBASE_DB, user=LAKEBASE_USER,
    password=LAKEBASE_TOKEN, sslmode="require",
)
conn.autocommit = True
cur = conn.cursor()

cur.execute(f"CREATE SCHEMA IF NOT EXISTS {TARGET_SCHEMA}")
cur.execute(f"DROP TABLE IF EXISTS {TARGET_SCHEMA}.facilities")      # idempotent: drop old facilities if exists
cur.execute(f"""
CREATE TABLE {TARGET_SCHEMA}.facilities (
    row_id                                          SERIAL PRIMARY KEY,
    unique_id                                       TEXT,
    source_types                                    TEXT,
    source_ids                                      TEXT,
    source_content_id                               TEXT,
    name                                            TEXT,
    organization_type                               TEXT,
    content_table_id                                TEXT,
    phone_numbers                                   TEXT,
    "officialPhone"                                 TEXT,
    email                                           TEXT,
    websites                                        TEXT,
    "officialWebsite"                               TEXT,
    "yearEstablished"                               TEXT,
    "acceptsVolunteers"                             TEXT,
    "facebookLink"                                  TEXT,
    address_line1                                   TEXT,
    address_line2                                   TEXT,
    address_line3                                   TEXT,
    address_city                                    TEXT,
    "address_stateOrRegion"                         TEXT,
    "address_zipOrPostcode"                         TEXT,
    address_country                                 TEXT,
    "address_countryCode"                           TEXT,
    countries                                       TEXT,
    "facilityTypeId"                                TEXT,
    "operatorTypeId"                                TEXT,
    "affiliationTypeIds"                            TEXT,
    description                                     TEXT,
    area                                            TEXT,
    "numberDoctors"                                 TEXT,
    capacity                                        TEXT,
    specialties                                     TEXT,
    procedure                                       TEXT,
    equipment                                       TEXT,
    capability                                      TEXT,
    recency_of_page_update                          TEXT,
    distinct_social_media_presence_count            TEXT,
    affiliated_staff_presence                       TEXT,
    custom_logo_presence                            TEXT,
    number_of_facts_about_the_organization          TEXT,
    post_metrics_most_recent_social_media_post_date TEXT,
    post_metrics_post_count                         TEXT,
    engagement_metrics_n_followers                  TEXT,
    engagement_metrics_n_likes                      TEXT,
    engagement_metrics_n_engagements                TEXT,
    source                                          TEXT,
    -- coordinates column removed (redundant with latitude/longitude per Fix #6 in master.sql)
    latitude                                        DOUBLE PRECISION,
    longitude                                       DOUBLE PRECISION,
    cluster_id                                      TEXT,
    source_urls                                     TEXT
)
""")

cur.execute(f'GRANT USAGE ON SCHEMA {TARGET_SCHEMA} TO "{SP_APP_ID}"')
cur.execute(f'GRANT SELECT ON {TARGET_SCHEMA}.facilities TO "{SP_APP_ID}"')

cur.close()
conn.close()
print("facilities table created, grants applied.")

# COMMAND ----------

# MAGIC %md ### Step 3 — Bulk load via native postgresql datasource

# COMMAND ----------

(
    facilities_df.write
    .format("postgresql")
    .option("host", LAKEBASE_HOST)
    .option("port", str(LAKEBASE_PORT))
    .option("database", LAKEBASE_DB)
    .option("dbtable", f"{TARGET_SCHEMA}.facilities")
    .option("user", LAKEBASE_USER)
    .option("password", LAKEBASE_TOKEN)
    .mode("append")
    .save()
)
print("facilities load complete.")

# COMMAND ----------

# MAGIC %md ### Step 4 — Verify

# COMMAND ----------

conn2 = psycopg2.connect(
    host=LAKEBASE_HOST, port=LAKEBASE_PORT,
    dbname=LAKEBASE_DB, user=LAKEBASE_USER,
    password=LAKEBASE_TOKEN, sslmode="require",
)
cur2 = conn2.cursor()
cur2.execute(f"SELECT COUNT(*) FROM {TARGET_SCHEMA}.facilities")
pg_count = cur2.fetchone()[0]
cur2.close()
conn2.close()

source_count = facilities_df.count()
print(f"facilities — Source: {source_count}  |  Postgres: {pg_count}")
assert pg_count == source_count, f"Mismatch! source={source_count} pg={pg_count}"
print("facilities verified OK.")

# COMMAND ----------

# MAGIC %md ## Table 2: india_post_pincode_directory

# COMMAND ----------

# MAGIC %md ### Step 1 — Read source

# COMMAND ----------

pincode_df = spark.table("databricks_virtue_foundation_dataset_dais_2026.virtue_foundation_dataset.india_post_pincode_directory")
print(f"india_post_pincode_directory source rows: {pincode_df.count()}")

# COMMAND ----------

# MAGIC %md ### Step 2 — Create target table via psycopg2

# COMMAND ----------

conn3 = psycopg2.connect(
    host=LAKEBASE_HOST, port=LAKEBASE_PORT,
    dbname=LAKEBASE_DB, user=LAKEBASE_USER,
    password=LAKEBASE_TOKEN, sslmode="require",
)
conn3.autocommit = True
cur3 = conn3.cursor()

cur3.execute(f"DROP TABLE IF EXISTS {TARGET_SCHEMA}.india_post_pincode_directory")
cur3.execute(f"""
CREATE TABLE {TARGET_SCHEMA}.india_post_pincode_directory (
    circlename   TEXT,
    regionname   TEXT,
    divisionname TEXT,
    officename   TEXT,
    pincode      BIGINT,
    officetype   TEXT,
    delivery     TEXT,
    district     TEXT,
    statename    TEXT,
    latitude     TEXT,
    longitude    TEXT
)
""")

cur3.execute(f'GRANT SELECT ON {TARGET_SCHEMA}.india_post_pincode_directory TO "{SP_APP_ID}"')

cur3.close()
conn3.close()
print("india_post_pincode_directory table created, grants applied.")

# COMMAND ----------

# MAGIC %md ### Step 3 — Bulk load via native postgresql datasource

# COMMAND ----------

(
    pincode_df.write
    .format("postgresql")
    .option("host", LAKEBASE_HOST)
    .option("port", str(LAKEBASE_PORT))
    .option("database", LAKEBASE_DB)
    .option("dbtable", f"{TARGET_SCHEMA}.india_post_pincode_directory")
    .option("user", LAKEBASE_USER)
    .option("password", LAKEBASE_TOKEN)
    .mode("append")
    .save()
)
print("india_post_pincode_directory load complete.")

# COMMAND ----------

# MAGIC %md ### Step 4 — Verify

# COMMAND ----------

conn4 = psycopg2.connect(
    host=LAKEBASE_HOST, port=LAKEBASE_PORT,
    dbname=LAKEBASE_DB, user=LAKEBASE_USER,
    password=LAKEBASE_TOKEN, sslmode="require",
)
cur4 = conn4.cursor()
cur4.execute(f"SELECT COUNT(*) FROM {TARGET_SCHEMA}.india_post_pincode_directory")
pg_count2 = cur4.fetchone()[0]
cur4.close()
conn4.close()

source_count2 = pincode_df.count()
print(f"india_post_pincode_directory — Source: {source_count2}  |  Postgres: {pg_count2}")
assert pg_count2 == source_count2, f"Mismatch! source={source_count2} pg={pg_count2}"
print("india_post_pincode_directory verified OK.")
