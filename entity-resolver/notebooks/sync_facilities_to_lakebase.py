# Databricks notebook source

# MAGIC %md
# MAGIC # Copy Facilities + India Post Pincode Directory → Lakebase (one-time)
# MAGIC
# MAGIC Syncs two tables into Lakebase Postgres:
# MAGIC   1. `workspace.default.facilities` (cleaned by master.sql) → `virtue_foundation_dataset.facilities`
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
LAKEBASE_USER     = "sawyer@enrollhere.com"
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

# MAGIC %md ### Step 1 — Read source (pre-cleaned by master.sql)

# COMMAND ----------

facilities_df = spark.table("workspace.default.facilities")
print(f"facilities source rows: {facilities_df.count()}")

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
cur.execute(f"DROP TABLE IF EXISTS {TARGET_SCHEMA}.facilities_raw")  # idempotent: drop old facilities_raw if exists
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
