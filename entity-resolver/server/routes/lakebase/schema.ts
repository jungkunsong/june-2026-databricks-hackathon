import type { AppKitWithLakebase } from '../../types';

export const SCHEMA_SQL = `
  CREATE SCHEMA IF NOT EXISTS app;

  CREATE TABLE IF NOT EXISTS app.resolution_tasks (
    id            SERIAL PRIMARY KEY,
    cluster_id    TEXT NOT NULL UNIQUE,
    status        TEXT NOT NULL DEFAULT 'pending',  -- pending | in_progress | resolved | skipped
    assigned_at   TIMESTAMPTZ,
    resolved_at   TIMESTAMPTZ,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

  CREATE TABLE IF NOT EXISTS app.decisions (
    id              SERIAL PRIMARY KEY,
    task_id         INTEGER NOT NULL REFERENCES app.resolution_tasks(id),
    cluster_id      TEXT NOT NULL,
    outcome         TEXT NOT NULL,  -- merged | split | confirmed_duplicate | confirmed_distinct | deferred
    golden_record   JSONB,          -- the canonical merged record
    confidence      NUMERIC(4,3),   -- 0.000 to 1.000
    reasoning       TEXT,
    decided_by      TEXT NOT NULL DEFAULT 'human',  -- human | supervisor
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

  CREATE TABLE IF NOT EXISTS app.messages (
    id          SERIAL PRIMARY KEY,
    task_id     INTEGER NOT NULL REFERENCES app.resolution_tasks(id),
    role        TEXT NOT NULL,   -- user | supervisor | sub_agent
    agent_name  TEXT,            -- which sub-agent sent this (if role=sub_agent)
    content     TEXT NOT NULL,
    metadata    JSONB,           -- confidence scores, evidence refs, etc.
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

  CREATE TABLE IF NOT EXISTS app.entity_overrides (
    id          SERIAL PRIMARY KEY,
    task_id     INTEGER NOT NULL REFERENCES app.resolution_tasks(id),
    cluster_id  TEXT NOT NULL,
    field_name  TEXT NOT NULL,
    old_value   TEXT,
    new_value   TEXT,
    changed_by  TEXT NOT NULL DEFAULT 'human',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
`;

export async function initSchema(appkit: AppKitWithLakebase) {
  await appkit.lakebase.query(SCHEMA_SQL);
  console.log('[schema] entity-resolver schema initialized');
}
