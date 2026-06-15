# Product Requirements Document
## Entity Resolver — Medical Facility Record Verification Platform

**Version:** 2.0
**Date:** June 15, 2026
**Hackathon:** Databricks DAIS 2026

---

## 1. Problem Statement

The Virtue Foundation dataset contains thousands of medical facility records sourced from multiple data providers. These raw records are incomplete, inconsistent, and unverified — phone numbers are malformatted, websites are dead, GPS coordinates don't match listed postcodes, and Facebook links point to the wrong pages. Downstream consumers of this data (researchers, NGOs, patients) cannot trust it.

The challenge is that fixing this data requires judgment, not just rules. A non-technical reviewer needs to look at a record, understand what's wrong with it, and decide what the correct values should be — but they don't have the tools to independently verify a phone number format, check if a website is live, or calculate whether a GPS coordinate matches a postcode. That verification work needs to be done for them.

Entity Resolver is a **non-technical user tool** that automates the verification work through a multi-agent AI system, presents findings in plain language, and guides the reviewer to a confident decision. The end result is a facility record that moves from the raw table into a clean, validated resolved table — with a full audit trail of how and why each decision was made.

---

## 2. Objective

> **Give non-technical reviewers the AI-powered verification they need to confidently promote a raw facility record into a trusted, clean resolved record.**

The workflow is:

1. Reviewer selects a facility record from the queue
2. The Supervisor agent automatically dispatches validator sub-agents against that record's data
3. Each sub-agent independently verifies one dimension of the record (website, phone, location, Facebook, etc.) and reports its findings back to the Supervisor
4. The Supervisor reviews the sub-agent findings, agrees or disagrees, may ask a sub-agent to continue investigating, and synthesizes a recommended resolution path
5. The Supervisor surfaces questions or requests clarification from the human reviewer when confidence is low
6. The reviewer reads the findings, answers any questions, and approves or modifies the resolution
7. The record is promoted from `facilities_raw` to `facilities_resolved` with clean, validated field values
8. The Supervisor writes a decision log entry documenting what was verified, what was corrected, and why

---

## 3. Goals

- A non-technical reviewer can process a raw facility record end-to-end without writing a query or opening a browser
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
| **Non-Technical Reviewer** | Primary user. No SQL or data engineering background. Works through the queue, reads agent findings in plain language, answers clarifying questions, and approves promotions. |
| **Data Engineer** | Runs the sync notebook, monitors schema health, manages Lakebase. Occasional user of the raw SQL view for debugging. |
| **Hackathon Judge** | Evaluates the live demo — cares about the agent orchestration story, the human-in-the-loop interaction, and UI clarity. |

---

## 6. Core Workflow

```
  Queue
  ──────
  Reviewer browses raw facility records
  Selects one record to resolve
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
  Sub-agents report findings
  ──────────────────────────
  Each agent returns structured results:
  - What it checked
  - What it found
  - Whether the data point is verified, suspicious, or invalid
  - Any corrections it recommends
        │
        ▼
  Supervisor evaluates
  ────────────────────
  Reviews each sub-agent's findings
  May agree and incorporate, OR
  May disagree and ask the sub-agent to re-examine, OR
  May flag the finding as inconclusive and ask the human
        │
        ▼
  Supervisor presents resolution path
  ───────────────────────────────────
  Structured summary in plain language:
  - What was verified
  - What was corrected (with old to new value)
  - What is still uncertain
  - Recommended action with confidence score
  - Specific questions for the human (if confidence < 0.8)
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

The orchestrator, evaluator, and summarizer. The Supervisor is not a passive router — it actively evaluates sub-agent findings and decides what to do with them before presenting anything to the human.

**Responsibilities:**
- Dispatch the right sub-agents based on which fields are populated on the record
- Evaluate each sub-agent's output: accept, reject, or request follow-up
- Synthesize all findings into a plain-language resolution path
- Ask the human targeted questions when confidence is insufficient
- Write the decision log entry when the human approves promotion

**Supervisor decision loop:**
```
for each sub-agent result:
  if result is conclusive and consistent → incorporate into recommendation
  if result is inconclusive             → ask sub-agent to re-examine or flag for human
  if result contradicts other findings  → surface the conflict to the human explicitly
