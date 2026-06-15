# Product Requirements Document
## Entity Resolver — Medical Facility Deduplication Platform

**Version:** 1.0  
**Date:** June 15, 2026  
**Hackathon:** Databricks DAIS 2026  

---

## 1. Problem Statement

The Virtue Foundation dataset contains thousands of medical facility records sourced from multiple data providers. Because each provider independently crawls, scrapes, or submits facility data, the same real-world hospital or clinic frequently appears as multiple distinct records with slightly different names, addresses, phone numbers, or websites. This duplication degrades downstream analytics, inflates facility counts, and makes it impossible to build a reliable golden record for any given facility.

Manual deduplication at this scale is impractical. A purely automated approach lacks the contextual judgment needed for ambiguous cases — a hospital that moved, a chain with two branches in the same city, or a data entry error that looks like a duplicate. The solution requires a **human-in-the-loop AI workflow** that does the heavy analytical lifting while keeping a human accountable for the final decision.

---

## 2. Goals

- Reduce duplicate facility records in the Virtue Foundation dataset to zero confirmed duplicates
- Give human reviewers a single, evidence-rich interface to make merge/split decisions confidently
- Produce a durable, auditable golden record for every resolved cluster
- Demonstrate a multi-agent orchestration pattern on Databricks AppKit at DAIS 2026

---

## 3. Non-Goals

- Automated resolution without human sign-off (confidence may be high, but a human always confirms)
- Real-time ingestion of new facility records (batch sync only, via notebook)
- Support for non-Indian facilities in the phone validation agent (current scope: `address_country = 'IN'`)
- A public-facing API for third-party consumers

---

## 4. Users

| Persona | Description |
|---|---|
| **Data Reviewer** | Primary user. Works through the resolution queue, reads agent findings, and makes merge/split decisions. |
| **Data Engineer** | Runs the sync notebook, monitors schema health, and manages Lakebase. |
| **Hackathon Judge** | Evaluates the live demo — cares about the agent orchestration story and UI polish. |

---

