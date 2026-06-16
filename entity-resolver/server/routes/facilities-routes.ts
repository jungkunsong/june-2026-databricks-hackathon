/**
 * Facilities routes — query Lakebase directly.
 * The raw facilities data lives in virtue_foundation_dataset.facilities_raw,
 * copied there once by the sync notebook.
 */
import type { LakebaseHandle, ServerHandle } from '../plugin-handles';

export function setupFacilitiesRoutes(lb: LakebaseHandle, srv: ServerHandle) {
  srv.extend((app) => {

    // GET /api/facilities/clusters/count — total distinct cluster count (with optional search)
    app.get('/api/facilities/clusters/count', async (req, res) => {
      try {
        const { search } = req.query as { search?: string };
        const params: unknown[] = [];
        let where = `WHERE cluster_id IS NOT NULL
          AND cluster_id NOT IN (
            SELECT DISTINCT cluster_id
            FROM app.facilities_resolved
            WHERE cluster_id IS NOT NULL
          )`;
        if (search) {
          params.push(`%${search}%`);
          where += ` AND name ILIKE $${params.length}`;
        }
        const result = await lb.query(`
          SELECT COUNT(DISTINCT cluster_id) AS total
          FROM virtue_foundation_dataset.facilities_raw
          ${where}
        `, params);
        res.json({ total: Number(result.rows[0]?.total ?? 0) });
      } catch (err) {
        console.error('[facilities] count error', err);
        res.status(500).json({ error: String(err) });
      }
    });

    // GET /api/facilities/clusters — distinct cluster_ids with record counts and representative metadata
    // Supports: ?limit=20&offset=0&search=<name>
    app.get('/api/facilities/clusters', async (req, res) => {
      try {
        const {
          limit = '50',
          offset = '0',
          search,
        } = req.query as { limit?: string; offset?: string; search?: string };

        const lim = Math.min(Math.max(1, parseInt(limit, 10) || 50), 200);
        const off = Math.max(0, parseInt(offset, 10) || 0);

        const params: unknown[] = [];
        let nameFilter = '';
        if (search) {
          params.push(`%${search}%`);
          nameFilter = `AND name ILIKE $${params.length}`;
        }

        // Subquery to exclude already-resolved clusters
        const resolvedExclusion = `AND cluster_id NOT IN (
            SELECT DISTINCT cluster_id
            FROM app.facilities_resolved
            WHERE cluster_id IS NOT NULL
          )`;

        // Push limit and offset as the last two params
        params.push(lim);
        const limitParam = `$${params.length}`;
        params.push(off);
        const offsetParam = `$${params.length}`;

        // Use a CTE to pick one representative row per cluster (the first by row_id),
        // then aggregate source_types across all rows in the cluster.
        const result = await lb.query(`
          WITH ranked AS (
            SELECT *,
                   ROW_NUMBER() OVER (PARTITION BY cluster_id ORDER BY row_id ASC) AS rn
            FROM virtue_foundation_dataset.facilities_raw
            WHERE cluster_id IS NOT NULL
            ${nameFilter}
            ${resolvedExclusion}
          ),
          rep AS (
            SELECT cluster_id,
                   name            AS representative_name,
                   address_city    AS city,
                   "address_stateOrRegion" AS state,
                   address_country AS country,
                   "facilityTypeId" AS facility_type,
                   latitude,
                   longitude
            FROM ranked
            WHERE rn = 1
          ),
          counts AS (
            SELECT cluster_id,
                   COUNT(*) AS record_count,
                   ARRAY_AGG(DISTINCT source_types) FILTER (WHERE source_types IS NOT NULL) AS sources
            FROM virtue_foundation_dataset.facilities_raw
            WHERE cluster_id IS NOT NULL
            ${nameFilter}
            ${resolvedExclusion}
            GROUP BY cluster_id
          )
          SELECT r.cluster_id,
                 r.representative_name,
                 r.city,
                 r.state,
                 r.country,
                 r.facility_type,
                 r.latitude,
                 r.longitude,
                 c.record_count,
                 c.sources
          FROM rep r
          JOIN counts c USING (cluster_id)
          ORDER BY c.record_count DESC, r.cluster_id ASC
          LIMIT ${limitParam} OFFSET ${offsetParam}
        `, params);
        res.json(result.rows);
      } catch (err) {
        console.error('[facilities] clusters error', err);
        res.status(500).json({ error: String(err) });
      }
    });

    // GET /api/facilities/cluster/:clusterId — all records in a cluster
    app.get('/api/facilities/cluster/:clusterId', async (req, res) => {
      try {
        const result = await lb.query(`
          SELECT
            row_id, unique_id, name, organization_type, "facilityTypeId",
            specialties, procedure, equipment, capability,
            address_line1, address_city, "address_stateOrRegion",
            address_country, "address_zipOrPostcode",
            latitude, longitude,
            source_types, source_urls, cluster_id,
            phone_numbers, email, websites,
            "numberDoctors", capacity, description,
            "yearEstablished", "acceptsVolunteers"
          FROM virtue_foundation_dataset.facilities_raw
          WHERE cluster_id = $1
          ORDER BY source_types ASC
        `, [req.params.clusterId]);
        res.json(result.rows);
      } catch (err) {
        console.error('[facilities] cluster records error', err);
        res.status(500).json({ error: String(err) });
      }
    });

    // GET /api/facilities/duplicate-candidates/:rowId
    // Returns up to 20 candidate records that share at least one strong identity
    // signal with the target row: phone, website, facebook link, or coordinates
    // within 0.5 km. Excludes the target row itself.
    app.get('/api/facilities/duplicate-candidates/:rowId', async (req, res) => {
      try {
        const rowId = parseInt(req.params.rowId, 10);
        if (isNaN(rowId)) { res.status(400).json({ error: 'Invalid row_id' }); return; }

        // Fetch the target record first
        const targetResult = await lb.query(`
          SELECT row_id, unique_id, name,
                 phone_numbers, websites, "facebookLink",
                 latitude, longitude,
                 address_city, "address_stateOrRegion", "address_zipOrPostcode"
          FROM virtue_foundation_dataset.facilities_raw
          WHERE row_id = $1
        `, [rowId]);

        if (targetResult.rows.length === 0) {
          res.status(404).json({ error: 'Target record not found' });
          return;
        }

        const target = targetResult.rows[0] as Record<string, unknown>;

        // Normalise helpers — treat literal "null" strings as null
        const norm = (v: unknown): string | null => {
          if (!v) return null;
          const s = String(v).trim();
          return s === '' || s.toLowerCase() === 'null' ? null : s;
        };

        const targetPhone   = norm(target.phone_numbers);
        const targetWebsite = norm(target.websites);
        const targetFb      = norm(target['facebookLink']);
        const targetLat     = target.latitude != null ? parseFloat(String(target.latitude)) : null;
        const targetLng     = target.longitude != null ? parseFloat(String(target.longitude)) : null;

        // Build OR clauses for each signal that is present
        const conditions: string[] = [];
        const params: unknown[] = [rowId]; // $1 = exclude self

        if (targetPhone) {
          params.push(targetPhone);
          conditions.push(`phone_numbers = $${params.length}`);
        }
        if (targetWebsite) {
          params.push(targetWebsite);
          conditions.push(`websites = $${params.length}`);
        }
        if (targetFb) {
          params.push(targetFb);
          conditions.push(`"facebookLink" = $${params.length}`);
        }
        // Coordinate proximity: ~0.5 km ≈ 0.0045 degrees
        if (targetLat !== null && targetLng !== null) {
          params.push(targetLat - 0.0045, targetLat + 0.0045);
          params.push(targetLng - 0.0045, targetLng + 0.0045);
          const latLo = `$${params.length - 3}`;
          const latHi = `$${params.length - 2}`;
          const lngLo = `$${params.length - 1}`;
          const lngHi = `$${params.length}`;
          conditions.push(
            `(latitude BETWEEN ${latLo} AND ${latHi} AND longitude BETWEEN ${lngLo} AND ${lngHi})`
          );
        }

        if (conditions.length === 0) {
          // No signals to match on — return empty candidates
          res.json({ target_row_id: rowId, candidates: [] });
          return;
        }

        const candidateResult = await lb.query(`
          SELECT row_id, unique_id, name,
                 phone_numbers, websites, "facebookLink",
                 latitude, longitude,
                 address_city, "address_stateOrRegion", "address_zipOrPostcode"
          FROM virtue_foundation_dataset.facilities_raw
          WHERE row_id <> $1
            AND (${conditions.join(' OR ')})
          ORDER BY name ASC
          LIMIT 20
        `, params);

        res.json({
          target_row_id: rowId,
          target: target,
          candidates: candidateResult.rows,
        });
      } catch (err) {
        console.error('[facilities] duplicate-candidates error', err);
        res.status(500).json({ error: String(err) });
      }
    });

    // GET /api/facilities/:rowId — single raw record by row_id
    app.get('/api/facilities/:rowId', async (req, res) => {
      try {
        const rowId = parseInt(req.params.rowId, 10);
        if (isNaN(rowId)) { res.status(400).json({ error: 'Invalid row_id' }); return; }
        const result = await lb.query(`
          SELECT * FROM virtue_foundation_dataset.facilities_raw
          WHERE row_id = $1
        `, [rowId]);
        if (result.rows.length === 0) { res.status(404).json({ error: 'Not found' }); return; }
        res.json(result.rows[0]);
      } catch (err) {
        console.error('[facilities] single record error', err);
        res.status(500).json({ error: String(err) });
      }
    });

  });
}
