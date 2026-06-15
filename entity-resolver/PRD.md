# Product Requirements Document
## Entity Resolver — Medical Facility Record Verification Platform

**Version:** 2.1
**Date:** June 15, 2026
**Hackathon:** Databricks DAIS 2026

---



The Virtue Foundation dataset contains thousands of medical facility records sourced from multiple data providers. These raw records are incomplete, inconsistent, and unverified — and the problems go far beyond surface-level contact details.

The easy problems are well-known: phone numbers are malformatted, websites are dead, GPS coordinates don't match listed postcodes. But the harder and more consequential problems are in the clinical data itself. A facility's listed specialties may be incomplete or use non-standard terminology. Equipment and procedure fields are sparse, inconsistently named, or copied verbatim from a source that described a different facility entirely. Capability fields — the data that determines whether a patient can receive a specific treatment at a specific location — are often missing, ambiguous, or contradicted by other fields on the same record. These are the fields that matter most to downstream consumers: researchers modeling healthcare access, NGOs routing patients to appropriate care, and health systems making referral decisions.

Fixing contact details is mechanical. Fixing clinical data requires judgment. A reviewer needs to understand not just whether a phone number is valid, but whether the specialties listed are plausible for a facility of this type and size, whether the equipment inventory is consistent with the stated capabilities, and whether the procedures offered align with the specialties claimed. No single data point can be evaluated in isolation — the record has to be read as a whole.

The challenge is that the people closest to this data — local health coordinators, NGO field staff, regional administrators — are not data engineers. They can tell you whether a facility performs cardiac surgery, but they cannot write a SQL query to check it. They need a tool that does the analytical and verification work for them, surfaces the right questions, and lets them apply their domain knowledge where it actually matters.

Entity Resolver is that tool. It uses a multi-agent AI system to verify contact data, analyze clinical field consistency, and flag gaps and contradictions — then presents everything in plain language so a non-technical reviewer can make a confident, informed decision. The end result is a facility record that moves from the raw table into a clean, validated resolved table, with a full audit trail of what was verified, what was corrected, and why.

---

## 2. Objective

> **Give non-technical reviewers the AI-powered verification they need to confidently promote a raw facility record into a trusted, clean resolved record.**

The workflow is:

1. Reviewer selects a facility record from the queue and views its raw data
2. Reviewer explicitly clicks **"AI Agent Verification"** to initiate the verification session
3. The Supervisor agent starts, reads the record's populated fields, and dispatches the appropriate validator sub-agents in parallel
4. Each sub-agent independently verifies one dimension of the record (website, phone, location, Facebook, etc.) and reports its findings back **only to the Supervisor** — never directly to the user
5. The Supervisor interrogates each sub-agent's findings: accepts conclusive results, rejects or requests re-examination of inconclusive ones, and resolves conflicts between agents before surfacing anything to the human
6. The Supervisor surfaces only approved findings to the human reviewer — each with attached reasoning — or marks a field as **"unable to validate"** if confidence cannot be established after retries
7. The reviewer reads the findings, answers any Supervisor questions, and approves or modifies the resolution
8. The record is promoted from `facilities_raw` to `facilities_resolved` with clean, validated field values
9. The Supervisor writes a decision log entry documenting what was verified, what was corrected, and why

---

## 3. Goals

- A non-technical reviewer can process a raw facility record end-to-end without writing a query or opening a browser
- Verification is **explicitly initiated** by the reviewer — the agent does not start automatically on record selection
- Every result the reviewer sees has been approved by the Supervisor and carries attached reasoning; no raw sub-agent output ever reaches the user
- Results the Supervisor cannot validate are surfaced as **"unable to validate"** with an explanation — never silently dropped
- Every promoted record has at least one verified data point (website reachable, phone valid, location consistent, etc.)
- Every promotion is backed by a decision log entry written by the Supervisor agent
- The Supervisor acts as an intelligent intermediary — not just a pass-through — by evaluating sub-agent findings and pushing back when results are inconclusive
- The human is always in control of the final decision; the agents advise, the human approves

---

## 4. Non-Goals

- Fully automated promotion without human sign-off
- Real-time ingestion of new facility records (batch sync only, via notebook)
- Phone validation for non-Indian facilities (current scope: address_country = IN)
- A public-facing API for third-party consumers

