import { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate, Link, useLocation } from 'react-router';
import {
  ArrowLeft,
  Bot,
  Building2,
  CheckCircle2,
  Clock,
  Loader2,
  MapPin,
  Pencil,
  Phone,
  Stethoscope,
  Wrench,
  ChevronDown,
  ChevronUp,
  Sparkles,
  X,
  Check,
} from 'lucide-react';
import { clustersApi, tasksApi, promoteApi, type FacilityRecord, type ResolutionTask } from '../lib/api';
import { AgentChat } from './agents/AgentChat';

// ── Types ─────────────────────────────────────────────────────────────────────

interface FieldProposal {
  field: string;
  label: string;
  value: string | number | null;
  old_value?: string | null;
  status: 'verified' | 'corrected' | 'unverifiable';
  agent: string | null;
  note: string;
}

interface PromotionProposal {
  outcome: 'verified' | 'corrected' | 'partial' | 'deferred';
  confidence: number;
  reasoning: string;
  agents_consulted: string[];
  fields: FieldProposal[];
}

// Per-field reviewer decision: 'accept' keeps the proposed value, 'edit' uses overrideValue
interface FieldDecision {
  action: 'accept' | 'edit';
  overrideValue: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Parse the last PROMOTION_PROPOSAL: JSON block from the supervisor's message stream. */
function parseProposal(messages: { role: string; content: string }[]): PromotionProposal | null {
  // Walk messages in reverse to find the last assistant message containing the marker
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== 'assistant') continue;
    const marker = 'PROMOTION_PROPOSAL:';
    const idx = m.content.lastIndexOf(marker);
    if (idx === -1) continue;
    const jsonStr = m.content.slice(idx + marker.length).trim();
    // Extract the first complete JSON object
    try {
      const end = findJsonEnd(jsonStr, 0);
      if (end === -1) continue;
      const parsed = JSON.parse(jsonStr.slice(0, end + 1)) as PromotionProposal;
      if (parsed.fields && Array.isArray(parsed.fields)) return parsed;
    } catch {
      // malformed — keep looking
    }
  }
  return null;
}

/** Find the index of the closing } that matches the opening { at `start`. */
function findJsonEnd(s: string, start: number): number {
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (escape) { escape = false; continue; }
    if (c === '\\' && inString) { escape = true; continue; }
    if (c === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return i; }
  }
  return -1;
}

function FieldRow({ label, value }: { label: string; value: string | number | null | undefined }) {
  if (value === null || value === undefined || value === '') return null;
  return (
    <div className="grid grid-cols-[140px_1fr] gap-2 py-1.5 border-b border-border/50 last:border-0">
      <span className="text-xs font-medium text-muted-foreground truncate">{label}</span>
      <span className="text-xs text-[#0B2026] break-words">{String(value)}</span>
    </div>
  );
}

function Section({ title, icon, children, defaultOpen = true }: {
  title: string;
  icon: React.ReactNode;
  children: React.ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="rounded-lg border border-border bg-white overflow-hidden">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between px-4 py-2.5 text-left hover:bg-muted/40 transition-colors"
      >
        <span className="flex items-center gap-2 text-sm font-semibold text-[#0B2026]">
          {icon}
          {title}
        </span>
        {open ? <ChevronUp className="h-3.5 w-3.5 text-muted-foreground" /> : <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />}
      </button>
      {open && <div className="px-4 pb-3 pt-1">{children}</div>}
    </div>
  );
}

function buildInitialMessage(_clusterId: string, records: FacilityRecord[]): string {
  const primary = records[0];
  const rowId = primary?.row_id;
  const names = [...new Set(records.map((r) => r.name).filter(Boolean))].join(', ');
  const recordWord = records.length === 1 ? 'record' : 'records';
  return (
    `Verify **${names}** (${records.length} source ${recordWord}, row_id: ${rowId}).`
  );
}

// ── Field approval table ──────────────────────────────────────────────────────

