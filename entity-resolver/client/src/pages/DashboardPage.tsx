import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router';
import {
  ArrowRight,
  CheckCircle2,
  AlertTriangle,
  Clock,
  Loader2,
  Layers,
  ShieldCheck,
  Sparkles,
  TrendingUp,
  Globe,
  Phone,
  MapPin,
  Facebook,
  BookOpen,
  Star,
  Copy,
  Brain,
} from 'lucide-react';

import { clustersApi, decisionLogApi, type DecisionLogEntry } from '../lib/api';

// ── Helpers ───────────────────────────────────────────────────────────────────

function StatCard({
  label,
  value,
  sub,
  icon: Icon,
  iconColor,
  loading,
}: {
  label: string;
  value: string | number;
  sub?: string;
  icon: typeof CheckCircle2;
  iconColor: string;
  loading: boolean;
}) {
  return (
    <div className="rounded-xl border border-border bg-white px-5 py-4 shadow-sm flex items-start gap-4">
      <div className={`mt-0.5 flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg ${iconColor}`}>
        <Icon className="h-4.5 w-4.5" />
      </div>
      <div className="min-w-0">
        <p className="text-xs font-medium text-muted-foreground">{label}</p>
        {loading ? (
          <div className="mt-1 h-7 w-16 animate-pulse rounded bg-border" />
        ) : (
          <p className="mt-0.5 text-2xl font-bold text-[#0B2026] tabular-nums leading-tight">
            {typeof value === 'number' ? value.toLocaleString() : value}
          </p>
        )}
        {sub && !loading && (
          <p className="mt-0.5 text-[11px] text-muted-foreground">{sub}</p>
        )}
      </div>
    </div>
  );
}

function OutcomeBar({ entries }: { entries: DecisionLogEntry[] }) {
  if (entries.length === 0) return null;
  const counts = { verified: 0, corrected: 0, partial: 0, deferred: 0 };
  for (const e of entries) {
    if (e.outcome in counts) counts[e.outcome as keyof typeof counts]++;
  }
  const total = entries.length;
  const segments = [
    { key: 'verified',  label: 'Verified',  color: 'bg-green-500',  count: counts.verified  },
    { key: 'corrected', label: 'Corrected', color: 'bg-blue-500',   count: counts.corrected },
    { key: 'partial',   label: 'Partial',   color: 'bg-amber-400',  count: counts.partial   },
    { key: 'deferred',  label: 'Deferred',  color: 'bg-gray-300',   count: counts.deferred  },
  ].filter((s) => s.count > 0);

  return (
    <div className="space-y-2">
      <div className="flex h-3 w-full overflow-hidden rounded-full bg-border gap-0.5">
        {segments.map((s) => (
          <div
            key={s.key}
            className={`${s.color} transition-all`}
            style={{ width: `${(s.count / total) * 100}%` }}
            title={`${s.label}: ${s.count}`}
          />
        ))}
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1">
        {segments.map((s) => (
          <span key={s.key} className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <span className={`inline-block h-2 w-2 rounded-full ${s.color}`} />
            {s.label} <span className="font-medium text-[#0B2026]">{s.count}</span>
          </span>
        ))}
      </div>
    </div>
  );
}