## 5. Architecture Overview

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
│                          ┌──────────▼──────────┐           │
│                          │   Lakebase (Postgres) │           │
│                          │   app.resolution_tasks│           │
│                          │   app.decisions       │           │
│                          │   app.messages        │           │
│                          │   app.facilities_     │           │
│                          │     resolved          │           │
│                          │   app.entity_overrides│           │
│                          └──────────┬────────────┘          │
│                                     │ (read-only)           │
│                          ┌──────────▼────────────┐          │
│                          │  virtue_foundation_    │          │
│                          │  dataset.facilities_raw│          │
│                          └───────────────────────┘          │
│                                                             │
│  ┌──────────────────────────────────────────────────────┐  │
│  │                   Agent Layer                         │  │
│  │                                                       │  │
│  │  planner ──► supervisor ──► evidence-fetcher          │  │
│  │                         ├── similarity-scorer         │  │
│  │                         ├── skill-matcher             │  │
│  │                         ├── validators/               │  │
│  │                         │   ├── website-validator     │  │
│  │                         │   ├── facebook-validator    │  │
│  │                         │   ├── location-validator    │  │
│  │                         │   └── phone-validator       │  │
│  └──────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
```

**Data flow:**
1. A sync notebook copies raw facility records from Unity Catalog into `virtue_foundation_dataset.facilities_raw` in Lakebase
2. A pre-existing clustering step groups records into candidate duplicate clusters by `cluster_id`
3. The app surfaces those clusters as a review queue
4. The reviewer opens a cluster → the supervisor agent dispatches all sub-agents in parallel → findings are presented in the chat UI
5. The reviewer makes a decision → written to `app.decisions` and `app.facilities_resolved`

---

## 6. Agent System

### 6.1 Supervisor (`config/agents/supervisor/`)
The orchestrator and summarizer. Marked `default: true` so it is the entry point for the chat UI. On task start it dispatches all relevant sub-agents in parallel, synthesizes their outputs into a structured findings report, and presents a recommendation with confidence score to the human reviewer.

**Dispatches conditionally:**
- Always: evidence-fetcher, similarity-scorer, skill-matcher
- If `websites` populated: website-validator
- If `facebookLink` populated: facebook-validator
- If `latitude`/`longitude` populated: location-validator
- If `phone_numbers` populated: phone-validator

**Decision outcomes:** `merged` | `split` | `confirmed_duplicate` | `confirmed_distinct` | `deferred`

### 6.2 Core Sub-agents

| Agent | Type | Description |
|---|---|---|
| `evidence-fetcher` | Markdown | Calls `/api/facilities/cluster/:clusterId`, formats all raw records as a side-by-side markdown table, flags differing fields with ⚠️ and identical fields with ✓ |
| `similarity-scorer` | Markdown | Computes pairwise name similarity (Levenshtein + token overlap), address similarity (city/state/zip), and geo proximity; returns scores 0–1 per dimension |
| `skill-matcher` | Markdown | Normalises specialty/procedure/equipment terminology, computes Jaccard overlap between records, flags disjoint skill sets (split signal) and shared rare specialties (merge signal) |

### 6.3 Validator Sub-agents (`config/agents/validators/`)

Each validator corresponds directly to a validated methodology document and is backed by a TypeScript code agent with live tool execution.

| Agent | Code Agent | Method | Merge Signal | Split Signal |
|---|---|---|---|---|
| `website-validator` | `server/agents/website-validator.ts` | HTTP HEAD/GET with 5s timeout; classifies VERIFIED / REDIRECTS / MISCONFIGURED / UNREACHABLE | Shared domain across records | Domain mismatch (e.g. Wockhardt record → fortishealthcare.com) |
| `facebook-validator` | `server/agents/facebook-validator.ts` | Headless Chromium (Playwright) loads page, extracts `og:title`, fuzzy-matches via substring + Jaccard | Shared Facebook page | og:title refers to a different entity |
| `location-validator` | Markdown (SQL reasoning) | Haversine distance between facility coordinates and India Post pincode centroid; thresholds: MATCH ≤20km, CLOSE ≤50km, MISMATCH >50km | Both records MATCH same pincode | Records >50km apart |
| `phone-validator` | `server/agents/phone-validator.ts` | TRAI mobile format validation (prefixes 6–9, 10 digits); flags literal `"null"` strings and digit-count anomalies | Exact same number on multiple records | — |

---

## 7. Data Model

### Read-only source (Unity Catalog)
- `virtue_foundation_dataset.facilities_raw` — raw facility records with `cluster_id` assigned by upstream clustering

### App-owned tables (Lakebase `app` schema)

| Table | Purpose |
|---|---|
| `app.resolution_tasks` | One row per cluster under review; tracks `status` (pending / in_progress / resolved / skipped) |
| `app.decisions` | Append-only log of resolution outcomes with `golden_record` JSON, `confidence`, and `reasoning` |
| `app.messages` | Full conversation thread per task; roles: `user`, `supervisor`, `sub_agent` |
| `app.facilities_resolved` | Golden records written after a MERGE or CONFIRMED_DUPLICATE decision |
| `app.entity_overrides` | Field-level corrections applied by the reviewer before finalizing a golden record |

---

## 8. UI Pages

| Route | Page | Description |
|---|---|---|
| `/` | **Queue** | Paginated list of all clusters with search. Shows status badge per cluster (pending / in_progress / resolved / skipped). "Start Resolution" creates a task and navigates to the resolve view. |
| `/resolve/:taskId` | **Resolve** | Split-pane view: left shows side-by-side record cards with differing fields highlighted; right is the agent chat. Reviewer reads agent findings and submits a decision. |
| `/decisions` | **Decisions** | Audit log of all completed resolutions with outcome summary cards (merged / split / confirmed_duplicate / confirmed_distinct / deferred). |
| `/lakebase` | **Lakebase** | Raw SQL query interface for power users and debugging. |

---

## 9. Key Technical Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Agent framework | Databricks AppKit `agents` plugin (beta) | Native integration with Databricks serving endpoints; markdown + code agent composition |
| Database | Lakebase (Postgres-compatible) | Transactional workflow state alongside Unity Catalog analytics data |
| Facebook validation | Playwright headless Chromium | Only method that reliably extracts `og:title` without a session cookie or API token |
| Website validation | Native `fetch` with AbortController | Node 18+ built-in; no extra dependency; HEAD fallback to GET for 405 responses |
| Phone validation | Pure TypeScript regex | TRAI rules are deterministic; no external API needed |
| Location validation | Markdown agent (SQL reasoning) | Haversine logic is best expressed as SQL against the India Post pincode directory; no live HTTP call required |
| Frontend | React + Vite + Tailwind + shadcn/ui | Standard AppKit client stack |

---

## 10. Out-of-Scope / Future Work

- **Automated bulk resolution** — high-confidence clusters (e.g. confidence > 0.95) could be auto-resolved without human review
- **International phone validation** — current rules cover Indian mobile numbers only
- **Landline validation** — TRAI landline rules require STD-code-aware parsing; currently flagged as WARNING
- **Re-clustering feedback loop** — resolved decisions could feed back into the clustering model to improve future cluster quality
- **Email validation** — an `email` field exists on facility records; no validator built yet
- **Batch export** — exporting the golden records back to Unity Catalog as a Delta table
