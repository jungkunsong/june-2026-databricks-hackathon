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
  - What was verified ✓
  - What was corrected (with old → new value)
  - What is still uncertain ⚠
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