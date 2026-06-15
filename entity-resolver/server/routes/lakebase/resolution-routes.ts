import type { LakebaseHandle, ServerHandle } from '../../plugin-handles';

export function setupResolutionRoutes(lb: LakebaseHandle, srv: ServerHandle) {
  srv.extend((app) => {

    // ── Tasks ──────────────────────────────────────────────────────────────

    // GET /api/tasks — list all tasks with record counts from Lakebase
    app.get('/api/tasks', async (req, res) => {
      try {
        const { status } = req.query;
        const params: unknown[] = [];
        let where = '';
        if (status) {
          params.push(status);
          where = `WHERE t.status = $1`;
        }
        const result = await lb.query(`
          SELECT t.*,
                 COUNT(d.id) AS decision_count,
                 COUNT(m.id) AS message_count
          FROM app.resolution_tasks t
          LEFT JOIN app.decisions d ON d.task_id = t.id
          LEFT JOIN app.messages  m ON m.task_id = t.id
          ${where}
          GROUP BY t.id
          ORDER BY t.updated_at DESC
        `, params);
        res.json(result.rows);
      } catch (err) {
        console.error('[tasks] list error', err);
        res.status(500).json({ error: 'Failed to list tasks' });
      }
    });

    // GET /api/tasks/:id — single task with messages + latest decision
    app.get('/api/tasks/:id', async (req, res) => {
      try {
        const id = parseInt(req.params.id, 10);
        const [taskResult, messagesResult, decisionResult] = await Promise.all([
          lb.query('SELECT * FROM app.resolution_tasks WHERE id = $1', [id]),
          lb.query(
            'SELECT * FROM app.messages WHERE task_id = $1 ORDER BY created_at ASC',
            [id],
          ),
          lb.query(
            'SELECT * FROM app.decisions WHERE task_id = $1 ORDER BY created_at DESC LIMIT 1',
            [id],
          ),
        ]);
        if (taskResult.rows.length === 0) {
          res.status(404).json({ error: 'Task not found' });
          return;
        }
        res.json({
          task: taskResult.rows[0],
          messages: messagesResult.rows,
          latest_decision: decisionResult.rows[0] ?? null,
        });
      } catch (err) {
        console.error('[tasks] get error', err);
        res.status(500).json({ error: 'Failed to get task' });
      }
    });

    // POST /api/tasks — create or upsert a task for a cluster_id
    app.post('/api/tasks', async (req, res) => {
      try {
        const { cluster_id } = req.body as { cluster_id: string };
        if (!cluster_id) {
          res.status(400).json({ error: 'cluster_id required' });
          return;
        }
        const result = await lb.query(`
          INSERT INTO app.resolution_tasks (cluster_id, status, assigned_at)
          VALUES ($1, 'in_progress', NOW())
          ON CONFLICT (cluster_id) DO UPDATE
            SET status = 'in_progress', assigned_at = NOW(), updated_at = NOW()
          RETURNING *
        `, [cluster_id]);
        res.status(201).json(result.rows[0]);
      } catch (err) {
        console.error('[tasks] create error', err);
        res.status(500).json({ error: 'Failed to create task' });
      }
    });

    // PATCH /api/tasks/:id — update status
    app.patch('/api/tasks/:id', async (req, res) => {
      try {
        const id = parseInt(req.params.id, 10);
        const { status } = req.body as { status: string };
        const resolved_at = status === 'resolved' ? 'NOW()' : 'NULL';
        const result = await lb.query(`
          UPDATE app.resolution_tasks
          SET status = $1,
              resolved_at = ${resolved_at},
              updated_at = NOW()
          WHERE id = $2
          RETURNING *
        `, [status, id]);
        if (result.rows.length === 0) {
          res.status(404).json({ error: 'Task not found' });
          return;
        }
        res.json(result.rows[0]);
      } catch (err) {
        console.error('[tasks] update error', err);
        res.status(500).json({ error: 'Failed to update task' });
      }
    });

    // ── Messages ───────────────────────────────────────────────────────────

    // POST /api/tasks/:id/messages — append a message to a task thread
    app.post('/api/tasks/:id/messages', async (req, res) => {
      try {
        const task_id = parseInt(req.params.id, 10);
        const { role, agent_name, content, metadata } = req.body as {
          role: string;
          agent_name?: string;
          content: string;
          metadata?: Record<string, unknown>;
        };
        const result = await lb.query(`
          INSERT INTO app.messages (task_id, role, agent_name, content, metadata)
          VALUES ($1, $2, $3, $4, $5)
          RETURNING *
        `, [task_id, role, agent_name ?? null, content, metadata ? JSON.stringify(metadata) : null]);
        res.status(201).json(result.rows[0]);
      } catch (err) {
        console.error('[messages] create error', err);
        res.status(500).json({ error: 'Failed to save message' });
      }
    });

    // ── Decisions ──────────────────────────────────────────────────────────

    // POST /api/tasks/:id/decisions — record a resolution decision
    app.post('/api/tasks/:id/decisions', async (req, res) => {
      try {
        const task_id = parseInt(req.params.id, 10);
        const { cluster_id, outcome, golden_record, confidence, reasoning, decided_by } =
          req.body as {
            cluster_id: string;
            outcome: string;
            golden_record?: Record<string, unknown>;
            confidence?: number;
            reasoning?: string;
            decided_by?: string;
          };

        const result = await lb.query(`
          INSERT INTO app.decisions
            (task_id, cluster_id, outcome, golden_record, confidence, reasoning, decided_by)
          VALUES ($1, $2, $3, $4, $5, $6, $7)
          RETURNING *
        `, [
          task_id,
          cluster_id,
          outcome,
          golden_record ? JSON.stringify(golden_record) : null,
          confidence ?? null,
          reasoning ?? null,
          decided_by ?? 'human',
        ]);

        // Mark task resolved
        await lb.query(`
          UPDATE app.resolution_tasks
          SET status = 'resolved', resolved_at = NOW(), updated_at = NOW()
          WHERE id = $1
        `, [task_id]);

        res.status(201).json(result.rows[0]);
      } catch (err) {
        console.error('[decisions] create error', err);
        res.status(500).json({ error: 'Failed to save decision' });
      }
    });

    // GET /api/decisions — all decisions (audit log)
    app.get('/api/decisions', async (_req, res) => {
      try {
        const result = await lb.query(`
          SELECT d.*, t.cluster_id
          FROM app.decisions d
          JOIN app.resolution_tasks t ON t.id = d.task_id
          ORDER BY d.created_at DESC
          LIMIT 200
        `);
        res.json(result.rows);
      } catch (err) {
        console.error('[decisions] list error', err);
        res.status(500).json({ error: 'Failed to list decisions' });
      }
    });

    // ── Resolved records ───────────────────────────────────────────────────

    // POST /api/tasks/:id/resolved — supervisor agent writes the golden record
    app.post('/api/tasks/:id/resolved', async (req, res) => {
      try {
        const task_id = parseInt(req.params.id, 10);
        const {
          cluster_id, unique_id, name, organization_type, facilityTypeId,
          description, phone_numbers, email, websites,
          address_line1, address_city, address_stateOrRegion, address_zipOrPostcode,
          address_country, latitude, longitude,
          specialties, procedure, equipment, capability, capacity, numberDoctors,
          source_row_ids, source_types, resolution_outcome, confidence, resolved_by,
        } = req.body as Record<string, unknown>;

        const result = await lb.query(`
          INSERT INTO app.facilities_resolved (
            task_id, cluster_id, unique_id, name, organization_type, "facilityTypeId",
            description, phone_numbers, email, websites,
            address_line1, address_city, "address_stateOrRegion", "address_zipOrPostcode",
            address_country, latitude, longitude,
            specialties, procedure, equipment, capability, capacity, "numberDoctors",
            source_row_ids, source_types, resolution_outcome, confidence, resolved_by
          ) VALUES (
            $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,
            $11,$12,$13,$14,$15,$16,$17,$18,$19,$20,
            $21,$22,$23,$24,$25,$26,$27,$28
          )
          RETURNING *
        `, [
          task_id, cluster_id, unique_id, name, organization_type, facilityTypeId,
          description, phone_numbers, email, websites,
          address_line1, address_city, address_stateOrRegion, address_zipOrPostcode,
          address_country, latitude ?? null, longitude ?? null,
          specialties, procedure, equipment, capability, capacity, numberDoctors,
          source_row_ids ?? null, source_types,
          resolution_outcome, confidence ?? null, resolved_by ?? 'supervisor_agent',
        ]);
        res.status(201).json(result.rows[0]);
      } catch (err) {
        console.error('[resolved] create error', err);
        res.status(500).json({ error: 'Failed to save resolved record' });
      }
    });

    // GET /api/resolved — all golden records
    app.get('/api/resolved', async (_req, res) => {
      try {
        const result = await lb.query(`
          SELECT * FROM app.facilities_resolved
          ORDER BY resolved_at DESC
          LIMIT 500
        `);
        res.json(result.rows);
      } catch (err) {
        console.error('[resolved] list error', err);
        res.status(500).json({ error: 'Failed to list resolved records' });
      }
    });

    // ── Decision log ───────────────────────────────────────────────────────

    // POST /api/tasks/:id/decision-log — supervisor agent appends a log entry
    app.post('/api/tasks/:id/decision-log', async (req, res) => {
      try {
        const task_id = parseInt(req.params.id, 10);
        const {
          cluster_id, agent_name, decision_type, decision_outcome,
          confidence, reasoning, evidence, raw_row_ids, resolved_id,
        } = req.body as Record<string, unknown>;

        const result = await lb.query(`
          INSERT INTO app.decision_log (
            task_id, cluster_id, agent_name,
            decision_type, decision_outcome, confidence,
            reasoning, evidence, raw_row_ids, resolved_id
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
          RETURNING *
        `, [
          task_id, cluster_id, agent_name,
          decision_type, decision_outcome, confidence ?? null,
          reasoning, evidence ? JSON.stringify(evidence) : null,
          raw_row_ids ?? null, resolved_id ?? null,
        ]);
        res.status(201).json(result.rows[0]);
      } catch (err) {
        console.error('[decision-log] create error', err);
        res.status(500).json({ error: 'Failed to write decision log' });
      }
    });

    // PATCH /api/decision-log/:id — human reviewer approves/rejects/modifies
    app.patch('/api/decision-log/:id', async (req, res) => {
      try {
        const id = parseInt(req.params.id, 10);
        const { human_action, human_notes } = req.body as {
          human_action: 'approved' | 'rejected' | 'modified';
          human_notes?: string;
        };
        const result = await lb.query(`
          UPDATE app.decision_log
          SET human_action = $1,
              human_notes  = $2,
              reviewed_at  = NOW()
          WHERE id = $3
          RETURNING *
        `, [human_action, human_notes ?? null, id]);
        if (result.rows.length === 0) { res.status(404).json({ error: 'Log entry not found' }); return; }
        res.json(result.rows[0]);
      } catch (err) {
        console.error('[decision-log] review error', err);
        res.status(500).json({ error: 'Failed to update decision log' });
      }
    });

    // GET /api/decision-log — full audit trail
    app.get('/api/decision-log', async (req, res) => {
      try {
        const { cluster_id, task_id } = req.query;
        const params: unknown[] = [];
        const conditions: string[] = [];
        if (cluster_id) { params.push(cluster_id); conditions.push(`cluster_id = $${params.length}`); }
        if (task_id)    { params.push(task_id);    conditions.push(`task_id = $${params.length}`); }
        const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
        const result = await lb.query(`
          SELECT * FROM app.decision_log
          ${where}
          ORDER BY created_at DESC
          LIMIT 500
        `, params);
        res.json(result.rows);
      } catch (err) {
        console.error('[decision-log] list error', err);
        res.status(500).json({ error: 'Failed to list decision log' });
      }
    });

    // ── Entity overrides ───────────────────────────────────────────────────

    // POST /api/tasks/:id/overrides
    app.post('/api/tasks/:id/overrides', async (req, res) => {
      try {
        const task_id = parseInt(req.params.id, 10);
        const { cluster_id, field_name, old_value, new_value } = req.body as {
          cluster_id: string;
          field_name: string;
          old_value?: string;
          new_value: string;
        };
        const result = await lb.query(`
          INSERT INTO app.entity_overrides (task_id, cluster_id, field_name, old_value, new_value)
          VALUES ($1, $2, $3, $4, $5)
          RETURNING *
        `, [task_id, cluster_id, field_name, old_value ?? null, new_value]);
        res.status(201).json(result.rows[0]);
      } catch (err) {
        console.error('[overrides] create error', err);
        res.status(500).json({ error: 'Failed to save override' });
      }
    });
  });
}
