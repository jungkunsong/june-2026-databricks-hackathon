import type { LakebaseHandle } from '../../plugin-handles';

// Schema and tables are pre-created by the project owner (sawyer@enrollhere.com).
// The app SP has ALL privileges on schema app and all tables within it.
// initSchema only runs CREATE TABLE IF NOT EXISTS — never CREATE SCHEMA,
// which requires ownership and would crash on the SP's restricted credentials.

const TABLES_SQL = [
  `CREATE TABLE IF NOT EXISTS app.resolution_tasks (
    id            SERIAL PRIMARY KEY,
    cluster_id    TEXT NOT NULL UNIQUE,
    status        TEXT NOT NULL DEFAULT 'pending',
    assigned_at   TIMESTAMPTZ,
    resolved_at   TIMESTAMPTZ,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE TABLE IF NOT EXISTS app.decisions (
    id              SERIAL PRIMARY KEY,
    task_id         INTEGER NOT NULL REFERENCES app.resolution_tasks(id),
    cluster_id      TEXT NOT NULL,
    outcome         TEXT NOT NULL,
    golden_record   JSONB,
    confidence      NUMERIC(4,3),
    reasoning       TEXT,
    decided_by      TEXT NOT NULL DEFAULT 'human',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE TABLE IF NOT EXISTS app.messages (
    id          SERIAL PRIMARY KEY,
    task_id     INTEGER NOT NULL REFERENCES app.resolution_tasks(id),
    role        TEXT NOT NULL,
    agent_name  TEXT,
    content     TEXT NOT NULL,
    metadata    JSONB,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE TABLE IF NOT EXISTS app.entity_overrides (
    id          SERIAL PRIMARY KEY,
    task_id     INTEGER NOT NULL REFERENCES app.resolution_tasks(id),
    cluster_id  TEXT NOT NULL,
    field_name  TEXT NOT NULL,
    old_value   TEXT,
    new_value   TEXT,
    changed_by  TEXT NOT NULL DEFAULT 'human',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
];

export async function initSchema(lb: LakebaseHandle) {
  for (const sql of TABLES_SQL) {
    await lb.query(sql);
  }
  console.log('[schema] entity-resolver tables ready');
}
