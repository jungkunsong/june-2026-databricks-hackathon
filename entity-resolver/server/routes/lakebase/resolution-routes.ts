/**
 * Resolution routes — single-record verification workflow.
 *
 * Key endpoint: POST /api/promote
 *   Atomically writes facilities_resolved + decision_log + marks task resolved.
 *   Called by the supervisor agent after the human approves promotion.
 */
import type { LakebaseHandle, ServerHandle } from '../../plugin-handles';

export function setupResolutionRoutes(lb: LakebaseHandle, srv: ServerHandle) {
  srv.extend((app) => {

    // ── Tasks ──────────────────────────────────────────────────────────────

    // GET /api/tasks — list all tasks
    app.get('/api/tasks', async (req, res) => {
      try {
        const { status } = req.query;
        const params: unknown[] = [];
        const where = status ? (params.push(status), `WHERE status = $1`) : '';
        const result = await lb.query(`
          SELECT * FROM app.resolution_tasks
          ${where}
          ORDER BY updated_at DESC
        `, params);
        res.json(result.rows);
      } catch (err) {
        console.error('[tasks] list error', err);
        res.status(500).json({ error: 'Failed to list tasks' });
      }
    });

    // GET /api/tasks/:id — single task
    app.get('/api/tasks/:id', async (req, res) => {
      try {
        const id = parseInt(req.params.id, 10);
        const result = await lb.query(
          'SELECT * FROM app.resolution_tasks WHERE id = $1',
          [id],
        );
        if (result.rows.length === 0) { res.status(404).json({ error: 'Task not found' }); return; }
        res.json(result.rows[0]);
      } catch (err) {
        console.error('[tasks] get error', err);
        res.status(500).json({ error: 'Failed to get task' });
      }
    });

    // POST /api/tasks — create or upsert a task.
    // Accepts { cluster_id: string } from the client.
    // Looks up the representative raw_row_id for that cluster, then upserts the task.
    app.post('/api/tasks', async (req, res) => {
      try {
        const { cluster_id } = req.body as { cluster_id: string };
        if (!cluster_id) { res.status(400).json({ error: 'cluster_id required' }); return; }

        // Resolve cluster_id → raw_row_id (use the first/representative record)
        const lookup = await lb.query<{ row_id: number; name: string }>(`
          SELECT row_id, name
          FROM virtue_foundation_dataset.facilities_raw
          WHERE cluster_id = $1
          ORDER BY row_id ASC
          LIMIT 1
        `, [cluster_id]);
        if (lookup.rows.length === 0) {
          res.status(404).json({ error: `No records found for cluster_id: ${cluster_id}` });
          return;
        }
        const { row_id: raw_row_id, name: facility_name } = lookup.rows[0];

        const result = await lb.query(`
          INSERT INTO app.resolution_tasks (cluster_id, raw_row_id, facility_name, status, assigned_at)
          VALUES ($1, $2, $3, 'in_progress', NOW())
          ON CONFLICT (cluster_id) DO UPDATE
            SET raw_row_id    = EXCLUDED.raw_row_id,
                facility_name = EXCLUDED.facility_name,
                status        = 'in_progress',
                assigned_at   = NOW(),
                updated_at    = NOW()
          RETURNING *
        `, [cluster_id, raw_row_id, facility_name ?? null]);
        res.status(201).json(result.rows[0]);
      } catch (err) {
        console.error('[tasks] create error', err);
        res.status(500).json({ error: 'Failed to create task' });
      }
    });

    // PATCH /api/tasks/:id — update status (e.g. skip a record)
    app.patch('/api/tasks/:id', async (req, res) => {
      try {
        const id = parseInt(req.params.id, 10);
        const { status } = req.body as { status: string };
        const result = await lb.query(`
          UPDATE app.resolution_tasks
          SET status     = $1,
              resolved_at = CASE WHEN $1 = 'resolved' THEN NOW() ELSE NULL END,
              updated_at  = NOW()
          WHERE id = $2
          RETURNING *
        `, [status, id]);
        if (result.rows.length === 0) { res.status(404).json({ error: 'Task not found' }); return; }
        res.json(result.rows[0]);
      } catch (err) {
        console.error('[tasks] update error', err);
        res.status(500).json({ error: 'Failed to update task' });
      }
    });

    // ── Overrides ─────────────────────────────────────────────────────────
    // Field-level corrections the reviewer or agent applies before promotion.

    // POST /api/tasks/:id/overrides
    app.post('/api/tasks/:id/overrides', async (req, res) => {
      try {
        const task_id = parseInt(req.params.id, 10);
        const { raw_row_id, field_name, old_value, new_value } = req.body as {
          raw_row_id: number;
          field_name: string;
          old_value?: string;
          new_value: string;
        };
        const result = await lb.query(`
          INSERT INTO app.entity_overrides (task_id, raw_row_id, field_name, old_value, new_value)
          VALUES ($1, $2, $3, $4, $5)
          RETURNING *
        `, [task_id, raw_row_id, field_name, old_value ?? null, new_value]);
        res.status(201).json(result.rows[0]);
      } catch (err) {
        console.error('[overrides] create error', err);
        res.status(500).json({ error: 'Failed to save override' });
      }
    });

    // ── Promotion ─────────────────────────────────────────────────────────
    //
    // POST /api/promote
    //
    // The single atomic endpoint the supervisor agent calls when the human
    // approves promotion. Writes three rows in a transaction:
    //   1. app.facilities_resolved  — the clean, verified record
    //   2. app.decision_log         — the full audit trail entry
    //   3. app.resolution_tasks     — status → 'resolved'
    //
    // Request body shape:
    // {
    //   task_id:          number,
    //   raw_row_id:       number,
    //   facility_name:    string,
    //   outcome:          'verified' | 'corrected' | 'partial' | 'deferred',
    //   confidence:       number (0.0–1.0),
    //   reasoning:        string,
    //   agents_consulted: string[],
    //   verifications:    { field, status, old_value, new_value, agent, supervisor_reasoning }[],
    //   human_notes:      string | null,
    //   resolved_fields:  { [fieldName]: value }   — the final clean field values to write
    // }

    // GET /api/promote/schema — debug endpoint to inspect live facilities_resolved columns
    app.get('/api/promote/schema', async (_req, res) => {
      try {
        const result = await lb.query(`
          SELECT column_name, data_type, is_nullable, column_default
          FROM information_schema.columns
          WHERE table_schema = 'app' AND table_name = 'facilities_resolved'
          ORDER BY ordinal_position
        `);
        res.json(result.rows);
      } catch (err) {
        res.status(500).json({ error: String(err) });
      }
    });

    app.post('/api/promote', async (req, res) => {
      try {
        console.log('[promote] body:', JSON.stringify(req.body, null, 2));
        const {
          task_id,
          raw_row_id,
          facility_name,
          outcome,
          confidence,
          reasoning,
          agents_consulted,
          verifications,
          human_notes,
          agent_scores,
          resolved_fields = {},
        } = req.body as {
          task_id: number;
          raw_row_id: number;
          facility_name?: string;
          outcome: 'verified' | 'corrected' | 'partial' | 'deferred';
          confidence?: number;
          reasoning: string;
          agents_consulted?: string[];
          verifications?: unknown[];
          human_notes?: string;
          agent_scores?: Array<{ agent: string; score: number; rationale: string }> | null;
          resolved_fields?: Record<string, unknown>;
        };

        if (task_id == null || raw_row_id == null || !outcome || !reasoning) {
          res.status(400).json({ error: 'task_id, raw_row_id, outcome, and reasoning are required' });
          return;
        }

        // Coerce numeric fields — JSON body parsing can leave these as strings
        const taskIdNum = Number(task_id);
        const rawRowIdNum = Number(raw_row_id);
        const confidenceNum = confidence != null ? Number(confidence) : null;
        if (isNaN(taskIdNum) || isNaN(rawRowIdNum)) {
          res.status(400).json({ error: 'task_id and raw_row_id must be valid integers' });
          return;
        }

        const f = resolved_fields;

        // Look up cluster_id from the task row — the live facilities_resolved table
        // has a NOT NULL constraint on cluster_id so we must supply it.
        const taskRow = await lb.query<{ cluster_id: string }>(
          'SELECT cluster_id FROM app.resolution_tasks WHERE id = $1',
          [taskIdNum],
        );
        const cluster_id = taskRow.rows[0]?.cluster_id ?? null;

        // ── 1. Write facilities_resolved ──────────────────────────────────
        const resolvedResult = await lb.query(`
          INSERT INTO app.facilities_resolved (
            task_id, raw_row_id, cluster_id,
            unique_id, name, organization_type, "facilityTypeId",
            description, phone_numbers, email, websites, "facebookLink",
            address_line1, address_city, "address_stateOrRegion", "address_zipOrPostcode",
            address_country, latitude, longitude,
            specialties, procedure, equipment, capability, capacity, "numberDoctors",
            outcome, resolution_outcome, confidence, resolved_by
          ) VALUES (
            $1, $2, $3,
            $4, $5, $6, $7,
            $8, $9, $10, $11, $12,
            $13, $14, $15, $16,
            $17, $18, $19,
            $20, $21, $22, $23, $24, $25,
            $26, $26, $27, 'supervisor_agent'
          )
          RETURNING id
        `, [
          taskIdNum, rawRowIdNum, cluster_id,
          f.unique_id ?? null, f.name ?? facility_name ?? null, f.organization_type ?? null, f.facilityTypeId ?? null,
          f.description ?? null, f.phone_numbers ?? null, f.email ?? null, f.websites ?? null, f.facebookLink ?? null,
          f.address_line1 ?? null, f.address_city ?? null, f.address_stateOrRegion ?? null, f.address_zipOrPostcode ?? null,
          f.address_country ?? null, f.latitude ?? null, f.longitude ?? null,
          f.specialties ?? null, f.procedure ?? null, f.equipment ?? null, f.capability ?? null, f.capacity ?? null, f.numberDoctors ?? null,
          outcome, confidenceNum,
        ]);

        const resolved_id = (resolvedResult.rows[0] as { id: number }).id;

        // ── 2. Write decision_log ─────────────────────────────────────────
        await lb.query(`
          INSERT INTO app.decision_log (
            task_id, resolved_id, raw_row_id, facility_name,
            outcome, confidence, reasoning,
            agents_consulted, verifications, human_notes, agent_scores
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::text[], $9::jsonb, $10, $11::jsonb)
        `, [
          taskIdNum, resolved_id, rawRowIdNum, facility_name ?? null,
          outcome, confidenceNum, reasoning,
          agents_consulted && agents_consulted.length > 0 ? agents_consulted : null,
          verifications && verifications.length > 0 ? JSON.stringify(verifications) : null,
          human_notes ?? null,
          agent_scores && agent_scores.length > 0 ? JSON.stringify(agent_scores) : null,
        ]);

        // ── 3. Mark task resolved ─────────────────────────────────────────
        await lb.query(`
          UPDATE app.resolution_tasks
          SET status = 'resolved', resolved_at = NOW(), updated_at = NOW()
          WHERE id = $1
        `, [taskIdNum]);

        res.status(201).json({ resolved_id, task_id: taskIdNum, outcome });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error('[promote] error', msg);
        res.status(500).json({ error: `Failed to promote record: ${msg}` });
      }
    });

    // ── Resolved records ──────────────────────────────────────────────────

    // GET /api/resolved — all promoted records
    app.get('/api/resolved', async (_req, res) => {
      try {
        const result = await lb.query(`
          SELECT r.*, dl.reasoning, dl.agents_consulted, dl.verifications, dl.human_notes
          FROM app.facilities_resolved r
          LEFT JOIN app.decision_log dl ON dl.resolved_id = r.id
          ORDER BY r.resolved_at DESC
          LIMIT 500
        `);
        res.json(result.rows);
      } catch (err) {
        console.error('[resolved] list error', err);
        res.status(500).json({ error: 'Failed to list resolved records' });
      }
    });

    // ── Decision log ──────────────────────────────────────────────────────

    // GET /api/decision-log — full audit trail
    app.get('/api/decision-log', async (req, res) => {
      try {
        const { task_id, raw_row_id } = req.query;
        const params: unknown[] = [];
        const conditions: string[] = [];
        if (task_id)    { params.push(task_id);    conditions.push(`task_id = $${params.length}`); }
        if (raw_row_id) { params.push(raw_row_id); conditions.push(`raw_row_id = $${params.length}`); }
        const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
        const result = await lb.query(`
          SELECT dl.*, t.cluster_id
          FROM app.decision_log dl
          LEFT JOIN app.resolution_tasks t ON t.id = dl.task_id
          ${where.replace(/task_id/g, 'dl.task_id').replace(/raw_row_id/g, 'dl.raw_row_id')}
          ORDER BY dl.decided_at DESC
          LIMIT 500
        `, params);
        res.json(result.rows);
      } catch (err) {
        console.error('[decision-log] list error', err);
        res.status(500).json({ error: 'Failed to list decision log' });
      }
    });
  });
}
