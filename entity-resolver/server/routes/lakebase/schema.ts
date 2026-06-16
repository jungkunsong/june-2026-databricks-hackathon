import type { LakebaseHandle } from '../../plugin-handles';

// Schema and tables are pre-created by the project owner (sawyer@enrollhere.com).
// The app SP has ALL privileges on schema `app` and all tables within it.
// initSchema only runs CREATE TABLE IF NOT EXISTS — never CREATE SCHEMA.
//
// Data flow:
//   virtue_foundation_dataset.facilities_raw   ← read-only source
//     └─ app.facilities_resolved               ← promoted records written by the supervisor agent
//         └─ app.decision_log                  ← append-only audit trail, one row per promotion

const APP_TABLES_SQL = [
  // ── Workflow state ────────────────────────────────────────────────────────
  `CREATE TABLE IF NOT EXISTS app.resolution_tasks (
    id            SERIAL PRIMARY KEY,
    raw_row_id    INTEGER,
    facility_name TEXT,
    cluster_id    TEXT UNIQUE,
    status        TEXT NOT NULL DEFAULT 'pending',
    assigned_at   TIMESTAMPTZ,
    resolved_at   TIMESTAMPTZ,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,

  // ── Resolved output ───────────────────────────────────────────────────────
  `CREATE TABLE IF NOT EXISTS app.facilities_resolved (
    id                      SERIAL PRIMARY KEY,
    task_id                 INTEGER REFERENCES app.resolution_tasks(id),
    raw_row_id              INTEGER,
    cluster_id              TEXT,
    unique_id               TEXT,
    name                    TEXT,
    organization_type       TEXT,
    "facilityTypeId"        TEXT,
    description             TEXT,
    phone_numbers           TEXT,
    email                   TEXT,
    websites                TEXT,
    "facebookLink"          TEXT,
    address_line1           TEXT,
    address_city            TEXT,
    "address_stateOrRegion" TEXT,
    "address_zipOrPostcode" TEXT,
    address_country         TEXT,
    latitude                DOUBLE PRECISION,
    longitude               DOUBLE PRECISION,
    specialties             TEXT,
    procedure               TEXT,
    equipment               TEXT,
    capability              TEXT,
    capacity                TEXT,
    "numberDoctors"         TEXT,
    outcome                 TEXT NOT NULL DEFAULT 'verified',
    resolution_outcome      TEXT NOT NULL DEFAULT 'verified',
    confidence              NUMERIC(4,3),
    resolved_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    resolved_by             TEXT NOT NULL DEFAULT 'supervisor_agent'
  )`,

  // ── Decision log ──────────────────────────────────────────────────────────
  `CREATE TABLE IF NOT EXISTS app.decision_log (
    id                SERIAL PRIMARY KEY,
    task_id           INTEGER REFERENCES app.resolution_tasks(id),
    resolved_id       INTEGER REFERENCES app.facilities_resolved(id),
    raw_row_id        INTEGER,
    facility_name     TEXT,
    outcome           TEXT NOT NULL DEFAULT 'verified',
    confidence        NUMERIC(4,3),
    reasoning         TEXT NOT NULL DEFAULT '',
    agents_consulted  TEXT[],
    verifications     JSONB,
    human_notes       TEXT,
    agent_scores      JSONB,
    decided_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,

  // ── Entity overrides ──────────────────────────────────────────────────────
  `CREATE TABLE IF NOT EXISTS app.entity_overrides (
    id          SERIAL PRIMARY KEY,
    task_id     INTEGER REFERENCES app.resolution_tasks(id),
    raw_row_id  INTEGER,
    field_name  TEXT NOT NULL,
    old_value   TEXT,
    new_value   TEXT NOT NULL,
    changed_by  TEXT NOT NULL DEFAULT 'human',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
];

// Migration: add columns to existing tables that were created with the old schema.
// Each statement is wrapped in a DO block so it's a no-op if the column already exists.
const MIGRATION_SQL = [
  // resolution_tasks: add raw_row_id + facility_name if missing
  `DO $$ BEGIN
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema='app' AND table_name='resolution_tasks' AND column_name='raw_row_id'
    ) THEN
      ALTER TABLE app.resolution_tasks ADD COLUMN raw_row_id INTEGER;
    END IF;
  END $$`,
  `DO $$ BEGIN
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema='app' AND table_name='resolution_tasks' AND column_name='facility_name'
    ) THEN
      ALTER TABLE app.resolution_tasks ADD COLUMN facility_name TEXT;
    END IF;
  END $$`,

  // facilities_resolved: add every column that may be missing from older table versions
  `DO $$ BEGIN
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema='app' AND table_name='facilities_resolved' AND column_name='raw_row_id'
    ) THEN
      ALTER TABLE app.facilities_resolved ADD COLUMN raw_row_id INTEGER;
    END IF;
  END $$`,
  `DO $$ BEGIN
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema='app' AND table_name='facilities_resolved' AND column_name='task_id'
    ) THEN
      ALTER TABLE app.facilities_resolved ADD COLUMN task_id INTEGER REFERENCES app.resolution_tasks(id);
    END IF;
  END $$`,
  `DO $$ BEGIN
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema='app' AND table_name='facilities_resolved' AND column_name='unique_id'
    ) THEN
      ALTER TABLE app.facilities_resolved ADD COLUMN unique_id TEXT;
    END IF;
  END $$`,
  `DO $$ BEGIN
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema='app' AND table_name='facilities_resolved' AND column_name='organization_type'
    ) THEN
      ALTER TABLE app.facilities_resolved ADD COLUMN organization_type TEXT;
    END IF;
  END $$`,
  `DO $$ BEGIN
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema='app' AND table_name='facilities_resolved' AND column_name='facilityTypeId'
    ) THEN
      ALTER TABLE app.facilities_resolved ADD COLUMN "facilityTypeId" TEXT;
    END IF;
  END $$`,
  `DO $$ BEGIN
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema='app' AND table_name='facilities_resolved' AND column_name='description'
    ) THEN
      ALTER TABLE app.facilities_resolved ADD COLUMN description TEXT;
    END IF;
  END $$`,
  `DO $$ BEGIN
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema='app' AND table_name='facilities_resolved' AND column_name='phone_numbers'
    ) THEN
      ALTER TABLE app.facilities_resolved ADD COLUMN phone_numbers TEXT;
    END IF;
  END $$`,
  `DO $$ BEGIN
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema='app' AND table_name='facilities_resolved' AND column_name='email'
    ) THEN
      ALTER TABLE app.facilities_resolved ADD COLUMN email TEXT;
    END IF;
  END $$`,
  `DO $$ BEGIN
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema='app' AND table_name='facilities_resolved' AND column_name='websites'
    ) THEN
      ALTER TABLE app.facilities_resolved ADD COLUMN websites TEXT;
    END IF;
  END $$`,
  `DO $$ BEGIN
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema='app' AND table_name='facilities_resolved' AND column_name='address_line1'
    ) THEN
      ALTER TABLE app.facilities_resolved ADD COLUMN address_line1 TEXT;
    END IF;
  END $$`,
  `DO $$ BEGIN
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema='app' AND table_name='facilities_resolved' AND column_name='address_city'
    ) THEN
      ALTER TABLE app.facilities_resolved ADD COLUMN address_city TEXT;
    END IF;
  END $$`,
  `DO $$ BEGIN
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema='app' AND table_name='facilities_resolved' AND column_name='address_stateOrRegion'
    ) THEN
      ALTER TABLE app.facilities_resolved ADD COLUMN "address_stateOrRegion" TEXT;
    END IF;
  END $$`,
  `DO $$ BEGIN
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema='app' AND table_name='facilities_resolved' AND column_name='address_zipOrPostcode'
    ) THEN
      ALTER TABLE app.facilities_resolved ADD COLUMN "address_zipOrPostcode" TEXT;
    END IF;
  END $$`,
  `DO $$ BEGIN
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema='app' AND table_name='facilities_resolved' AND column_name='address_country'
    ) THEN
      ALTER TABLE app.facilities_resolved ADD COLUMN address_country TEXT;
    END IF;
  END $$`,
  `DO $$ BEGIN
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema='app' AND table_name='facilities_resolved' AND column_name='latitude'
    ) THEN
      ALTER TABLE app.facilities_resolved ADD COLUMN latitude DOUBLE PRECISION;
    END IF;
  END $$`,
  `DO $$ BEGIN
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema='app' AND table_name='facilities_resolved' AND column_name='longitude'
    ) THEN
      ALTER TABLE app.facilities_resolved ADD COLUMN longitude DOUBLE PRECISION;
    END IF;
  END $$`,
  `DO $$ BEGIN
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema='app' AND table_name='facilities_resolved' AND column_name='specialties'
    ) THEN
      ALTER TABLE app.facilities_resolved ADD COLUMN specialties TEXT;
    END IF;
  END $$`,
  `DO $$ BEGIN
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema='app' AND table_name='facilities_resolved' AND column_name='procedure'
    ) THEN
      ALTER TABLE app.facilities_resolved ADD COLUMN procedure TEXT;
    END IF;
  END $$`,
  `DO $$ BEGIN
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema='app' AND table_name='facilities_resolved' AND column_name='equipment'
    ) THEN
      ALTER TABLE app.facilities_resolved ADD COLUMN equipment TEXT;
    END IF;
  END $$`,
  `DO $$ BEGIN
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema='app' AND table_name='facilities_resolved' AND column_name='capability'
    ) THEN
      ALTER TABLE app.facilities_resolved ADD COLUMN capability TEXT;
    END IF;
  END $$`,
  `DO $$ BEGIN
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema='app' AND table_name='facilities_resolved' AND column_name='capacity'
    ) THEN
      ALTER TABLE app.facilities_resolved ADD COLUMN capacity TEXT;
    END IF;
  END $$`,
  `DO $$ BEGIN
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema='app' AND table_name='facilities_resolved' AND column_name='numberDoctors'
    ) THEN
      ALTER TABLE app.facilities_resolved ADD COLUMN "numberDoctors" TEXT;
    END IF;
  END $$`,
  `DO $$ BEGIN
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema='app' AND table_name='facilities_resolved' AND column_name='confidence'
    ) THEN
      ALTER TABLE app.facilities_resolved ADD COLUMN confidence NUMERIC(4,3);
    END IF;
  END $$`,
  `DO $$ BEGIN
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema='app' AND table_name='facilities_resolved' AND column_name='resolved_by'
    ) THEN
      ALTER TABLE app.facilities_resolved ADD COLUMN resolved_by TEXT NOT NULL DEFAULT 'supervisor_agent';
    END IF;
  END $$`,

  // facilities_resolved: add outcome + facebookLink if missing
  `DO $$ BEGIN
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema='app' AND table_name='facilities_resolved' AND column_name='outcome'
    ) THEN
      ALTER TABLE app.facilities_resolved ADD COLUMN outcome TEXT NOT NULL DEFAULT 'verified';
    END IF;
  END $$`,
  `DO $$ BEGIN
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema='app' AND table_name='facilities_resolved' AND column_name='facebookLink'
    ) THEN
      ALTER TABLE app.facilities_resolved ADD COLUMN "facebookLink" TEXT;
    END IF;
  END $$`,

  // facilities_resolved: add cluster_id if missing (live table has NOT NULL on it)
  `DO $$ BEGIN
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema='app' AND table_name='facilities_resolved' AND column_name='cluster_id'
    ) THEN
      ALTER TABLE app.facilities_resolved ADD COLUMN cluster_id TEXT;
    END IF;
  END $$`,

  // facilities_resolved: add resolution_outcome if missing (live table has NOT NULL on it).
  // We keep it in sync with the `outcome` column.
  `DO $$ BEGIN
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema='app' AND table_name='facilities_resolved' AND column_name='resolution_outcome'
    ) THEN
      ALTER TABLE app.facilities_resolved ADD COLUMN resolution_outcome TEXT NOT NULL DEFAULT 'verified';
    END IF;
  END $$`,

  // facilities_resolved: drop NOT NULL on every column that the app controls at insert time
  // so that unknown live-table constraints don't block promotion.
  // Columns with intentional NOT NULL (id, outcome, resolved_at, resolved_by) are left alone.
  `DO $$ BEGIN
    ALTER TABLE app.facilities_resolved
      ALTER COLUMN cluster_id         DROP NOT NULL,
      ALTER COLUMN resolution_outcome DROP NOT NULL;
  EXCEPTION WHEN others THEN NULL; END $$`,

  // resolution_tasks: add UNIQUE constraint on cluster_id if missing
  `DO $$ BEGIN
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conrelid = 'app.resolution_tasks'::regclass
        AND contype = 'u'
        AND conname = 'resolution_tasks_cluster_id_key'
    ) THEN
      ALTER TABLE app.resolution_tasks ADD CONSTRAINT resolution_tasks_cluster_id_key UNIQUE (cluster_id);
    END IF;
  END $$`,

  // decision_log: rebuild if it has the old cluster-based schema (check for decided_at)
  `DO $$ BEGIN
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema='app' AND table_name='decision_log' AND column_name='decided_at'
    ) THEN
      DROP TABLE IF EXISTS app.decision_log CASCADE;
    END IF;
  END $$`,

  // decision_log: add agent_scores column if missing
  `DO $$ BEGIN
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema='app' AND table_name='decision_log' AND column_name='agent_scores'
    ) THEN
      ALTER TABLE app.decision_log ADD COLUMN agent_scores JSONB;
    END IF;
  END $$`,

  // facilities_resolved: add merge_into_row_id — set when this row is a duplicate of another
  `DO $$ BEGIN
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema='app' AND table_name='facilities_resolved' AND column_name='merge_into_row_id'
    ) THEN
      ALTER TABLE app.facilities_resolved ADD COLUMN merge_into_row_id INTEGER;
    END IF;
  END $$`,

  // decision_log: add merge_into_row_id — mirrors the resolved row for audit purposes
  `DO $$ BEGIN
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema='app' AND table_name='decision_log' AND column_name='merge_into_row_id'
    ) THEN
      ALTER TABLE app.decision_log ADD COLUMN merge_into_row_id INTEGER;
    END IF;
  END $$`,
];

export async function initSchema(lb: LakebaseHandle) {
  // Run migrations first (safe no-ops if columns already exist)
  for (const sql of MIGRATION_SQL) {
    await lb.query(sql);
  }
  // Then create any missing tables
  for (const sql of APP_TABLES_SQL) {
    await lb.query(sql);
  }
  console.log('[schema] entity-resolver tables ready');
}