---

## 5. Users

| Persona | Description |
|---|---|
| **Non-Technical Reviewer** | Primary user. No SQL or data engineering background. Works through the queue, reads Supervisor-approved findings in plain language, answers clarifying questions, and approves promotions. Never sees raw sub-agent output. |
| **Data Engineer** | Runs the sync notebook, monitors schema health, manages Lakebase. Occasional user of the raw SQL view for debugging. |
| **Hackathon Judge** | Evaluates the live demo — cares about the agent orchestration story, the human-in-the-loop interaction, and UI clarity. |

---

## 6. Core Workflow

```
  Queue
  ──────
  Reviewer browses raw facility records
  Selects one record to view its raw data
        │
        ▼
  Record Detail View
  ──────────────────
  Raw record fields displayed to reviewer
  Reviewer clicks "AI Agent Verification" to begin
        │
        ▼  [explicit user action required]
        │
        ▼
  Supervisor Agent starts
  ──────────────────────
  Reads the record's populated fields
  Dispatches relevant validator sub-agents in parallel
        │
        ├──► website-validator    (if websites field populated)
        ├──► phone-validator      (if phone_numbers populated)
        ├──► location-validator   (if lat/lon + postcode populated)
        ├──► facebook-validator   (if facebookLink populated)
        ├──► similarity-scorer    (always)
        └──► skill-matcher        (always)
        │
        ▼
  Sub-agents report findings to Supervisor  ◄──────────────────┐
  ─────────────────────────────────────────                     │
  Each agent returns structured results to the Supervisor only: │
  - What it checked                                             │
  - What it found                                               │
  - Whether the data point is verified, suspicious, or invalid  │
  - Any corrections it recommends                               │
  [Human reviewer never sees this layer]                        │
        │                                                       │
        ▼                                                       │
  Supervisor interrogates each finding                          │
  ────────────────────────────────────                          │
    if conclusive and consistent → approve for human presentation│
    if inconclusive or weak      → reject; ask sub-agent to re-examine ──┘
    if contradicts other finding → surface conflict to human as a question
    if exhausted retries         → mark as "unable to validate"
        │
        ▼
  Supervisor presents approved findings to human
  ───────────────────────────────────────────────
  Only Supervisor-approved content is shown. Each item is one of:
  - Verified Finding: field, status, plain-language result, Supervisor reasoning, correction if any
  - Unable to Validate: field, explanation of why confidence could not be established
  - Question for Reviewer: targeted question when a conflict or low-confidence field needs human input
        │
        ▼
  Human reviewer responds
  ───────────────────────
  Answers questions, approves corrections, or overrides recommendations
  May request further investigation on a specific field
        │
        ▼
  Record promoted
  ───────────────
  facilities_raw → facilities_resolved
  Clean field values written
  Supervisor writes decision log entry
```

---

## 7. Agent System

### 7.1 Supervisor (config/agents/supervisor/)

The orchestrator, evaluator, and summarizer. The Supervisor is the **sole interface between the agent layer and the human reviewer** — it actively evaluates sub-agent findings and decides what to do with them before presenting anything to the human.

**Responsibilities:**
- Dispatch the right sub-agents based on which fields are populated on the record
- Interrogate each sub-agent's output: accept, reject, or request follow-up
- Resolve conflicts between sub-agents before surfacing anything to the human
- Attach its own reasoning to every finding it approves for human presentation
- Mark findings as "unable to validate" when confidence cannot be established after retries
- Ask the human targeted questions when confidence is insufficient or a conflict cannot be resolved internally
- Write the decision log entry when the human approves promotion

**Supervisor decision loop:**
```
for each sub-agent result:
  if result is conclusive and consistent → approve; attach Supervisor reasoning; present to human
  if result is inconclusive             → reject; ask sub-agent to re-examine with specific instructions
    → if still inconclusive after retry → mark as "unable to validate"; explain to human
  if result contradicts other findings  → surface the conflict to the human explicitly as a question
```

**Human-facing output rules:**
- The human **never** sees raw sub-agent output
- Every finding presented to the human carries the Supervisor's attached reasoning
- Every field the Supervisor could not validate is explicitly surfaced as "unable to validate" — findings are never silently dropped

