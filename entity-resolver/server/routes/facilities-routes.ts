/**
 * Facilities routes — proxy queries to the MARKETPLACE SQL warehouse
 * using the Databricks REST API (statement execution).
 * The app service principal has CAN_USE on the warehouse via databricks.yml.
 */
import type { Application } from 'express';

const WAREHOUSE_ID = process.env.DATABRICKS_WAREHOUSE_ID ?? '1f9ab9aa6bd3d177';
const HOST = process.env.DATABRICKS_HOST ?? 'https://dbc-6806e9e0-845a.cloud.databricks.com';
const CATALOG = 'databricks_virtue_foundation_dataset_dais_2026';
const SCHEMA = 'virtue_foundation_dataset';

async function runSql(token: string, statement: string): Promise<Record<string, unknown>[]> {
  const resp = await fetch(`${HOST}/api/2.0/sql/statements`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      warehouse_id: WAREHOUSE_ID,
      statement,
      wait_timeout: '30s',
      catalog: CATALOG,
      schema: SCHEMA,
    }),
  });
  const data = (await resp.json()) as {
    status: { state: string; error?: { message: string } };
    manifest?: { schema: { columns: { name: string }[] } };
    result?: { data_array: (string | null)[][] };
  };
  if (data.status.state !== 'SUCCEEDED') {
    throw new Error(data.status.error?.message ?? 'SQL execution failed');
  }
  const cols = data.manifest!.schema.columns.map((c) => c.name);
  return (data.result?.data_array ?? []).map((row) =>
    Object.fromEntries(cols.map((col, i) => [col, row[i]])),
  );
}

export function setupFacilitiesRoutes(app: Application, getToken: () => Promise<string>) {

  // GET /api/facilities/clusters — ambiguous clusters (>1 record, not yet resolved)
  app.get('/api/facilities/clusters', async (req, res) => {
    try {
      const token = await getToken();
      const limit = parseInt((req.query.limit as string) ?? '50', 10);
      const offset = parseInt((req.query.offset as string) ?? '0', 10);
      const search = (req.query.search as string) ?? '';

      const searchClause = search
        ? `AND LOWER(MIN(name)) LIKE LOWER('%${search.replace(/'/g, "''")}%')`
        : '';

      const rows = await runSql(token, `
        SELECT
          cluster_id,
          COUNT(*)                                          AS record_count,
          MIN(name)                                         AS representative_name,
          MIN(address_city)                                 AS city,
          MIN(address_stateOrRegion)                        AS state,
          MIN(address_country)                              AS country,
          MIN(facilityTypeId)                               AS facility_type,
          COLLECT_LIST(DISTINCT source_types)               AS sources,
          MIN(latitude)                                     AS latitude,
          MIN(longitude)                                    AS longitude
        FROM ${CATALOG}.${SCHEMA}.facilities
        WHERE cluster_id IS NOT NULL
        GROUP BY cluster_id
        HAVING COUNT(*) > 1
        ${searchClause}
        ORDER BY record_count DESC, representative_name ASC
        LIMIT ${limit} OFFSET ${offset}
      `);
      res.json(rows);
    } catch (err) {
      console.error('[facilities] clusters error', err);
      res.status(500).json({ error: String(err) });
    }
  });

  // GET /api/facilities/clusters/count — total ambiguous cluster count
  app.get('/api/facilities/clusters/count', async (_req, res) => {
    try {
      const token = await getToken();
      const rows = await runSql(token, `
        SELECT COUNT(*) AS total
        FROM (
          SELECT cluster_id
          FROM ${CATALOG}.${SCHEMA}.facilities
          WHERE cluster_id IS NOT NULL
          GROUP BY cluster_id
          HAVING COUNT(*) > 1
        )
      `);
      res.json({ total: Number(rows[0]?.total ?? 0) });
    } catch (err) {
      console.error('[facilities] count error', err);
      res.status(500).json({ error: String(err) });
    }
  });

  // GET /api/facilities/cluster/:clusterId — all records in a cluster
  app.get('/api/facilities/cluster/:clusterId', async (req, res) => {
    try {
      const token = await getToken();
      const clusterId = req.params.clusterId.replace(/'/g, "''");
      const rows = await runSql(token, `
        SELECT
          unique_id, name, organization_type, facilityTypeId,
          specialties, procedure, equipment, capability,
          address_line1, address_city, address_stateOrRegion,
          address_country, address_zipOrPostcode,
          latitude, longitude,
          source_types, source_urls, cluster_id,
          phone_numbers, email, websites,
          numberDoctors, capacity, description,
          yearEstablished, acceptsVolunteers
        FROM ${CATALOG}.${SCHEMA}.facilities
        WHERE cluster_id = '${clusterId}'
        ORDER BY source_types ASC
      `);
      res.json(rows);
    } catch (err) {
      console.error('[facilities] cluster records error', err);
      res.status(500).json({ error: String(err) });
    }
  });
}