const STATUS_STYLE: Record<string, string> = {
  verified:    'text-green-700 bg-green-50 border-green-200',
  corrected:   'text-blue-700 bg-blue-50 border-blue-200',
  unverifiable:'text-amber-700 bg-amber-50 border-amber-200',
};

const STATUS_ICON: Record<string, React.ReactNode> = {
  verified:    <Check className="h-3 w-3" />,
  corrected:   <Pencil className="h-3 w-3" />,
  unverifiable:<Clock className="h-3 w-3" />,
};

function FieldApprovalTable({
  proposal,
  decisions,
  onDecisionChange,
  disabled,
}: {
  proposal: PromotionProposal;
  decisions: Record<string, FieldDecision>;
  onDecisionChange: (field: string, d: FieldDecision) => void;
  disabled: boolean;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  const [editBuf, setEditBuf] = useState('');

  function startEdit(f: FieldProposal) {
    setEditing(f.field);
    setEditBuf(String(decisions[f.field]?.action === 'edit'
      ? decisions[f.field].overrideValue
      : (f.value ?? '')));
  }

  function commitEdit(field: string) {
    onDecisionChange(field, { action: 'edit', overrideValue: editBuf });
    setEditing(null);
  }

  function cancelEdit(field: string, f: FieldProposal) {
    // If they never saved an edit, revert to accept
    if (decisions[field]?.action !== 'edit') {
      onDecisionChange(field, { action: 'accept', overrideValue: '' });
    }
    setEditing(null);
    // restore buf to current decision value
    setEditBuf(String(f.value ?? ''));
  }

  return (
    <div className="space-y-1.5">
      {/* Outcome + confidence header */}
      <div className="flex items-center justify-between px-1 pb-1">
        <span className="text-xs font-semibold text-[#0B2026]">
          Proposed outcome:{' '}
          <span className={`font-bold ${
            proposal.outcome === 'verified' ? 'text-green-700' :
            proposal.outcome === 'corrected' ? 'text-blue-700' :
            proposal.outcome === 'partial' ? 'text-amber-700' :
            'text-gray-600'
          }`}>{proposal.outcome}</span>
        </span>
        <span className="text-xs text-muted-foreground tabular-nums">
          Confidence: {Math.round(proposal.confidence * 100)}%
        </span>
      </div>

      {/* Reasoning */}
      {proposal.reasoning && (
        <p className="text-xs text-muted-foreground leading-relaxed px-1 pb-1 border-b border-border/50">
          {proposal.reasoning}
        </p>
      )}

      {/* Field rows */}
      <div className="rounded-md border border-border overflow-hidden">
        <table className="w-full text-xs">
          <thead className="bg-[#EEEDE9]">
            <tr>
              <th className="px-3 py-2 text-left font-semibold text-[#0B2026] w-28">Field</th>
              <th className="px-3 py-2 text-left font-semibold text-[#0B2026]">Proposed value</th>
              <th className="px-3 py-2 text-left font-semibold text-[#0B2026] w-20">Status</th>
              <th className="px-2 py-2 w-16" />
            </tr>
          </thead>
          <tbody className="divide-y divide-border/60">
            {proposal.fields.map((f) => {
              const dec = decisions[f.field] ?? { action: 'accept', overrideValue: '' };
              const displayValue = dec.action === 'edit' ? dec.overrideValue : String(f.value ?? '—');
              const isEditing = editing === f.field;
              const wasEdited = dec.action === 'edit';

              return (
                <tr key={f.field} className={`transition-colors ${wasEdited ? 'bg-blue-50/40' : 'hover:bg-[#F9F7F4]'}`}>
                  {/* Field label */}
                  <td className="px-3 py-2.5">
                    <div className="font-medium text-[#0B2026] leading-tight">{f.label}</div>
                    {f.agent && (
                      <div className="text-[10px] text-muted-foreground mt-0.5">{f.agent}</div>
                    )}
                  </td>

                  {/* Value / edit input */}
                  <td className="px-3 py-2.5">
                    {isEditing ? (
                      <input
                        autoFocus
                        value={editBuf}
                        onChange={(e) => setEditBuf(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') commitEdit(f.field);
                          if (e.key === 'Escape') cancelEdit(f.field, f);
                        }}
                        className="w-full rounded border border-[#FF3621]/50 bg-white px-2 py-1 text-xs text-[#0B2026] focus:outline-none focus:ring-1 focus:ring-[#FF3621]/40"
                      />
                    ) : (
                      <div>
                        {f.status === 'corrected' && f.old_value != null && !wasEdited && (
                          <span className="text-[10px] text-muted-foreground line-through mr-1.5">{f.old_value}</span>
                        )}
                        <span className={wasEdited ? 'text-blue-700 font-medium' : 'text-[#0B2026]'}>
                          {displayValue}
                        </span>
                        {f.note && (
                          <div className="text-[10px] text-muted-foreground mt-0.5 leading-snug">{f.note}</div>
                        )}
                      </div>
                    )}
                  </td>

                  {/* Status badge */}
                  <td className="px-3 py-2.5">
                    <span className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] font-medium ${
                      wasEdited
                        ? 'text-blue-700 bg-blue-50 border-blue-200'
                        : STATUS_STYLE[f.status] ?? 'text-gray-500 bg-gray-50 border-gray-200'
                    }`}>
                      {wasEdited ? <Pencil className="h-2.5 w-2.5" /> : STATUS_ICON[f.status]}
                      {wasEdited ? 'edited' : f.status}
                    </span>
                  </td>

                  {/* Edit / cancel controls */}
                  <td className="px-2 py-2.5">
                    {!disabled && (
                      isEditing ? (
                        <div className="flex gap-1">
                          <button
                            onClick={() => commitEdit(f.field)}
                            className="flex h-6 w-6 items-center justify-center rounded bg-green-600 text-white hover:bg-green-700"
                            title="Save"
                          >
                            <Check className="h-3 w-3" />
                          </button>
                          <button
                            onClick={() => cancelEdit(f.field, f)}
                            className="flex h-6 w-6 items-center justify-center rounded border border-border bg-white text-muted-foreground hover:bg-muted"
                            title="Cancel"
                          >
                            <X className="h-3 w-3" />
                          </button>
                        </div>
                      ) : (
                        <button
                          onClick={() => startEdit(f)}
                          className="flex h-6 w-6 items-center justify-center rounded border border-border bg-white text-muted-foreground hover:bg-muted hover:text-[#0B2026]"
                          title="Edit value"
                        >
                          <Pencil className="h-3 w-3" />
                        </button>
                      )
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export function ResolvePage() {
  const { clusterId } = useParams<{ clusterId: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const rerun = !!(location.state as { rerun?: boolean } | null)?.rerun;

  const [records, setRecords] = useState<FacilityRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [task, setTask] = useState<ResolutionTask | null>(null);
  const [agentStarted, setAgentStarted] = useState(false);
  const [starting, setStarting] = useState(false);
  const [agentStreaming, setAgentStreaming] = useState(false);

  // Messages exposed from AgentChat so we can parse the proposal
  const [agentMessages, setAgentMessages] = useState<{ role: string; content: string }[]>([]);

  // Derived proposal — re-parsed whenever messages change
  const [proposal, setProposal] = useState<PromotionProposal | null>(null);

  // Per-field reviewer decisions (keyed by field name)
  const [decisions, setDecisions] = useState<Record<string, FieldDecision>>({});

  const [humanNotes, setHumanNotes] = useState('');
  const [promoting, setPromoting] = useState(false);
  const [promoted, setPromoted] = useState<{ outcome: string; resolved_id: number } | null>(null);
  const [promoteError, setPromoteError] = useState<string | null>(null);

  const [initialMessage, setInitialMessage] = useState('');

  // Re-parse proposal whenever messages update
  useEffect(() => {
    if (agentStreaming) return; // wait until streaming finishes to avoid partial JSON
    const parsed = parseProposal(agentMessages);
    if (parsed) {
      setProposal(parsed);
      // Seed decisions with 'accept' for any new fields not yet in state
      setDecisions((prev) => {
        const next = { ...prev };
        for (const f of parsed.fields) {
          if (!(f.field in next)) {
            next[f.field] = { action: 'accept', overrideValue: '' };
          }
        }
        return next;
      });
    }
  }, [agentMessages, agentStreaming]);

  const load = useCallback(async () => {
    if (!clusterId) return;
    setLoading(true);
    setError(null);
    try {
      const recs = await clustersApi.records(clusterId);
      setRecords(recs);
      setInitialMessage(buildInitialMessage(clusterId, recs));
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, [clusterId]);

  useEffect(() => { void load(); }, [load]);

  // Auto-start agent when navigated here with rerun:true (from DecisionsPage)
  useEffect(() => {
    if (rerun && !loading && records.length > 0 && !agentStarted) {
      void handleStartVerification();
      // Clear the state so a refresh doesn't re-trigger
      window.history.replaceState({}, '');
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rerun, loading, records.length]);

  async function handleStartVerification() {
    if (!clusterId) return;
    setStarting(true);
    try {
      const created = await tasksApi.create(clusterId);
      setTask(created);
      setAgentStarted(true);
    } catch (e) {
      setError(String(e));
    } finally {
      setStarting(false);
    }
  }

  function handleDecisionChange(field: string, d: FieldDecision) {
    setDecisions((prev) => ({ ...prev, [field]: d }));
  }

  async function handleApprove() {
    if (!task || !proposal) return;
    setPromoting(true);
    setPromoteError(null);
    try {
      // Build resolved_fields from reviewer decisions
      const resolved_fields: Record<string, unknown> = {};
      for (const f of proposal.fields) {
        const dec = decisions[f.field] ?? { action: 'accept', overrideValue: '' };
        resolved_fields[f.field] = dec.action === 'edit' ? dec.overrideValue : f.value;
      }

      // Build verifications array reflecting reviewer edits
      const verifications = proposal.fields.map((f) => {
        const dec = decisions[f.field] ?? { action: 'accept', overrideValue: '' };
        const humanEdited = dec.action === 'edit';
        return {
          field: f.field,
          status: humanEdited ? 'corrected' : f.status,
          old_value: humanEdited ? String(f.value ?? '') : (f.old_value ?? null),
          new_value: humanEdited ? dec.overrideValue : null,
          agent: f.agent ?? undefined,
          supervisor_reasoning: f.note,
        };
      });

      // Determine final outcome — if reviewer edited any field, upgrade to 'corrected'
      const anyHumanEdit = Object.values(decisions).some((d) => d.action === 'edit');
      const finalOutcome: 'verified' | 'corrected' | 'partial' | 'deferred' =
        anyHumanEdit && proposal.outcome === 'verified' ? 'corrected' : proposal.outcome;

      const result = await promoteApi.promote({
        task_id: task.id,
        raw_row_id: task.raw_row_id,
        facility_name: task.facility_name ?? records[0]?.name ?? null,
        outcome: finalOutcome,
        confidence: proposal.confidence,
        reasoning: humanNotes.trim() || proposal.reasoning,
        agents_consulted: proposal.agents_consulted,
        verifications,
        human_notes: humanNotes.trim() || null,
        resolved_fields,
      });
      setPromoted({ outcome: finalOutcome, resolved_id: result.resolved_id });
    } catch (e) {
      setPromoteError(String(e));
    } finally {
      setPromoting(false);
    }
  }

  async function handleDefer() {
    if (!task) return;
    setPromoting(true);
    setPromoteError(null);
    try {
      const result = await promoteApi.promote({
        task_id: task.id,
        raw_row_id: task.raw_row_id,
        facility_name: task.facility_name ?? records[0]?.name ?? null,
        outcome: 'deferred',
        reasoning: humanNotes.trim() || 'Human reviewer deferred for manual investigation.',
        human_notes: humanNotes.trim() || null,
        resolved_fields: {},
      });
      setPromoted({ outcome: 'deferred', resolved_id: result.resolved_id });
    } catch (e) {
      setPromoteError(String(e));
    } finally {
      setPromoting(false);
    }
  }

  // ── Loading / error ───────────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="flex items-center justify-center py-24">
        <Loader2 className="h-6 w-6 animate-spin text-[#FF3621]" />
      </div>
    );
  }

  if (error || !clusterId) {
    return (
      <div className="space-y-4">
        <Link to="/" className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft className="h-3.5 w-3.5" /> Back to queue
        </Link>
        <div className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error ?? 'Cluster not found.'}
        </div>
      </div>
    );
  }

  const representativeName = records[0]?.name ?? clusterId;

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="flex flex-col gap-4 h-[calc(100vh-7rem)]">

      {/* Breadcrumb + status */}
      <div className="flex items-center justify-between flex-shrink-0">
        <div className="flex items-center gap-3">
          <button
            onClick={() => navigate('/')}
            className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
          >
            <ArrowLeft className="h-3.5 w-3.5" /> Queue
          </button>
          <span className="text-muted-foreground">/</span>
          <span className="text-sm font-medium text-[#0B2026] truncate max-w-xs">{representativeName}</span>
        </div>
        <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${
          promoted ? 'bg-green-100 text-green-800' :
          agentStarted ? 'bg-blue-100 text-blue-800' :
          'bg-yellow-100 text-yellow-800'
        }`}>
          {promoted ? promoted.outcome : agentStarted ? 'in progress' : 'pending'}
        </span>
      </div>

      {/* Two-column workspace */}
      <div className="grid grid-cols-2 gap-4 flex-1 min-h-0">

        {/* ── LEFT: Raw records ── */}
        <div className="flex flex-col gap-3 overflow-y-auto pr-1">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground flex-shrink-0">
            Raw Records ({records.length})
          </h2>

          {records.length === 0 && (
            <div className="rounded-md border border-dashed border-border bg-white py-10 text-center text-sm text-muted-foreground">
              No records found for this cluster.
            </div>
          )}

          {records.map((rec, i) => (
            <div key={rec.unique_id ?? i} className="space-y-2">
              {records.length > 1 && (
                <p className="text-xs font-medium text-muted-foreground px-1">Record {i + 1} of {records.length}</p>
              )}
              <Section title="Identity" icon={<Building2 className="h-3.5 w-3.5" />}>
                <FieldRow label="Name" value={rec.name} />
                <FieldRow label="Org type" value={rec.organization_type} />
                <FieldRow label="Facility type" value={rec.facilityTypeId} />
                <FieldRow label="Year established" value={rec.yearEstablished} />
                <FieldRow label="Capacity" value={rec.capacity} />
                <FieldRow label="Doctors" value={rec.numberDoctors} />
                <FieldRow label="Accepts volunteers" value={rec.acceptsVolunteers} />
                <FieldRow label="Description" value={rec.description} />
              </Section>
              <Section title="Location" icon={<MapPin className="h-3.5 w-3.5" />}>
                <FieldRow label="Address" value={rec.address_line1} />
                <FieldRow label="City" value={rec.address_city} />
                <FieldRow label="State / Region" value={rec.address_stateOrRegion} />
                <FieldRow label="Postcode" value={rec.address_zipOrPostcode} />
                <FieldRow label="Country" value={rec.address_country} />
                <FieldRow label="Latitude" value={rec.latitude} />
                <FieldRow label="Longitude" value={rec.longitude} />
              </Section>
              <Section title="Contact" icon={<Phone className="h-3.5 w-3.5" />}>
                <FieldRow label="Phone" value={rec.phone_numbers} />
                <FieldRow label="Email" value={rec.email} />
                <FieldRow label="Website" value={rec.websites} />
              </Section>
              <Section title="Clinical" icon={<Stethoscope className="h-3.5 w-3.5" />} defaultOpen={false}>
                <FieldRow label="Specialties" value={rec.specialties} />
                <FieldRow label="Procedures" value={rec.procedure} />
                <FieldRow label="Equipment" value={rec.equipment} />
                <FieldRow label="Capability" value={rec.capability} />
              </Section>
              <Section title="Sources" icon={<Wrench className="h-3.5 w-3.5" />} defaultOpen={false}>
                <FieldRow label="Source types" value={rec.source_types} />
                <FieldRow label="Source URLs" value={rec.source_urls} />
                <FieldRow label="Unique ID" value={rec.unique_id} />
                <FieldRow label="Cluster ID" value={rec.cluster_id} />
              </Section>
            </div>
          ))}
        </div>

        {/* ── RIGHT: Agent panel ── */}
        <div className="flex flex-col rounded-lg border border-border bg-white overflow-hidden">

          {/* Panel header */}
          <div className="flex items-center justify-between border-b border-border px-4 py-2.5 flex-shrink-0">
            <span className="flex items-center gap-2 text-sm font-semibold text-[#0B2026]">
              <Bot className="h-4 w-4" />
              Supervisor Agent
            </span>
            {agentStarted && agentStreaming && (
              <span className="flex items-center gap-1.5 text-xs text-blue-600 font-medium">
                <Loader2 className="h-3 w-3 animate-spin" />
                Verifying…
              </span>
            )}
            {agentStarted && !agentStreaming && !promoted && proposal && (
              <span className="text-xs text-green-600 font-medium">Proposal ready</span>
            )}
            {agentStarted && !agentStreaming && !promoted && !proposal && (
              <span className="text-xs text-muted-foreground font-medium">Ready</span>
            )}
            {promoted && (
              <span className={`text-xs font-medium ${promoted.outcome === 'deferred' ? 'text-yellow-600' : 'text-green-600'}`}>
                {promoted.outcome === 'deferred' ? 'Deferred' : 'Approved'}
              </span>
            )}
          </div>

          {/* Idle state */}
          {!agentStarted ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-5 p-8 text-center">
              <div className="flex h-14 w-14 items-center justify-center rounded-full bg-[#EEEDE9]">
                <Sparkles className="h-7 w-7 text-[#0B2026]" />
              </div>
              <div className="space-y-1.5">
                <p className="text-sm font-semibold text-[#0B2026]">Ready to verify</p>
                <p className="text-xs text-muted-foreground max-w-xs">
                  The Supervisor Agent will dispatch sub-agents to verify contact data,
                  location, and clinical fields — then present a field-by-field proposal for your review.
                </p>
              </div>
              <button
                onClick={() => void handleStartVerification()}
                disabled={starting}
                className="flex items-center gap-2 rounded-md bg-[#FF3621] px-5 py-2.5 text-sm font-semibold text-white hover:bg-[#e02e1a] disabled:opacity-60 transition-colors"
              >
                {starting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
                AI Agent Verification
              </button>
              <p className="text-[11px] text-muted-foreground/60">
                Sub-agent activity is internal. You will only see Supervisor-approved findings.
              </p>
            </div>
          ) : (
            <div className="flex flex-col flex-1 min-h-0">

              {/* Chat — shrinks to make room for the approval panel */}
              <div className={`min-h-0 overflow-hidden transition-all ${proposal && !promoted ? 'flex-[0_0_40%]' : 'flex-1'}`}>
                <AgentChat
                  initialMessage={initialMessage}
                  started={agentStarted}
                  placeholder="Reply to Supervisor…"
                  onStreamingChange={setAgentStreaming}
                  onMessagesChange={setAgentMessages}
                />
              </div>

              {/* ── Approval panel — appears once proposal is parsed ── */}
              {!promoted && proposal && (
                <div className="flex-shrink-0 border-t border-border bg-[#FAFAF9] overflow-y-auto max-h-[60%]">
                  <div className="px-4 pt-3 pb-2 space-y-3">
                    <p className="text-xs font-semibold text-[#0B2026]">Review & Approve Fields</p>
                    <FieldApprovalTable
                      proposal={proposal}
                      decisions={decisions}
                      onDecisionChange={handleDecisionChange}
                      disabled={promoting}
                    />

                    {/* Notes + action buttons */}
                    <textarea
                      value={humanNotes}
                      onChange={(e) => setHumanNotes(e.target.value)}
                      placeholder="Optional reviewer notes…"
                      rows={2}
                      className="w-full rounded-md border border-border bg-white px-3 py-2 text-xs text-[#0B2026] placeholder:text-muted-foreground/60 resize-none focus:outline-none focus:ring-1 focus:ring-[#FF3621]/40"
                    />
                    {promoteError && (
                      <p className="text-xs text-red-600">{promoteError}</p>
                    )}
                    <div className="flex gap-2 pb-1">
                      <button
                        onClick={() => void handleApprove()}
                        disabled={promoting || agentStreaming}
                        className="flex flex-1 items-center justify-center gap-1.5 rounded-md bg-[#FF3621] px-4 py-2 text-xs font-semibold text-white hover:bg-[#e02e1a] disabled:opacity-50 transition-colors"
                      >
                        {promoting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CheckCircle2 className="h-3.5 w-3.5" />}
                        Approve &amp; Promote
                      </button>
                      <button
                        onClick={() => void handleDefer()}
                        disabled={promoting || agentStreaming}
                        className="flex flex-1 items-center justify-center gap-1.5 rounded-md border border-border bg-white px-4 py-2 text-xs font-semibold text-[#0B2026] hover:bg-muted/40 disabled:opacity-50 transition-colors"
                      >
                        {promoting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Clock className="h-3.5 w-3.5" />}
                        Defer
                      </button>
                    </div>
                  </div>
                </div>
              )}

              {/* ── Fallback decision panel — before proposal arrives ── */}
              {!promoted && !proposal && !agentStreaming && agentStarted && (
                <div className="flex-shrink-0 border-t border-border bg-[#FAFAF9] px-4 py-3 space-y-2.5">
                  <p className="text-xs text-muted-foreground">
                    Waiting for the Supervisor to finish analysis…
                  </p>
                  <div className="flex gap-2">
                    <button
                      onClick={() => void handleDefer()}
                      disabled={promoting}
                      className="flex items-center justify-center gap-1.5 rounded-md border border-border bg-white px-4 py-2 text-xs font-semibold text-[#0B2026] hover:bg-muted/40 disabled:opacity-50 transition-colors"
                    >
                      {promoting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Clock className="h-3.5 w-3.5" />}
                      Defer anyway
                    </button>
                  </div>
                </div>
              )}

              {/* ── Post-promotion banner ── */}
              {promoted && (
                <div className={`flex-shrink-0 border-t px-4 py-3 flex items-center justify-between ${
                  promoted.outcome === 'deferred'
                    ? 'border-yellow-200 bg-yellow-50'
                    : 'border-green-200 bg-green-50'
                }`}>
                  <div className="flex items-center gap-2">
                    <CheckCircle2 className={`h-4 w-4 ${promoted.outcome === 'deferred' ? 'text-yellow-600' : 'text-green-600'}`} />
                    <span className="text-xs font-semibold text-[#0B2026]">
                      {promoted.outcome === 'deferred'
                        ? 'Deferred for later review'
                        : `Promoted to resolved (ID ${promoted.resolved_id})`}
                    </span>
                  </div>
                  <button
                    onClick={() => navigate('/decisions')}
                    className="text-xs text-[#FF3621] hover:underline font-medium"
                  >
                    View in Decisions →
                  </button>
                  <button
                    onClick={() => navigate('/', { state: { resolvedClusterId: clusterId } })}
                    className="text-xs text-muted-foreground hover:underline font-medium"
                  >
                    ← Back to queue
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
