import { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate, Link } from 'react-router';
import {
  ArrowLeft,
  Bot,
  Building2,
  CheckCircle2,
  Clock,
  Loader2,
  MapPin,
  Phone,
  Stethoscope,
  Wrench,
  ChevronDown,
  ChevronUp,
  Sparkles,
} from 'lucide-react';
import { clustersApi, tasksApi, promoteApi, type FacilityRecord, type ResolutionTask } from '../lib/api';
import { AgentChat } from './agents/AgentChat';

// ── helpers ──────────────────────────────────────────────────────────────────

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

// Build a concise initial prompt for the supervisor from the cluster records.
// Includes the row_id so the supervisor can pass it directly to evidence-fetcher.
function buildInitialMessage(clusterId: string, records: FacilityRecord[]): string {
  const primary = records[0];
  const rowId = primary?.row_id;
  const names = [...new Set(records.map((r) => r.name).filter(Boolean))].join(', ');
  return (
    `Please begin AI Agent Verification for facility cluster "${clusterId}".\n\n` +
    `Primary record row_id: ${rowId}. ` +
    `This cluster contains ${records.length} record(s): ${names}.\n\n` +
    `Start by calling evidence-fetcher with row_id=${rowId} to retrieve the full record. ` +
    `Then dispatch all appropriate sub-agents based on the populated fields. ` +
    `Interrogate their findings and present only your approved results with reasoning. ` +
    `Mark any field you cannot validate as "unable to validate" with an explanation.`
  );
}

// ── main component ────────────────────────────────────────────────────────────

