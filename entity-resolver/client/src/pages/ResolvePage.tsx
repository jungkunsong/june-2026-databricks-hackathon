import { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router';
import { Loader2, ArrowLeft, CheckCircle2, XCircle, Clock, ChevronDown, ChevronUp, ExternalLink } from 'lucide-react';
import { clustersApi, tasksApi, decisionsApi, messagesApi, type FacilityRecord, type TaskWithThread } from '../lib/api';
import { AgentChat } from './agents/AgentChat';

// ── Field comparison helpers ───────────────────────────────────────────────────

function parseJsonArray(val: string | null | undefined): string[] {
  if (!val) return [];
  try { return JSON.parse(val) as string[]; } catch { return [val]; }
}

function fieldDiffers(records: FacilityRecord[], field: keyof FacilityRecord): boolean {
  const vals = records.map((r) => r[field]);
  return new Set(vals.map((v) => String(v ?? ''))).size > 1;
}

// ── Record card ────────────────────────────────────────────────────────────────

function RecordCard({ record, index, differs }: { record: FacilityRecord; index: number; differs: Set<keyof FacilityRecord> }) {
  const [expanded, setExpanded] = useState(false);

  const fields: { label: string; key: keyof FacilityRecord; array?: boolean }[] = [
    { label: 'Name', key: 'name' },
    { label: 'Type', key: 'facilityTypeId' },
    { label: 'Org Type', key: 'organization_type' },
    { label: 'Address', key: 'address_line1' },
    { label: 'City', key: 'address_city' },
    { label: 'State', key: 'address_stateOrRegion' },
    { label: 'Country', key: 'address_country' },
    { label: 'ZIP', key: 'address_zipOrPostcode' },
    { label: 'Phone', key: 'phone_numbers' },
    { label: 'Email', key: 'email' },
    { label: 'Website', key: 'websites' },
    { label: 'Doctors', key: 'numberDoctors' },
    { label: 'Capacity', key: 'capacity' },
    { label: 'Est.', key: 'yearEstablished' },
    { label: 'Lat', key: 'latitude' },
    { label: 'Lng', key: 'longitude' },
    { label: 'Source', key: 'source_types' },
  ];

  const skillFields: { label: string; key: keyof FacilityRecord }[] = [
    { label: 'Specialties', key: 'specialties' },
    { label: 'Procedures', key: 'procedure' },
    { label: 'Equipment', key: 'equipment' },
    { label: 'Capabilities', key: 'capability' },
  ];

  return (
    <div className="rounded-lg border border-border bg-white shadow-sm overflow-hidden">
      <div className="flex items-center justify-between bg-[#EEEDE9] px-4 py-2">
        <span className="text-xs font-semibold text-[#0B2026]">Record {index + 1}</span>
        <span className="text-xs text-muted-foreground font-mono">{record.unique_id?.slice(0, 12)}…</span>
      </div>
      <div className="divide-y divide-border">
        {fields.map(({ label, key }) => {
          const val = record[key];
          const isDiff = differs.has(key);
          return (
            <div key={String(key)} className={`flex gap-2 px-4 py-1.5 text-xs ${isDiff ? 'bg-amber-50' : ''}`}>
              <span className="w-20 flex-shrink-0 text-muted-foreground">{label}</span>
              <span className={`flex-1 break-all ${isDiff ? 'font-medium text-amber-800' : 'text-foreground'}`}>
                {val != null && val !== '' ? String(val) : <span className="text-muted-foreground/50">—</span>}
                {isDiff && <span className="ml-1 text-amber-500">⚠</span>}
              </span>
            </div>
          );
        })}
      </div>

      {/* Skills section */}
      <button
        onClick={() => setExpanded((e) => !e)}
        className="flex w-full items-center justify-between bg-[#EEEDE9]/60 px-4 py-2 text-xs font-medium text-[#0B2026] hover:bg-[#EEEDE9]"
      >
        Skills & Specialties
        {expanded ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
      </button>
      {expanded && (
        <div className="divide-y divide-border">
          {skillFields.map(({ label, key }) => {
            const items = parseJsonArray(record[key] as string);
            const isDiff = differs.has(key);
            return (
              <div key={String(key)} className={`px-4 py-2 text-xs ${isDiff ? 'bg-amber-50' : ''}`}>
                <div className="mb-1 text-muted-foreground">
                  {label} {isDiff && <span className="text-amber-500">⚠</span>}
                </div>
                {items.length > 0 ? (
                  <div className="flex flex-wrap gap-1">
                    {items.map((item, i) => (
                      <span key={i} className="rounded-full bg-[#EEEDE9] px-2 py-0.5 text-[10px] text-[#0B2026]">
                        {item}
                      </span>
                    ))}
                  </div>
                ) : (
                  <span className="text-muted-foreground/50">—</span>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Source URLs */}
      {record.source_urls && (
        <div className="px-4 py-2 text-xs">
          <span className="text-muted-foreground">Sources: </span>
          {parseJsonArray(record.source_urls).slice(0, 2).map((url, i) => (
            <a key={i} href={url} target="_blank" rel="noopener noreferrer"
              className="mr-2 inline-flex items-center gap-0.5 text-[#FF3621] underline underline-offset-2">
              Link {i + 1} <ExternalLink className="h-2.5 w-2.5" />
            </a>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Decision panel ─────────────────────────────────────────────────────────────

const OUTCOMES = [
  { value: 'merged', label: 'Merge', color: 'bg-green-600 hover:bg-green-700', icon: CheckCircle2 },
  { value: 'confirmed_distinct', label: 'Keep Separate', color: 'bg-blue-600 hover:bg-blue-700', icon: XCircle },
  { value: 'confirmed_duplicate', label: 'Exact Duplicate', color: 'bg-purple-600 hover:bg-purple-700', icon: CheckCircle2 },
  { value: 'deferred', label: 'Defer', color: 'bg-gray-500 hover:bg-gray-600', icon: Clock },
];

// ── Main page ──────────────────────────────────────────────────────────────────

export function ResolvePage() {
  const { taskId } = useParams<{ taskId: string }>();
  const navigate = useNavigate();
  const [thread, setThread] = useState<TaskWithThread | null>(null);
  const [records, setRecords] = useState<FacilityRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [deciding, setDeciding] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<'evidence' | 'chat'>('evidence');
  const isMobile = window.innerWidth < 768;

  const load = useCallback(async () => {
    if (!taskId) return;
    setLoading(true);
    try {
      const t = await tasksApi.get(Number(taskId));
      setThread(t);
      const recs = await clustersApi.records(t.task.cluster_id);
      setRecords(recs);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, [taskId]);

  useEffect(() => { void load(); }, [load]);

  // Compute which fields differ across records
  const differingFields = new Set<keyof FacilityRecord>();
  if (records.length > 1) {
    const keys: (keyof FacilityRecord)[] = [
      'name', 'facilityTypeId', 'organization_type', 'address_line1',
      'address_city', 'address_stateOrRegion', 'address_country',
      'address_zipOrPostcode', 'phone_numbers', 'email', 'websites',
      'numberDoctors', 'capacity', 'yearEstablished', 'latitude', 'longitude',
      'source_types', 'specialties', 'procedure', 'equipment', 'capability',
    ];
    for (const k of keys) {
      if (fieldDiffers(records, k)) differingFields.add(k);
    }
  }

  async function submitDecision(outcome: string) {
    if (!thread || !taskId) return;
    setDeciding(outcome);
    try {
      await decisionsApi.create(Number(taskId), {
        cluster_id: thread.task.cluster_id,
        outcome,
        decided_by: 'human',
      });
      // Save a message recording the decision
      await messagesApi.create(Number(taskId), {
        role: 'user',
        content: `Decision submitted: **${outcome.replace(/_/g, ' ')}**`,
      });
      navigate('/');
    } catch (e) {
      setError(String(e));
    } finally {
      setDeciding(null);
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-24">
        <Loader2 className="h-6 w-6 animate-spin text-[#FF3621]" />
      </div>
    );
  }

  if (error || !thread) {
    return (
      <div className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
        {error ?? 'Task not found'}
      </div>
    );
  }

  const { task, latest_decision } = thread;

  // Build context string for the agent
  const agentContext = `
You are resolving cluster: ${task.cluster_id}
Representative name: ${records[0]?.name ?? 'Unknown'}
Records in cluster: ${records.length}
Location: ${[records[0]?.address_city, records[0]?.address_stateOrRegion, records[0]?.address_country].filter(Boolean).join(', ')}
Differing fields: ${[...differingFields].join(', ') || 'none'}

Raw records (JSON):
${JSON.stringify(records.map((r) => ({
  unique_id: r.unique_id,
  name: r.name,
  organization_type: r.organization_type,
  facilityTypeId: r.facilityTypeId,
  address: `${r.address_line1 ?? ''}, ${r.address_city ?? ''}, ${r.address_stateOrRegion ?? ''} ${r.address_zipOrPostcode ?? ''}, ${r.address_country ?? ''}`.trim(),
  lat: r.latitude,
  lng: r.longitude,
  phone: r.phone_numbers,
  email: r.email,
  websites: r.websites,
  source_types: r.source_types,
  specialties: parseJsonArray(r.specialties),
  procedures: parseJsonArray(r.procedure),
  equipment: parseJsonArray(r.equipment),
  capabilities: parseJsonArray(r.capability),
  numberDoctors: r.numberDoctors,
  capacity: r.capacity,
  yearEstablished: r.yearEstablished,
})), null, 2)}
  `.trim();

  return (
    <div className="space-y-4">
      {/* Back + header */}
      <div className="flex items-start gap-3">
        <button
          onClick={() => navigate('/')}
          className="mt-0.5 rounded-md p-1.5 hover:bg-muted"
        >
          <ArrowLeft className="h-4 w-4 text-muted-foreground" />
        </button>
        <div className="flex-1">
          <h1 className="text-xl font-bold text-[#0B2026]">
            {records[0]?.name ?? task.cluster_id}
          </h1>
          <p className="text-xs text-muted-foreground">
            Cluster {task.cluster_id.slice(0, 16)}… · {records.length} records ·{' '}
            {[records[0]?.address_city, records[0]?.address_country].filter(Boolean).join(', ')}
          </p>
        </div>
        {latest_decision && (
          <span className="rounded-full bg-green-100 px-3 py-1 text-xs font-medium text-green-800">
            {latest_decision.outcome.replace(/_/g, ' ')}
          </span>
        )}
      </div>

      {/* Mobile tab switcher */}
      {isMobile && (
        <div className="flex rounded-lg border border-border bg-white p-1">
          {(['evidence', 'chat'] as const).map((tab) => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className={`flex-1 rounded-md py-1.5 text-xs font-medium transition-colors ${
                activeTab === tab ? 'bg-[#0B2026] text-white' : 'text-muted-foreground hover:bg-muted'
              }`}
            >
              {tab === 'evidence' ? 'Evidence' : 'AI Chat'}
            </button>
          ))}
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {/* Evidence panel */}
        {(!isMobile || activeTab === 'evidence') && (
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold text-[#0B2026]">
                Evidence ({records.length} records)
              </h2>
              {differingFields.size > 0 && (
                <span className="text-xs text-amber-600">
                  ⚠ {differingFields.size} differing field{differingFields.size > 1 ? 's' : ''}
                </span>
              )}
            </div>
            <div className="space-y-3 max-h-[calc(100vh-320px)] overflow-y-auto pr-1">
              {records.map((rec, i) => (
                <RecordCard key={rec.unique_id} record={rec} index={i} differs={differingFields} />
              ))}
            </div>
          </div>
        )}

        {/* Chat + decision panel */}
        {(!isMobile || activeTab === 'chat') && (
          <div className="flex flex-col gap-3">
            {/* Supervisor chat */}
            <div className="rounded-lg border border-border bg-white shadow-sm overflow-hidden" style={{ height: 'calc(100vh - 380px)', minHeight: '400px' }}>
              <div className="border-b border-border bg-[#0B2026] px-4 py-2">
                <span className="text-xs font-semibold text-white">Supervisor Agent</span>
                <p className="text-[10px] text-white/60">AI-assisted resolution · Human in the loop</p>
              </div>
              <div className="h-[calc(100%-52px)]">
                <AgentChat
                  agentName="supervisor"
                  initialMessage={`I'm ready to help resolve this cluster. Here is the full context:\n\n${agentContext}\n\nPlease analyze these records and provide your initial assessment.`}
                  placeholder="Ask the supervisor agent, provide context, or confirm a decision…"
                />
              </div>
            </div>

            {/* Decision buttons */}
            <div className="rounded-lg border border-border bg-white p-4 shadow-sm">
              <h3 className="mb-3 text-xs font-semibold text-[#0B2026]">Submit Decision</h3>
              <div className="grid grid-cols-2 gap-2">
                {OUTCOMES.map(({ value, label, color, icon: Icon }) => (
                  <button
                    key={value}
                    onClick={() => void submitDecision(value)}
                    disabled={deciding !== null || task.status === 'resolved'}
                    className={`flex items-center justify-center gap-1.5 rounded-md px-3 py-2 text-xs font-medium text-white transition-colors ${color} disabled:opacity-50`}
                  >
                    {deciding === value ? (
                      <Loader2 className="h-3 w-3 animate-spin" />
                    ) : (
                      <Icon className="h-3 w-3" />
                    )}
                    {label}
                  </button>
                ))}
              </div>
              {task.status === 'resolved' && latest_decision && (
                <p className="mt-2 text-center text-xs text-green-600">
                  Resolved as: <strong>{latest_decision.outcome.replace(/_/g, ' ')}</strong>
                </p>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
