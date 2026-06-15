# Databricks notebook source

# MAGIC %md
# MAGIC # Copy Facilities → Lakebase (one-time)
# MAGIC
# MAGIC Reads the read-only Delta Share `facilities` table and bulk-loads it
# MAGIC into Lakebase Postgres as-is — no dedup, no transformation.
# MAGIC
# MAGIC Idempotent: drops and recreates the target table on each run.
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

SOURCE_TABLE  = "databricks_virtue_foundation_dataset_dais_2026.virtue_foundation_dataset.facilities"
TARGET_SCHEMA = "virtue_foundation_dataset"
TARGET_TABLE  = "facilities_raw"

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

# MAGIC %md ## Step 1 — Read source (raw, no changes)

# COMMAND ----------

df = spark.table(SOURCE_TABLE)
print(f"Source rows: {df.count()}")

# Strip null bytes (\x00) from all string columns — Postgres rejects them
from pyspark.sql import functions as F
from pyspark.sql.types import StringType

string_cols = [f.name for f in df.schema.fields if isinstance(f.dataType, StringType)]
for col in string_cols:
    df = df.withColumn(col, F.regexp_replace(F.col(col), "\x00", ""))

print(f"Null bytes stripped from {len(string_cols)} string columns.")

# COMMAND ----------

# MAGIC %md ## Step 2 — Create target schema and table via psycopg2

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
cur.execute(f"DROP TABLE IF EXISTS {TARGET_SCHEMA}.{TARGET_TABLE}")
cur.execute(f"""
CREATE TABLE {TARGET_SCHEMA}.{TARGET_TABLE} (
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
    coordinates                                     TEXT,
    latitude                                        DOUBLE PRECISION,
    longitude                                       DOUBLE PRECISION,
    cluster_id                                      TEXT,
    source_urls                                     TEXT
)
""")

SP_APP_ID = "4b31d812-e085-4472-9efa-c5b6ffef764d"
cur.execute(f'GRANT USAGE ON SCHEMA {TARGET_SCHEMA} TO "{SP_APP_ID}"')
cur.execute(f'GRANT SELECT ON {TARGET_SCHEMA}.{TARGET_TABLE} TO "{SP_APP_ID}"')

cur.close()
conn.close()
print("Table created, grants applied.")

# COMMAND ----------

# MAGIC %md ## Step 3 — Bulk load via native postgresql datasource

# COMMAND ----------

# The native `postgresql` format is supported on serverless compute.
# We write to the table WITHOUT the row_id column — Postgres fills it via SERIAL.

(
    df.write
    .format("postgresql")
    .option("host", LAKEBASE_HOST)
    .option("port", str(LAKEBASE_PORT))
    .option("database", LAKEBASE_DB)
    .option("dbtable", f"{TARGET_SCHEMA}.{TARGET_TABLE}")
    .option("user", LAKEBASE_USER)
    .option("password", LAKEBASE_TOKEN)
    .mode("append")
    .save()
)
print("Load complete.")

# COMMAND ----------

# MAGIC %md ## Step 4 — Verify

# COMMAND ----------

conn2 = psycopg2.connect(
    host=LAKEBASE_HOST, port=LAKEBASE_PORT,
    dbname=LAKEBASE_DB, user=LAKEBASE_USER,
    password=LAKEBASE_TOKEN, sslmode="require",
)
cur2 = conn2.cursor()
cur2.execute(f"SELECT COUNT(*) FROM {TARGET_SCHEMA}.{TARGET_TABLE}")
pg_count = cur2.fetchone()[0]
cur2.close()
conn2.close()

source_count = df.count()
print(f"Source: {source_count}  |  Postgres: {pg_count}")
assert pg_count == source_count, f"Mismatch! source={source_count} pg={pg_count}"
print("Verified OK.")