export function ResolvePage() {
  const { clusterId } = useParams<{ clusterId: string }>();
  const navigate = useNavigate();

  const [records, setRecords] = useState<FacilityRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Task created when verification starts
  const [task, setTask] = useState<ResolutionTask | null>(null);

  // Whether the user has clicked "AI Agent Verification"
  const [agentStarted, setAgentStarted] = useState(false);
  const [starting, setStarting] = useState(false);
  const [agentStreaming, setAgentStreaming] = useState(false);

  // Decision panel
  const [humanNotes, setHumanNotes] = useState('');
  const [promoting, setPromoting] = useState(false);
  const [promoted, setPromoted] = useState<{ outcome: string; resolved_id: number } | null>(null);
  const [promoteError, setPromoteError] = useState<string | null>(null);

  const [initialMessage, setInitialMessage] = useState<string>('');

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

  async function handleStartVerification() {
    if (!clusterId) return;
    setStarting(true);
    try {
      // Create (or find existing) task — server sets in_progress on upsert
      const created = await tasksApi.create(clusterId);
      setTask(created);
      setAgentStarted(true);
    } catch (e) {
      setError(String(e));
    } finally {
      setStarting(false);
    }
  }

  async function handleDecision(outcome: 'verified' | 'deferred') {
    if (!task) return;
    const primary = records[0];
    setPromoting(true);
    setPromoteError(null);
    try {
      const result = await promoteApi.promote({
        task_id: task.id,
        raw_row_id: task.raw_row_id,
        facility_name: task.facility_name ?? primary?.name ?? null,
        outcome,
        reasoning: humanNotes.trim() || `Human reviewer marked as ${outcome}.`,
        human_notes: humanNotes.trim() || null,
        resolved_fields: primary ? {
          unique_id: primary.unique_id,
          name: primary.name,
          organization_type: primary.organization_type,
          facilityTypeId: primary.facilityTypeId,
          description: primary.description,
          phone_numbers: primary.phone_numbers,
          email: primary.email,
          websites: primary.websites,
          address_line1: primary.address_line1,
          address_city: primary.address_city,
          address_stateOrRegion: primary.address_stateOrRegion,
          address_zipOrPostcode: primary.address_zipOrPostcode,
          address_country: primary.address_country,
          latitude: primary.latitude,
          longitude: primary.longitude,
          specialties: primary.specialties,
          procedure: primary.procedure,
          equipment: primary.equipment,
          capability: primary.capability,
          capacity: primary.capacity,
          numberDoctors: primary.numberDoctors,
        } : {},
      });
      setPromoted({ outcome, resolved_id: result.resolved_id });
    } catch (e) {
      setPromoteError(String(e));
    } finally {
      setPromoting(false);
    }
  }

  // ── loading / error states ──────────────────────────────────────────────────

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

  // ── render ──────────────────────────────────────────────────────────────────

  return (
    <div className="flex flex-col gap-4 h-[calc(100vh-7rem)]">

      {/* Breadcrumb + header */}
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
          agentStarted ? 'bg-blue-100 text-blue-800' : 'bg-yellow-100 text-yellow-800'
        }`}>
          {agentStarted ? 'in progress' : 'pending'}
        </span>
      </div>

      {/* Two-column workspace */}
      <div className="grid grid-cols-2 gap-4 flex-1 min-h-0">

        {/* ── LEFT: Raw record(s) ── */}
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
            {agentStarted && !agentStreaming && !promoted && (
              <span className="text-xs text-green-600 font-medium">Ready</span>
            )}
            {promoted && (
              <span className={`text-xs font-medium ${promoted.outcome === 'verified' ? 'text-green-600' : 'text-yellow-600'}`}>
                {promoted.outcome === 'verified' ? 'Approved' : 'Deferred'}
              </span>
            )}
          </div>

          {/* Idle state — shown until user clicks the button */}
          {!agentStarted ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-5 p-8 text-center">
              <div className="flex h-14 w-14 items-center justify-center rounded-full bg-[#EEEDE9]">
                <Sparkles className="h-7 w-7 text-[#0B2026]" />
              </div>
              <div className="space-y-1.5">
                <p className="text-sm font-semibold text-[#0B2026]">Ready to verify</p>
                <p className="text-xs text-muted-foreground max-w-xs">
                  The Supervisor Agent will dispatch sub-agents to verify contact data,
                  location, and clinical fields — then present its findings with reasoning.
                </p>
              </div>
              <button
                onClick={() => void handleStartVerification()}
                disabled={starting}
                className="flex items-center gap-2 rounded-md bg-[#FF3621] px-5 py-2.5 text-sm font-semibold text-white hover:bg-[#e02e1a] disabled:opacity-60 transition-colors"
              >
                {starting ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Sparkles className="h-4 w-4" />
                )}
                AI Agent Verification
              </button>
              <p className="text-[11px] text-muted-foreground/60">
                Sub-agent activity is internal. You will only see Supervisor-approved findings.
              </p>
            </div>
          ) : (
            /* Active state — AgentChat + decision panel */
            <>
              <div className="flex-1 min-h-0 overflow-hidden">
                <AgentChat
                  initialMessage={initialMessage}
                  started={agentStarted}
                  placeholder="Reply to Supervisor…"
                  onStreamingChange={setAgentStreaming}
                />
              </div>

              {/* ── Decision panel — docked at bottom ── */}
              {!promoted ? (
                <div className="flex-shrink-0 border-t border-border bg-[#FAFAF9] px-4 py-3 space-y-2.5">
                  <p className="text-xs font-semibold text-[#0B2026]">Your Decision</p>
                  <textarea
                    value={humanNotes}
                    onChange={(e) => setHumanNotes(e.target.value)}
                    placeholder="Optional notes (e.g. confirmed via phone call)…"
                    rows={2}
                    className="w-full rounded-md border border-border bg-white px-3 py-2 text-xs text-[#0B2026] placeholder:text-muted-foreground/60 resize-none focus:outline-none focus:ring-1 focus:ring-[#FF3621]/40"
                  />
                  {promoteError && (
                    <p className="text-xs text-red-600">{promoteError}</p>
                  )}
                  <div className="flex gap-2">
                    <button
                      onClick={() => void handleDecision('verified')}
                      disabled={promoting || agentStreaming}
                      className="flex flex-1 items-center justify-center gap-1.5 rounded-md bg-[#FF3621] px-4 py-2 text-xs font-semibold text-white hover:bg-[#e02e1a] disabled:opacity-50 transition-colors"
                    >
                      {promoting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CheckCircle2 className="h-3.5 w-3.5" />}
                      Approve &amp; Promote
                    </button>
                    <button
                      onClick={() => void handleDecision('deferred')}
                      disabled={promoting || agentStreaming}
                      className="flex flex-1 items-center justify-center gap-1.5 rounded-md border border-border bg-white px-4 py-2 text-xs font-semibold text-[#0B2026] hover:bg-muted/40 disabled:opacity-50 transition-colors"
                    >
                      {promoting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Clock className="h-3.5 w-3.5" />}
                      Defer
                    </button>
                  </div>
                </div>
              ) : (
                <div className={`flex-shrink-0 border-t px-4 py-3 flex items-center justify-between ${
                  promoted.outcome === 'verified'
                    ? 'border-green-200 bg-green-50'
                    : 'border-yellow-200 bg-yellow-50'
                }`}>
                  <div className="flex items-center gap-2">
                    <CheckCircle2 className={`h-4 w-4 ${promoted.outcome === 'verified' ? 'text-green-600' : 'text-yellow-600'}`} />
                    <span className="text-xs font-semibold text-[#0B2026]">
                      {promoted.outcome === 'verified'
                        ? `Promoted to resolved (ID ${promoted.resolved_id})`
                        : 'Deferred for later review'}
                    </span>
                  </div>
                  <button
                    onClick={() => navigate('/decisions')}
                    className="text-xs text-[#FF3621] hover:underline font-medium"
                  >
                    View in Decisions →
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
