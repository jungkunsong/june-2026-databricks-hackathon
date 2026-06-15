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