**Promotion outcomes written to decision log:**
- `verified` — record promoted with no field changes; all checked data points confirmed
- `corrected` — record promoted with one or more field values updated based on agent findings
- `partial` — record promoted but one or more fields remain unverifiable; flagged in log
- `deferred` — record not promoted; requires manual investigation beyond agent capability

### 7.2 Validator Sub-agents (config/agents/validators/)

Each validator is responsible for one dimension of the record. They report findings back **only to the Supervisor** — they do not interact with the human directly. The Supervisor may send a sub-agent back to re-examine a finding before accepting it.

| Agent | Checks | Verified When | Correction Suggested When |
|---|---|---|---|
| `website-validator` | websites field | HTTP 200 or clean redirect | Domain unreachable, or domain does not match facility name |
| `phone-validator` | phone_numbers field | Matches TRAI mobile format | Literal null string, wrong digit count, invalid prefix |
| `location-validator` | latitude, longitude, address_zipOrPostcode | Coordinates within 20km of pincode centroid | Distance > 50km between coordinates and postcode |
| `facebook-validator` | facebookLink field | og:title matches facility name | og:title refers to a different entity, or page not found |

**Sub-agent response contract (returned to Supervisor only):**
```
{
  agent:      string            // agent identifier
  field:      string            // field that was checked
  status:     "verified" | "suspicious" | "invalid" | "inconclusive"
  evidence:   string            // what the agent actually observed
  correction: { old, new }      // only if status is "suspicious" or "invalid"
  confidence: 0.0 – 1.0
}
```

If a sub-agent returns `inconclusive` or `confidence < 0.6`, the Supervisor will request a follow-up pass before approving anything for human presentation.

### 7.3 Analysis Sub-agents

These agents analyze the record's internal consistency and richness rather than calling external services.

| Agent | Role |
|---|---|
| `evidence-fetcher` | Retrieves and formats the full raw record for the Supervisor and human to read |
| `similarity-scorer` | Scores name, address, and geo fields for internal consistency |
| `skill-matcher` | Normalises and validates specialties, procedures, and equipment against known terminology |

---

## 8. Resolution Path and Decision Log

### What "promotion" means

When a reviewer approves a resolution, the Supervisor:

1. Writes a clean record to `app.facilities_resolved` using verified field values, applying any corrections the agents recommended, and incorporating any overrides the human made
2. Immediately writes an `app.decision_log` entry with:

```
decision_log entry fields:
  - facility_name       the name of the facility
  - raw_record_id       source row from facilities_raw
  - outcome             verified | corrected | partial | deferred
  - confidence          0.0 to 1.0 score from the Supervisor
  - reasoning           prose summary of why this outcome was chosen
  - agents_consulted    list of sub-agents that ran
  - verifications       per-field: { field, status, old_value, new_value, agent, supervisor_reasoning }
  - human_notes         anything the reviewer typed
  - decided_at          timestamp
```

### Field-level verification statuses

| Status | Meaning |
|---|---|
| `verified` | Agent confirmed the value is correct |
| `corrected` | Agent found an issue; value was updated before promotion |
| `unverifiable` | Agent could not confirm or deny; promoted as-is with flag |
| `skipped` | Field was empty or agent was not dispatched |

---

