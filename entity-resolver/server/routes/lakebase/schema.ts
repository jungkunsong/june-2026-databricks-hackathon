import type { LakebaseHandle } from '../../plugin-handles';

// Schema and tables are pre-created by the project owner (sawyer@enrollhere.com).
// The app SP has ALL privileges on schema `app` and all tables within it.
// initSchema only runs CREATE TABLE IF NOT EXISTS — never CREATE SCHEMA.
//
// Data flow:
//   virtue_foundation_dataset.facilities_raw   ← copied in by the notebook (read-only to the app)
//     └─ app.facilities_resolved               ← golden records written by the supervisor agent
//         └─ app.decision_log                  ← append-only audit trail, one row per agent decision

const APP_TABLES_SQL = [
  // ── Workflow state ────────────────────────────────────────────────────────
  `CREATE TABLE IF NOT EXISTS app.resolution_tasks (
    id            SERIAL PRIMARY KEY,
    cluster_id    TEXT NOT NULL UNIQUE,
    status        TEXT NOT NULL DEFAULT 'pending',
    assigned_at   TIMESTAMPTZ,
    resolved_at   TIMESTAMPTZ,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
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

  // ── Legacy decisions table (kept for UI compatibility) ────────────────────
  // Written by the human via POST /api/tasks/:id/decisions.
  // New audit trail lives in app.decision_log (written by the supervisor agent).
  `CREATE TABLE IF NOT EXISTS app.decisions (
    id            SERIAL PRIMARY KEY,
    task_id       INTEGER NOT NULL REFERENCES app.resolution_tasks(id),
    cluster_id    TEXT NOT NULL,
    outcome       TEXT NOT NULL,
    golden_record JSONB,
    confidence    NUMERIC(4,3),
    reasoning     TEXT,
    decided_by    TEXT NOT NULL DEFAULT 'human',
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,

  // ── Resolved output ───────────────────────────────────────────────────────
  // One row per resolved entity (golden record).
  // Written by the supervisor agent after a merge/split decision is confirmed.
  `CREATE TABLE IF NOT EXISTS app.facilities_resolved (
    id                      SERIAL PRIMARY KEY,
    task_id                 INTEGER REFERENCES app.resolution_tasks(id),
    cluster_id              TEXT NOT NULL,
    -- Golden record fields (best values chosen across the cluster)
    unique_id               TEXT,
    name                    TEXT,
    organization_type       TEXT,
    "facilityTypeId"        TEXT,
    description             TEXT,
    phone_numbers           TEXT,
    email                   TEXT,
    websites                TEXT,
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
    -- Provenance: which raw row_ids were merged into this record
    source_row_ids          INTEGER[],
    source_types            TEXT,
    -- Resolution metadata
    resolution_outcome      TEXT NOT NULL,  -- 'merged' | 'split' | 'kept_as_is'
    confidence              NUMERIC(4,3),
    resolved_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    resolved_by             TEXT NOT NULL DEFAULT 'supervisor_agent'
  )`,

  // ── Decision log ──────────────────────────────────────────────────────────
  // Append-only audit trail written by the supervisor agent at the end of
  // every resolution.  One row per decision, capturing the full reasoning
  // chain so we can trace exactly why a record moved from raw → resolved.
  `CREATE TABLE IF NOT EXISTS app.decision_log (
    id               SERIAL PRIMARY KEY,
    task_id          INTEGER NOT NULL REFERENCES app.resolution_tasks(id),
    cluster_id       TEXT NOT NULL,
    -- Which agent produced this entry
    agent_name       TEXT NOT NULL,
    -- What was decided
    decision_type    TEXT NOT NULL,    -- 'merge' | 'split' | 'keep' | 'flag' | 'override'
    decision_outcome TEXT NOT NULL,    -- human-readable outcome label
    confidence       NUMERIC(4,3),
    -- Full reasoning from the agent (prose / markdown)
    reasoning        TEXT NOT NULL,
    -- Structured evidence the agent cited (field comparisons, similarity scores, etc.)
    evidence         JSONB,
    -- Human reviewer response (null until the human acts)
    human_action     TEXT,             -- 'approved' | 'rejected' | 'modified'
    human_notes      TEXT,
    reviewed_at      TIMESTAMPTZ,
    -- Which raw rows were considered
    raw_row_ids      INTEGER[],
    -- Which resolved record was produced (null if decision was rejected)
    resolved_id      INTEGER REFERENCES app.facilities_resolved(id),
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
];

export async function initSchema(lb: LakebaseHandle) {
  for (const sql of APP_TABLES_SQL) {
    await lb.query(sql);
  }
  console.log('[schema] entity-resolver tables ready');
}
