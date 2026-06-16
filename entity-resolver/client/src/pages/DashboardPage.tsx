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
  Search,
  GitMerge,
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
  score,
  description,
  signals,
}: {
  icon: typeof Globe;
  iconBg: string;
  name: string;
  score: string;
  description: string;
  signals: string[];
}) {
  return (
    <div className="rounded-xl border border-border bg-white px-5 py-4 shadow-sm space-y-3 hover:shadow-md transition-shadow">
      <div className="flex items-center gap-3">
        <div className={`flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg ${iconBg}`}>
          <Icon className="h-4 w-4" />
        </div>
        <div className="min-w-0">
          <p className="text-xs font-semibold text-[#0B2026]">{name}</p>
          <p className="text-[10px] text-muted-foreground font-mono">{score}</p>
        </div>
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
      score: 'page_presence_score · 0–20',
      description: 'Live HTTP check on officialWebsite. Scores domain authority, SSL, content relevance, and page recency.',
      signals: ['HTTP status', 'SSL cert', 'domain age', 'content match', 'recency'],
    },
    {
      icon: Phone,
      iconBg: 'bg-green-50 text-green-600',
      name: 'Phone Validator',
      score: 'phone_score · 0–20',
      description: 'Validates Indian phone numbers via libphonenumber — checks format, STD code, and geographic plausibility against the facility\'s pincode.',
      signals: ['E.164 format', 'STD code', 'pincode match', 'mobile vs. landline'],
    },
    {
      icon: MapPin,
      iconBg: 'bg-amber-50 text-amber-600',
      name: 'Location Validator',
      score: 'location_score · 0–20',
      description: 'Cross-references lat/lon, pincode, city, and state against a reference directory. Flags coordinate–address mismatches within 20 km.',
      signals: ['lat/lon', 'pincode', 'city', 'state', 'distance check'],
    },
    {
      icon: Facebook,
      iconBg: 'bg-indigo-50 text-indigo-600',
      name: 'Social Validator',
      score: 'social_score · 0–20',
      description: 'Scores Facebook page presence (0–16) plus cross-field validation of the social handle against the facility name and address (0–4).',
      signals: ['page exists', 'follower count', 'activity', 'name match', 'address match'],
    },
    {
      icon: BookOpen,
      iconBg: 'bg-purple-50 text-purple-600',
      name: 'Context Validator',
      score: 'context_score · 0–20',
      description: 'Evaluates six contextual fields — specialties, procedures, equipment, capabilities, description, and doctor/capacity counts — for internal coherence.',
      signals: ['specialties', 'procedures', 'equipment', 'capacity', 'description', 'doctor count'],
    },
    {
      icon: Star,
      iconBg: 'bg-rose-50 text-rose-600',
      name: 'Source Authority',
      score: 'source_authority_score · 0–20',
      description: 'Tiers each URL in source_urls from authoritative (gov, WHO, Wikipedia) down to noise (real-estate portals). Score = MAX tier across all sources.',
      signals: ['gov/WHO', 'official site', 'Practo', 'JustDial', 'proptiger.com'],
    },
    {
      icon: Copy,
      iconBg: 'bg-teal-50 text-teal-600',
      name: 'Duplicate Detector',
      score: 'merge_recommendation · definite/likely/possible/none',
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
              <p className="text-[11px] font-semibold uppercase tracking-widest text-[#FF3621] mb-1">
                Building and Optimizing the Facility Trust Desk
              </p>
              <h1 className="text-2xl font-bold text-[#0B2026] leading-tight">
                Medical Facility Entity Resolver
              </h1>
            </div>
            <p className="mt-1.5 text-sm text-muted-foreground max-w-2xl leading-relaxed">
              A multi-agent AI pipeline that resolves, validates, and deduplicates Indian medical facility records
              at scale — combining live web signals, geospatial checks, and clinical context scoring to produce
              a trusted, production-ready dataset.
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

        {/* Pipeline overview strip */}
        <div className="mt-6 pt-5 border-t border-border flex flex-wrap items-center gap-2 text-[11px] font-medium text-muted-foreground">
          <span className="flex items-center gap-1.5 rounded-full bg-muted px-3 py-1">
            <Search className="h-3 w-3" /> Evidence fetcher
          </span>
          <ArrowRight className="h-3 w-3 text-border flex-shrink-0" />
          <span className="flex items-center gap-1.5 rounded-full bg-muted px-3 py-1">
            <Brain className="h-3 w-3" /> 7 parallel sub-agents
          </span>
          <ArrowRight className="h-3 w-3 text-border flex-shrink-0" />
          <span className="flex items-center gap-1.5 rounded-full bg-muted px-3 py-1">
            <GitMerge className="h-3 w-3" /> Supervisor synthesis
          </span>
          <ArrowRight className="h-3 w-3 text-border flex-shrink-0" />
          <span className="flex items-center gap-1.5 rounded-full bg-[#FF3621]/10 text-[#FF3621] px-3 py-1 border border-[#FF3621]/20">
            <ShieldCheck className="h-3 w-3" /> Promotion proposal
          </span>
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

        {/* How it works */}
        <div className="rounded-xl border border-border bg-white px-6 py-5 shadow-sm space-y-4">
          <h2 className="text-sm font-semibold text-[#0B2026]">How it works</h2>
          <ol className="space-y-3">
            {[
              { icon: Layers,      color: 'text-amber-600 bg-amber-50',   step: '1', title: 'Pick a cluster', body: 'Select an ambiguous facility cluster from the resolution queue. Each cluster groups duplicate or conflicting source records.' },
              { icon: Sparkles,    color: 'text-blue-600 bg-blue-50',     step: '2', title: 'Run AI verification', body: 'The Supervisor dispatches up to 7 sub-agents in parallel — website, contacts, social, context, source authority, and duplicate detection.' },
              { icon: GitMerge,    color: 'text-purple-600 bg-purple-50', step: '3', title: 'Review the proposal', body: 'Inspect per-agent scores, field-by-field findings, and the Supervisor\'s confidence rating. Edit any values and add reviewer notes.' },
              { icon: ShieldCheck, color: 'text-green-600 bg-green-50',   step: '4', title: 'Approve or defer', body: 'Approve to write a clean, verified record to the resolved dataset — or defer for manual review.' },
            ].map(({ color, step, title, body }) => (
              <li key={step} className="flex gap-3">
                <div className={`mt-0.5 flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full text-xs font-bold ${color}`}>
                  {step}
                </div>
                <div>
                  <p className="text-xs font-semibold text-[#0B2026]">{title}</p>
                  <p className="text-xs text-muted-foreground leading-relaxed">{body}</p>
                </div>
              </li>
            ))}
          </ol>
          <button
            onClick={() => navigate('/queue')}
            className="mt-2 w-full flex items-center justify-center gap-2 rounded-lg border border-[#FF3621] px-4 py-2 text-xs font-semibold text-[#FF3621] hover:bg-[#FF3621]/5 transition-colors"
          >
            Open resolution queue <ArrowRight className="h-3.5 w-3.5" />
          </button>
        </div>

        {/* Recent decisions */}
        <div className="rounded-xl border border-border bg-white px-6 py-5 shadow-sm space-y-4">
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