## 9. Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                     Databricks AppKit App                   │
│                                                             │
│  ┌──────────────┐    ┌──────────────────────────────────┐  │
│  │  React SPA   │    │         Express Server            │  │
│  │  (Vite)      │◄──►│  /api/tasks  /api/facilities      │  │
│  │              │    │  /api/decisions  /api/messages    │  │
│  └──────────────┘    └──────────────┬───────────────────┘  │
│                                     │                       │
│                     ┌───────────────▼───────────────────┐  │
│                     │        Lakebase (Postgres)         │  │
│                     │  app.resolution_tasks              │  │
│                     │  app.decision_log                  │  │
│                     │  app.messages                      │  │
│                     │  app.facilities_resolved           │  │
│                     │  app.entity_overrides              │  │
│                     └───────────────┬───────────────────┘  │
│                                     │ read-only             │
│                     ┌───────────────▼───────────────────┐  │
│                     │  virtue_foundation_dataset         │  │
│                     │  .facilities_raw                   │  │
│                     └───────────────────────────────────┘  │
│                                                             │
│  ┌──────────────────────────────────────────────────────┐  │
│  │                   Agent Layer                         │  │
│  │                                                       │  │
│  │  supervisor                                           │  │
│  │    ├── evidence-fetcher     (always)                  │  │
│  │    ├── similarity-scorer    (always)                  │  │
│  │    ├── skill-matcher        (always)                  │  │
│  │    └── validators/          (conditional on fields)   │  │
│  │        ├── website-validator                          │  │
│  │        ├── phone-validator                            │  │
│  │        ├── location-validator                         │  │
│  │        └── facebook-validator                         │  │
│  └──────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
```

---

## 10. Data Model

### Read-only source
- `virtue_foundation_dataset.facilities_raw` — raw, unverified facility records

### App-owned tables (Lakebase app schema)

| Table | Purpose |
|---|---|
| `app.resolution_tasks` | One row per record under review; tracks status (pending / in_progress / resolved / skipped) |
| `app.decision_log` | Append-only audit trail written by the Supervisor at promotion time; one entry per resolved record |
| `app.messages` | Full conversation thread per task; roles: user, supervisor, sub_agent. Sub-agent messages stored but never surfaced to the user directly. |
| `app.facilities_resolved` | Clean, validated records promoted from raw; the trusted output of the system |
| `app.entity_overrides` | Field-level corrections applied by the reviewer or agents before promotion |

---

## 11. UI Pages

| Route | Page | Description |
|---|---|---|
| `/` | **Queue** | List of raw facility records with status badges. Reviewer picks a record to start a resolution session. |
| `/resolve/:clusterId` | **Resolve** | The primary workspace. Shows the raw record on the left. The right panel is idle until the reviewer clicks **"AI Agent Verification"**. Once triggered, the panel shows only Supervisor-approved findings (each with attached reasoning), "unable to validate" notices, and targeted questions from the Supervisor. Reviewer reads findings, answers questions, and approves promotion. |
| `/decisions` | **Decisions** | Audit log of all promoted records with outcome badges and decision log entries. |
| `/lakebase` | **Lakebase** | Raw SQL interface for data engineers. |

### Resolve page — right panel states

| State | What the reviewer sees |
|---|---|
| **Idle** | "Click AI Agent Verification to begin" prompt with a button |
| **Running** | Progress indicator showing which agents are active; no findings shown until Supervisor approves them |
| **Findings ready** | Supervisor-approved findings, each with status badge and attached reasoning; "unable to validate" notices for unresolved fields; any questions from the Supervisor |
| **Awaiting response** | Input field for the reviewer to answer a Supervisor question or provide a manual override |
| **Ready to promote** | Summary of all findings; Approve / Defer buttons |

---

## 12. Key Technical Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Agent framework | Databricks AppKit agents plugin (beta) | Native integration with Databricks serving endpoints; markdown + code agent composition |
| Explicit verification trigger | Reviewer clicks "AI Agent Verification" | Prevents accidental agent runs; makes the human's intent explicit before compute is consumed |
| Supervisor as strict gatekeeper | All sub-agent output filtered and approved by Supervisor before human sees it | Prevents weak or contradictory sub-agent output from reaching the reviewer unchecked |
| Mandatory reasoning on findings | Supervisor attaches its own reasoning to every approved finding | Reviewer can assess trustworthiness; reasoning captured verbatim in the decision log |
| "Unable to validate" as first-class outcome | Unresolvable fields surfaced explicitly, never silently dropped | Reviewer is always fully informed; no false confidence from missing data |
| Database | Lakebase (Postgres-compatible) | Transactional workflow state alongside Unity Catalog analytics data |
| Decision log written by agent | Supervisor writes the log entry, not the UI | The agent's reasoning is captured verbatim; no translation loss |
| Facebook validation | Playwright headless Chromium | Only method that reliably extracts og:title without a session cookie or API token |
| Website validation | Native fetch with AbortController | Node 18+ built-in; no extra dependency; HEAD fallback to GET for 405 responses |
| Phone validation | Pure TypeScript regex | TRAI rules are deterministic; no external API needed |
| Location validation | Markdown agent (SQL reasoning) | Haversine logic expressed as SQL against the India Post pincode directory |
| Frontend | React + Vite + Tailwind + shadcn/ui | Standard AppKit client stack; accessible to non-technical users |

---

## 14. Implementation Status

> Last updated: June 15, 2026

### ✅ Complete

| Area | What's done |
|---|---|
| **Queue page** (`/`) | Lists clusters from `facilities_raw`, paginated, searchable. "Review" button navigates to `/resolve/:clusterId`. No eager task creation. |
| **Resolve page** (`/resolve/:clusterId`) | Two-panel layout: left = raw record fields (grouped by Identity / Location / Contact / Clinical / Sources), right = idle state with prominent "AI Agent Verification" button. Task created only when button is clicked. |
| **Explicit trigger** | Agent does not start on record selection. Task is created and `in_progress` status set only when reviewer clicks "AI Agent Verification". |
| **AgentChat component** | `started` prop gates the initial message and input. Component renders in idle state until `started=true`. |
| **Supervisor agent prompt** | Written at `config/agents/supervisor/agent.md`. Registered as default agent. Sub-agents listed in frontmatter. Initial message from `ResolvePage` now includes `row_id` so the supervisor can call `evidence-fetcher` directly. |
| **Sub-agent prompts** | All written: `evidence-fetcher`, `similarity-scorer`, `skill-matcher`, `website-validator`, `phone-validator`, `location-validator`, `facebook-validator`. |
| **Code agents** | `website-validator`, `phone-validator`, `facebook-validator` implemented as TypeScript `createAgent` code agents with tool functions. |
| **Server routes** | Tasks (CRUD), messages, decisions, promotion (`POST /api/tasks/:id/resolved`), decision-log, overrides, facilities (clusters, records, single row). |
| **Database schema** | All tables defined: `resolution_tasks`, `decision_log`, `messages`, `facilities_resolved`, `entity_overrides`. |
| **Decisions page** (`/decisions`) | Audit log table showing all decisions with outcome badges, confidence bars, and timestamps. |

### ✅ Blockers — all resolved

| # | Issue | Fix applied |
|---|---|---|
| **1** | **Client/server `raw_row_id` mismatch** | `POST /api/tasks` now accepts `{ cluster_id }`, looks up the representative `raw_row_id` from `facilities_raw`, and upserts the task. `ResolutionTask` type updated to `raw_row_id + facility_name`. Redundant `updateStatus` call removed from `ResolvePage`. |
| **2** | **Sub-agent tool calls visible to user** | `AgentChat` now returns `null` for all `role === 'tool'` messages. Only `user` and `assistant` messages render. `Wrench` import removed. |
| **3** | **`config/agents/validators/agent.md` is empty** | File does not exist on disk — was only open in editor. No action needed. |

### ⚠️ In Progress (another agent working on this)

| Area | Status |
|---|---|
| **Promotion UI** | `POST /api/tasks/:id/resolved` exists on server. Client-side "Approve / Defer" buttons + golden record summary in `ResolvePage` not yet built. |

### 🔜 Next priorities (after promotion UI)

| # | Item | Why it matters |
|---|---|---|
| **1** | **Supervisor prompt: Step 2 wording** | Supervisor currently says "Call evidence-fetcher with the `row_id`" — the initial message now provides this explicitly. Verify the supervisor reliably picks it up and dispatches validators in parallel, not sequentially. |
| **2** | **DecisionsPage outcome vocabulary** | `OUTCOME_CONFIG` in `DecisionsPage.tsx` uses old outcome keys (`merged`, `split`, `confirmed_duplicate`, `confirmed_distinct`). The PRD defines `verified`, `corrected`, `partial`, `deferred`. These need to match what the supervisor actually writes. |
| **3** | **AgentChat: "Verifying…" spinner accuracy** | The right panel header shows "Verifying…" spinner whenever `agentStarted` is true — including after the agent has finished. Should switch to a "Done" or idle state when the stream ends. |


---

## 13. Out-of-Scope / Future Work

- **Automated promotion** — high-confidence records (confidence > 0.95) promoted without human review
- **International phone validation** — current rules cover Indian mobile numbers only
- **Landline validation** — TRAI landline rules require STD-code-aware parsing; currently flagged as WARNING
- **Email validation** — email field exists on raw records; no validator built yet
- **Batch export** — pushing resolved records back to Unity Catalog as a Delta table
- **Re-verification** — triggering a new validation pass on a previously resolved record when source data changes