```

**Promotion outcomes written to decision log:**
- `verified` — record promoted with no field changes; all checked data points confirmed
- `corrected` — record promoted with one or more field values updated based on agent findings
- `partial` — record promoted but one or more fields remain unverifiable; flagged in log
- `deferred` — record not promoted; requires manual investigation beyond agent capability

### 7.2 Validator Sub-agents (config/agents/validators/)

Each validator is responsible for one dimension of the record. They report findings back to the Supervisor — they do not interact with the human directly.

| Agent | Checks | Verified When | Correction Suggested When |
|---|---|---|---|
| `website-validator` | websites field | HTTP 200 or clean redirect | Domain unreachable, or domain does not match facility name |
| `phone-validator` | phone_numbers field | Matches TRAI mobile format | Literal null string, wrong digit count, invalid prefix |
| `location-validator` | latitude, longitude, address_zipOrPostcode | Coordinates within 20km of pincode centroid | Distance > 50km between coordinates and postcode |
| `facebook-validator` | facebookLink field | og:title matches facility name | og:title refers to a different entity, or page not found |

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
  - verifications       per-field: { field, status, old_value, new_value, agent }
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
| `app.messages` | Full conversation thread per task; roles: user, supervisor, sub_agent |
| `app.facilities_resolved` | Clean, validated records promoted from raw; the trusted output of the system |
| `app.entity_overrides` | Field-level corrections applied by the reviewer or agents before promotion |

---

## 11. UI Pages

| Route | Page | Description |
|---|---|---|
| `/` | **Queue** | List of raw facility records with status badges. Reviewer picks a record to start a resolution session. |
| `/resolve/:taskId` | **Resolve** | The primary workspace. Shows the raw record on the left; the Supervisor agent chat on the right. Reviewer reads findings, answers questions, and approves promotion. |
| `/decisions` | **Decisions** | Audit log of all promoted records with outcome badges and decision log entries. |
| `/lakebase` | **Lakebase** | Raw SQL interface for data engineers. |

---

## 12. Key Technical Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Agent framework | Databricks AppKit agents plugin (beta) | Native integration with Databricks serving endpoints; markdown + code agent composition |
| Supervisor as evaluator | Supervisor actively accepts/rejects sub-agent findings | Prevents bad sub-agent output from reaching the human unchecked |
| Database | Lakebase (Postgres-compatible) | Transactional workflow state alongside Unity Catalog analytics data |
| Decision log written by agent | Supervisor writes the log entry, not the UI | The agent's reasoning is captured verbatim; no translation loss |
| Facebook validation | Playwright headless Chromium | Only method that reliably extracts og:title without a session cookie or API token |
| Website validation | Native fetch with AbortController | Node 18+ built-in; no extra dependency; HEAD fallback to GET for 405 responses |
| Phone validation | Pure TypeScript regex | TRAI rules are deterministic; no external API needed |
| Location validation | Markdown agent (SQL reasoning) | Haversine logic expressed as SQL against the India Post pincode directory |
| Frontend | React + Vite + Tailwind + shadcn/ui | Standard AppKit client stack; accessible to non-technical users |

---

## 13. Out-of-Scope / Future Work

- **Automated promotion** — high-confidence records (confidence > 0.95) promoted without human review
- **International phone validation** — current rules cover Indian mobile numbers only
- **Landline validation** — TRAI landline rules require STD-code-aware parsing; currently flagged as WARNING
- **Email validation** — email field exists on raw records; no validator built yet
- **Batch export** — pushing resolved records back to Unity Catalog as a Delta table
- **Re-verification** — triggering a new validation pass on a previously resolved record when source data changes
