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
  // One row per raw facility record under review.
  // Keyed on raw_row_id (the row_id from facilities_raw).
  `CREATE TABLE IF NOT EXISTS app.resolution_tasks (
    id            SERIAL PRIMARY KEY,
    raw_row_id    INTEGER NOT NULL UNIQUE,   -- row_id from facilities_raw
    facility_name TEXT,                      -- denormalised for display
    status        TEXT NOT NULL DEFAULT 'pending',  -- pending | in_progress | resolved | skipped
    assigned_at   TIMESTAMPTZ,
    resolved_at   TIMESTAMPTZ,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,

  // ── Resolved output ───────────────────────────────────────────────────────
  // One row per promoted facility record (golden record).
  // Written atomically with decision_log by POST /api/promote.
  `CREATE TABLE IF NOT EXISTS app.facilities_resolved (
    id                      SERIAL PRIMARY KEY,
    task_id                 INTEGER REFERENCES app.resolution_tasks(id),
    raw_row_id              INTEGER NOT NULL,   -- source row from facilities_raw
    -- Verified / corrected field values
    unique_id               TEXT,
    name                    TEXT,
    organization_type       TEXT,
    "facilityTypeId"        TEXT,
    description             TEXT,
    phone_numbers           TEXT,
    email                   TEXT,
    websites                TEXT,
    facebookLink            TEXT,
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
    -- Resolution metadata
    outcome                 TEXT NOT NULL,  -- verified | corrected | partial | deferred
    confidence              NUMERIC(4,3),
    resolved_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    resolved_by             TEXT NOT NULL DEFAULT 'supervisor_agent'
  )`,

  // ── Decision log ──────────────────────────────────────────────────────────
  // Append-only audit trail written by the supervisor agent at promotion time.
  // One row per promoted record. Captures the full reasoning chain.
  `CREATE TABLE IF NOT EXISTS app.decision_log (
    id                SERIAL PRIMARY KEY,
    task_id           INTEGER NOT NULL REFERENCES app.resolution_tasks(id),
    resolved_id       INTEGER REFERENCES app.facilities_resolved(id),
    raw_row_id        INTEGER NOT NULL,
    facility_name     TEXT,
    -- Promotion outcome
    outcome           TEXT NOT NULL,   -- verified | corrected | partial | deferred
    confidence        NUMERIC(4,3),
    -- Supervisor reasoning (prose summary)
    reasoning         TEXT NOT NULL,
    -- Which sub-agents ran
    agents_consulted  TEXT[],
    -- Per-field verification results
    -- Array of { field, status, old_value, new_value, agent, supervisor_reasoning }
    verifications     JSONB,
    -- Human reviewer input
    human_notes       TEXT,
    decided_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,

  // ── Entity overrides ──────────────────────────────────────────────────────
  // Field-level corrections applied by the reviewer or agents before promotion.
  `CREATE TABLE IF NOT EXISTS app.entity_overrides (
    id          SERIAL PRIMARY KEY,
    task_id     INTEGER NOT NULL REFERENCES app.resolution_tasks(id),
    raw_row_id  INTEGER NOT NULL,
    field_name  TEXT NOT NULL,
    old_value   TEXT,
    new_value   TEXT NOT NULL,
    changed_by  TEXT NOT NULL DEFAULT 'human',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
];

export async function initSchema(lb: LakebaseHandle) {
  for (const sql of APP_TABLES_SQL) {
    await lb.query(sql);
  }
  console.log('[schema] entity-resolver tables ready');
}