function RecentDecisionRow({ entry }: { entry: DecisionLogEntry }) {
  const OUTCOME_STYLE: Record<string, string> = {
    verified:  'text-green-700 bg-green-50 border-green-200',
    corrected: 'text-blue-700 bg-blue-50 border-blue-200',
    partial:   'text-amber-700 bg-amber-50 border-amber-200',
    deferred:  'text-gray-600 bg-gray-50 border-gray-200',
  };
  return (
    <div className="flex items-center justify-between gap-3 py-2 border-b border-border/50 last:border-0">
      <div className="min-w-0">
        <p className="text-sm font-medium text-[#0B2026] truncate">
          {entry.facility_name ?? <span className="italic text-muted-foreground">Unknown</span>}
        </p>
        <p className="text-[11px] text-muted-foreground">
          {new Date(entry.decided_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}
        </p>
      </div>
      <span className={`flex-shrink-0 rounded border px-2 py-0.5 text-[10px] font-semibold ${OUTCOME_STYLE[entry.outcome] ?? 'text-gray-600 bg-gray-50 border-gray-200'}`}>
        {entry.outcome}
      </span>
    </div>
  );
}

// Sub-agent card for the agent showcase section
function AgentCard({
  icon: Icon,
  iconBg,
  name,
  description,
  signals,
}: {
  icon: typeof Globe;
  iconBg: string;
  name: string;
  description: string;
  signals: string[];
}) {
  return (
    <div className="rounded-xl border border-border bg-white px-5 py-4 shadow-sm space-y-3 hover:shadow-md transition-shadow">
      <div className="flex items-center gap-3">
        <div className={`flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg ${iconBg}`}>
          <Icon className="h-4 w-4" />
        </div>
        <p className="text-xs font-semibold text-[#0B2026]">{name}</p>
      </div>
      <p className="text-[11px] text-muted-foreground leading-relaxed">{description}</p>
      <div className="flex flex-wrap gap-1">
        {signals.map((s) => (
          <span key={s} className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
            {s}
          </span>
        ))}
      </div>
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export function DashboardPage() {
  const navigate = useNavigate();

  const [queueCount, setQueueCount] = useState<number | null>(null);
  const [decisions, setDecisions] = useState<DecisionLogEntry[]>([]);
  const [loadingQueue, setLoadingQueue] = useState(true);
  const [loadingDecisions, setLoadingDecisions] = useState(true);

  useEffect(() => {
    clustersApi
      .count()
      .then((r) => setQueueCount(r.total))
      .catch(() => setQueueCount(null))
      .finally(() => setLoadingQueue(false));

    decisionLogApi
      .list()
      .then(setDecisions)
      .catch(() => setDecisions([]))
      .finally(() => setLoadingDecisions(false));
  }, []);

  const resolved = decisions.length;
  const avgConfidence = (() => {
    const withConf = decisions.filter((e) => e.confidence != null);
    if (withConf.length === 0) return null;
    const avg = withConf.reduce((s, e) => s + Number(e.confidence), 0) / withConf.length;
    return isNaN(avg) ? null : Math.round(avg * 100);
  })();

  const recentDecisions = decisions.slice(0, 5);

  const agents = [
    {
      icon: Globe,
      iconBg: 'bg-blue-50 text-blue-600',
      name: 'Website Validator',
      description: 'Live HTTP check on officialWebsite. Scores domain authority, SSL, content relevance, and page recency.',
      signals: ['HTTP status', 'SSL cert', 'domain age', 'content match', 'recency'],
    },
    {
      icon: Phone,
      iconBg: 'bg-green-50 text-green-600',
      name: 'Phone Validator',
      description: 'Validates Indian phone numbers via libphonenumber — checks format, STD code, and geographic plausibility against the facility\'s pincode.',
      signals: ['E.164 format', 'STD code', 'pincode match', 'mobile vs. landline'],
    },
    {
      icon: MapPin,
      iconBg: 'bg-amber-50 text-amber-600',
      name: 'Location Validator',
      description: 'Cross-references lat/lon, pincode, city, and state against a reference directory. Flags coordinate–address mismatches within 20 km.',
      signals: ['lat/lon', 'pincode', 'city', 'state', 'distance check'],
    },
    {
      icon: Facebook,
      iconBg: 'bg-indigo-50 text-indigo-600',
      name: 'Social Validator',
      description: 'Scores Facebook page presence (0–16) plus cross-field validation of the social handle against the facility name and address (0–4).',
      signals: ['page exists', 'follower count', 'activity', 'name match', 'address match'],
    },
    {
      icon: BookOpen,
      iconBg: 'bg-purple-50 text-purple-600',
      name: 'Context Validator',
      description: 'Evaluates six contextual fields — specialties, procedures, equipment, capabilities, description, and doctor/capacity counts — for internal coherence.',
      signals: ['specialties', 'procedures', 'equipment', 'capacity', 'description', 'doctor count'],
    },
    {
      icon: Star,
      iconBg: 'bg-rose-50 text-rose-600',
      name: 'Source Authority',
      description: 'Tiers each URL in source_urls from authoritative (gov, WHO, Wikipedia) down to noise (real-estate portals). Score = MAX tier across all sources.',
      signals: ['gov/WHO', 'official site', 'Practo', 'JustDial', 'proptiger.com'],
    },
    {
      icon: Copy,
      iconBg: 'bg-teal-50 text-teal-600',
      name: 'Duplicate Detector',
      description: 'Finds near-duplicate records via shared phone, website, Facebook, or coordinates within 0.5 km. Also checks internal field coherence — name vs. facility type, address consistency, and coordinate plausibility.',
      signals: ['shared phone', 'shared website', 'shared facebook', 'coordinates', 'name fuzzy-match'],
    },
  ];

  return (
    <div className="space-y-8 max-w-5xl mx-auto">

      {/* Hero */}
      <div className="rounded-xl border border-border bg-white px-8 py-8 shadow-sm">
        <div className="flex flex-col sm:flex-row items-start sm:items-center gap-6">
          <div className="flex h-14 w-14 flex-shrink-0 items-center justify-center rounded-xl bg-[#0B2026]">
            <ShieldCheck className="h-7 w-7 text-[#FF3621]" />
          </div>
          <div className="flex-1 min-w-0">
            <div>
              <h1 className="text-2xl font-bold text-[#0B2026] leading-tight">
                Facility Trust Operating System
              </h1>
              <p className="text-[11px] font-semibold uppercase tracking-widest text-muted-foreground mt-1">
                Building and Optimizing the Facility Trust Desk with AI Agents
              </p>
            </div>
            <p className="mt-1.5 text-sm text-muted-foreground max-w-2xl leading-relaxed">
              A multi-agent AI workflow that validates, resolves, and deduplicates medical facility records at scale. Combining live web signals, geospatial checks, and clinical context to produce a trusted dataset.
            </p>
          </div>
          <button
            onClick={() => navigate('/queue')}
            className="flex-shrink-0 flex items-center gap-2 rounded-lg bg-[#FF3621] px-5 py-2.5 text-sm font-semibold text-white hover:bg-[#e02e1a] transition-colors shadow-sm"
          >
            <Sparkles className="h-4 w-4" />
            Start validating
            <ArrowRight className="h-4 w-4" />
          </button>
        </div>

        {/* Graphical workflow */}
        <div className="mt-6 pt-6 border-t border-border">
          <div className="grid grid-cols-[1fr_auto_1fr_auto_1fr] items-stretch gap-0">

            {/* Step 1 */}
            <div className="rounded-xl bg-[#0B2026] px-5 py-5 flex flex-col gap-2">
              <div className="flex items-center gap-2">
                <div className="flex h-7 w-7 items-center justify-center rounded-full bg-white/10">
                  <Layers className="h-3.5 w-3.5 text-white" />
                </div>
                <span className="text-[10px] font-semibold uppercase tracking-widest text-white/50">Step 1</span>
              </div>
              <p className="text-sm font-bold text-white leading-snug">Pick One or More Facilities</p>
              <p className="text-[11px] text-white/60 leading-relaxed">Select from the queue — each entry is a group of duplicate or conflicting records.</p>
            </div>

            {/* Arrow */}
            <div className="flex items-center justify-center px-3">
              <ArrowRight className="h-5 w-5 text-muted-foreground/40 flex-shrink-0" />
            </div>

            {/* Step 2 */}
            <div className="rounded-xl bg-[#FF3621]/8 border border-[#FF3621]/20 px-5 py-5 flex flex-col gap-2">
              <div className="flex items-center gap-2">
                <div className="flex h-7 w-7 items-center justify-center rounded-full bg-[#FF3621]/15">
                  <Brain className="h-3.5 w-3.5 text-[#FF3621]" />
                </div>
                <span className="text-[10px] font-semibold uppercase tracking-widest text-[#FF3621]/70">Step 2</span>
              </div>
              <p className="text-sm font-bold text-[#0B2026] leading-snug">AI Agents Validate</p>
              <p className="text-[11px] text-muted-foreground leading-relaxed">7 sub-agents run in parallel — website, contacts, location, social, context, source authority, and duplicates.</p>
            </div>

            {/* Arrow */}
            <div className="flex items-center justify-center px-3">
              <ArrowRight className="h-5 w-5 text-muted-foreground/40 flex-shrink-0" />
            </div>

            {/* Step 3 */}
            <div className="rounded-xl bg-green-50 border border-green-200 px-5 py-5 flex flex-col gap-2">
              <div className="flex items-center gap-2">
                <div className="flex h-7 w-7 items-center justify-center rounded-full bg-green-100">
                  <ShieldCheck className="h-3.5 w-3.5 text-green-600" />
                </div>
                <span className="text-[10px] font-semibold uppercase tracking-widest text-green-600/70">Step 3</span>
              </div>
              <p className="text-sm font-bold text-[#0B2026] leading-snug">You Approve</p>
              <p className="text-[11px] text-muted-foreground leading-relaxed">Review the AI's proposal and confidence score, then promote a clean record — or defer for manual review.</p>
            </div>

          </div>
        </div>
      </div>

      {/* Stats row */}
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <StatCard
          label="Awaiting review"
          value={queueCount ?? '—'}
          sub="clusters in queue"
          icon={Layers}
          iconColor="bg-amber-50 text-amber-600"
          loading={loadingQueue}
        />
        <StatCard
          label="Resolved"
          value={resolved}
          sub="decisions logged"
          icon={CheckCircle2}
          iconColor="bg-green-50 text-green-600"
          loading={loadingDecisions}
        />
        <StatCard
          label="Avg confidence"
          value={avgConfidence != null ? `${avgConfidence}%` : '—'}
          sub="across all decisions"
          icon={TrendingUp}
          iconColor="bg-blue-50 text-blue-600"
          loading={loadingDecisions}
        />
        <StatCard
          label="Deferred"
          value={decisions.filter((e) => e.outcome === 'deferred').length}
          sub="need manual review"
          icon={Clock}
          iconColor="bg-gray-100 text-gray-500"
          loading={loadingDecisions}
        />
      </div>

      {/* Sub-agent showcase */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-sm font-semibold text-[#0B2026]">Validation sub-agents</h2>
            <p className="text-[11px] text-muted-foreground mt-0.5">
              Each agent runs independently and returns a calibrated score. The Supervisor aggregates all signals into a final confidence rating.
            </p>
          </div>
          <span className="rounded-full bg-[#0B2026]/5 px-3 py-1 text-[11px] font-semibold text-[#0B2026]">
            7 agents · scores 0–20
          </span>
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {agents.map((a) => (
            <AgentCard key={a.name} {...a} />
          ))}
        </div>
      </div>

      {/* Two-column lower section */}
      <div className="grid grid-cols-1 gap-6 sm:grid-cols-2">

        {/* Recent decisions */}
        <div className="rounded-xl border border-border bg-white px-6 py-5 shadow-sm space-y-4 sm:col-span-2">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-[#0B2026]">Recent decisions</h2>
            {decisions.length > 0 && (
              <button
                onClick={() => navigate('/decisions')}
                className="text-xs text-[#FF3621] hover:underline font-medium"
              >
                View all →
              </button>
            )}
          </div>

          {loadingDecisions ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-5 w-5 animate-spin text-[#FF3621]" />
            </div>
          ) : decisions.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-2 py-8 text-center">
              <AlertTriangle className="h-6 w-6 text-muted-foreground/40" />
              <p className="text-xs text-muted-foreground">No decisions yet.</p>
              <p className="text-xs text-muted-foreground">Resolve your first cluster to see results here.</p>
            </div>
          ) : (
            <>
              <div className="divide-y divide-border/50">
                {recentDecisions.map((e) => (
                  <RecentDecisionRow key={e.id} entry={e} />
                ))}
              </div>
              {decisions.length > 0 && (
                <div className="pt-1 space-y-1.5">
                  <p className="text-[11px] font-medium text-muted-foreground uppercase tracking-wide">Outcome breakdown</p>
                  <OutcomeBar entries={decisions} />
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
