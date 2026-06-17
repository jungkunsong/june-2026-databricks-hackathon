import { useState, useEffect, useMemo } from 'react';
import { trustScore, trustLabel, trustColor } from './ResolvePage';
import {
  Loader2,
  CheckCircle2,
  AlertTriangle,
  Clock,
  GitBranch,
  ChevronDown,
  ChevronUp,
  RefreshCw,
  Bot,
  AlertCircle,
  RotateCcw,
  Pencil,
  Search,
  ChevronsUpDown,
} from 'lucide-react';
import { useNavigate } from 'react-router';
import { decisionLogApi, type DecisionLogEntry } from '../lib/api';

// ── Outcome config — matches PRD §7.1 and decision_log.outcome column ─────────

const OUTCOME_CONFIG: Record<string, {
  label: string;
  textColor: string;
  bgColor: string;
  icon: typeof CheckCircle2;
}> = {
  verified:  { label: 'Verified',  textColor: 'text-green-700', bgColor: 'bg-green-100',  icon: CheckCircle2  },
  corrected: { label: 'Corrected', textColor: 'text-blue-700',  bgColor: 'bg-blue-100',   icon: GitBranch     },
  partial:   { label: 'Partial',   textColor: 'text-amber-700', bgColor: 'bg-amber-100',  icon: AlertTriangle },
  deferred:  { label: 'Deferred',  textColor: 'text-gray-600',  bgColor: 'bg-gray-100',   icon: Clock         },
};

const VERIFICATION_STATUS_STYLE: Record<string, string> = {
  verified:     'text-green-700 bg-green-50',
  corrected:    'text-blue-700 bg-blue-50',
  unverifiable: 'text-amber-700 bg-amber-50',
  skipped:      'text-gray-500 bg-gray-50',
};

// ── Sub-components ────────────────────────────────────────────────────────────

function OutcomeBadge({ outcome }: { outcome: string }) {
  const cfg = OUTCOME_CONFIG[outcome] ?? {
    label: outcome,
    textColor: 'text-gray-600',
    bgColor: 'bg-gray-100',
    icon: AlertCircle,
  };
  const Icon = cfg.icon;
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${cfg.textColor} ${cfg.bgColor}`}>
      <Icon className="h-3 w-3" />
      {cfg.label}
    </span>
  );
}

function VerificationsTable({ verifications }: { verifications: DecisionLogEntry['verifications'] }) {
  if (!verifications || verifications.length === 0) return null;
  return (
    <table className="w-full text-xs mt-2">
      <thead>
        <tr className="border-b border-border">
          <th className="pb-1 text-left font-semibold text-muted-foreground w-32">Field</th>
          <th className="pb-1 text-left font-semibold text-muted-foreground w-28">Status</th>
          <th className="pb-1 text-left font-semibold text-muted-foreground">Notes / Correction</th>
        </tr>
      </thead>
      <tbody className="divide-y divide-border/50">
        {verifications.map((v, i) => (
          <tr key={i}>
            <td className="py-1.5 pr-3 font-mono text-[11px] text-[#0B2026]">{v.field}</td>
            <td className="py-1.5 pr-3">
              <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${VERIFICATION_STATUS_STYLE[v.status] ?? 'text-gray-500 bg-gray-50'}`}>
                {v.status}
              </span>
            </td>
            <td className="py-1.5 text-muted-foreground leading-snug">
              {v.supervisor_reasoning ?? ''}
              {v.old_value != null && v.new_value != null && (
                <span className="ml-1.5 font-mono text-[10px]">
                  <span className="text-red-500 line-through">{v.old_value}</span>
                  {' → '}
                  <span className="text-green-600">{v.new_value}</span>
                </span>
              )}
              {!v.supervisor_reasoning && v.old_value == null && '—'}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function DecisionRow({ entry }: { entry: DecisionLogEntry }) {
  const [expanded, setExpanded] = useState(false);
  const navigate = useNavigate();
  const hasDetail = !!(
    entry.reasoning ||
    (entry.verifications && entry.verifications.length > 0) ||
    entry.human_notes ||
    (entry.agent_scores && entry.agent_scores.length > 0)
  );

  return (
    <>
      <tr
        className={`hover:bg-[#F9F7F4] transition-colors ${hasDetail ? 'cursor-pointer' : ''}`}
        onClick={() => hasDetail && setExpanded((e) => !e)}
      >
        {/* Facility */}
        <td className="px-4 py-3">
          <div className="font-medium text-[#0B2026] text-sm leading-tight">
            {entry.facility_name ?? (
              <span className="text-muted-foreground italic">Unknown facility</span>
            )}
          </div>
          <div className="text-[11px] text-muted-foreground font-mono mt-0.5">
            row {entry.raw_row_id ?? '—'}
          </div>
        </td>

        {/* Outcome */}
        <td className="px-4 py-3">
          <OutcomeBadge outcome={entry.outcome} />
        </td>

        {/* Trust Score */}
        <td className="hidden px-4 py-3 sm:table-cell">
          {entry.agent_scores && entry.agent_scores.length > 0 ? (() => {
            const total = trustScore(entry.agent_scores);
            return (
              <span className={`text-xs font-semibold tabular-nums ${trustColor(total)}`}>
                {total}/100 — {trustLabel(total)}
              </span>
            );
          })() : (
            <span className="text-xs text-muted-foreground">—</span>
          )}
        </td>

        {/* Agents consulted */}
        <td className="hidden px-4 py-3 md:table-cell">
          {entry.agents_consulted && entry.agents_consulted.length > 0 ? (
            <div className="flex flex-wrap gap-1">
              {entry.agents_consulted.map((a) => (
                <span
                  key={a}
                  className="rounded bg-[#EEEDE9] px-1.5 py-0.5 text-[10px] font-medium text-[#0B2026]"
                >
                  {a}
                </span>
              ))}
            </div>
          ) : (
            <span className="text-xs text-muted-foreground">—</span>
          )}
        </td>

        {/* Date */}
        <td className="px-4 py-3 text-xs text-muted-foreground whitespace-nowrap">
          {new Date(entry.decided_at).toLocaleDateString(undefined, {
            month: 'short',
            day: 'numeric',
            year: 'numeric',
          })}
        </td>

        {/* Expand toggle */}
        <td className="px-3 py-3 text-muted-foreground">
          {hasDetail && (
            expanded
              ? <ChevronUp className="h-3.5 w-3.5" />
              : <ChevronDown className="h-3.5 w-3.5" />
          )}
        </td>
      </tr>

      {/* Expanded detail panel */}
      {expanded && (
        <tr className="bg-[#F9F7F4]">
          <td colSpan={6} className="px-6 pb-5 pt-3">
            <div className="space-y-4">

              {/* Supervisor reasoning */}
              {entry.reasoning && (
                <div>
                  <div className="flex items-center gap-1.5 mb-1.5">
                    <Bot className="h-3.5 w-3.5 text-[#0B2026]" />
                    <span className="text-xs font-semibold text-[#0B2026]">Supervisor reasoning</span>
                  </div>
                  <p className="text-xs text-muted-foreground leading-relaxed pl-4 border-l-2 border-[#FF3621]/40">
                    {entry.reasoning}
                  </p>
                </div>
              )}

              {/* Per-field verifications */}
              {entry.verifications && entry.verifications.length > 0 && (
                <div>
                  <span className="text-xs font-semibold text-[#0B2026]">Field verifications</span>
                  <VerificationsTable verifications={entry.verifications} />
                </div>
              )}

              {/* Human notes */}
              {entry.human_notes && (
                <div>
                  <span className="text-xs font-semibold text-[#0B2026]">Reviewer notes</span>
                  <p className="text-xs text-muted-foreground mt-1 leading-relaxed">
                    {entry.human_notes}
                  </p>
                </div>
              )}

              {/* Agent trust scores */}
              {entry.agent_scores && entry.agent_scores.length > 0 && (
                <div>
                  <span className="text-xs font-semibold text-[#0B2026]">Agent trust scores</span>
                  <div className="mt-2 space-y-2">
                    {entry.agent_scores.map((s) => {
                      const pct = (s.score / 20) * 100;
                      const color = s.score >= 17 ? 'bg-green-500' : s.score >= 13 ? 'bg-green-400' : s.score >= 9 ? 'bg-amber-400' : s.score >= 5 ? 'bg-orange-400' : 'bg-red-500';
                      const textColor = s.score >= 13 ? 'text-green-700' : s.score >= 9 ? 'text-amber-600' : s.score >= 5 ? 'text-orange-600' : 'text-red-600';
                      return (
                        <div key={s.agent}>
                          <div className="flex items-center gap-2 mb-0.5">
                            <span className="text-[11px] font-medium text-[#0B2026] w-36 truncate">{s.agent}</span>
                            <div className="flex-1 h-1.5 rounded-full bg-muted overflow-hidden">
                              <div className={`h-full rounded-full ${color}`} style={{ width: `${pct}%` }} />
                            </div>
                            <span className={`text-[10px] font-semibold tabular-nums w-10 text-right ${textColor}`}>{s.score}/20</span>
                          </div>
                          {s.rationale && (
                            <p className="text-[10px] text-muted-foreground leading-snug pl-[9.5rem]">{s.rationale}</p>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Actions */}
              {entry.cluster_id && (
                <div className="flex items-center gap-2 pt-1 border-t border-border/50">
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      navigate(`/resolve/${entry.cluster_id}`, { state: { rerun: true } });
                    }}
                    className="inline-flex items-center gap-1.5 rounded-md border border-border bg-white px-3 py-1.5 text-xs font-medium text-[#0B2026] shadow-sm hover:bg-muted transition-colors"
                  >
                    <RotateCcw className="h-3 w-3" />
                    Re-run validation
                  </button>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      navigate(`/resolve/${entry.cluster_id}`, { state: { refine: entry } });
                    }}
                    className="inline-flex items-center gap-1.5 rounded-md border border-border bg-white px-3 py-1.5 text-xs font-medium text-[#0B2026] shadow-sm hover:bg-muted transition-colors"
                  >
                    <Pencil className="h-3 w-3" />
                    Refine data
                  </button>
                </div>
              )}
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export function DecisionsPage() {
  const [entries, setEntries] = useState<DecisionLogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Search + sort state
  const [search, setSearch] = useState('');
  const [scoreSort, setScoreSort] = useState<'none' | 'asc' | 'desc'>('none');

  function load() {
    setLoading(true);
    setError(null);
    decisionLogApi
      .list()
      .then(setEntries)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }

  useEffect(() => { load(); }, []);

  // Summary counts by outcome
  const counts = entries.reduce<Record<string, number>>((acc, e) => {
    acc[e.outcome] = (acc[e.outcome] ?? 0) + 1;
    return acc;
  }, {});

  // Filtered + sorted entries
  const displayedEntries = useMemo(() => {
    let result = entries;

    // Filter by name search
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      result = result.filter((e) =>
        (e.facility_name ?? '').toLowerCase().includes(q)
      );
    }

    // Sort by trust score
    if (scoreSort !== 'none') {
      result = [...result].sort((a, b) => {
        const ta = trustScore(a.agent_scores);
        const tb = trustScore(b.agent_scores);
        return scoreSort === 'asc' ? ta - tb : tb - ta;
      });
    }

    return result;
  }, [entries, search, scoreSort]);

  function cycleScoreSort() {
    setScoreSort((prev) =>
      prev === 'none' ? 'desc' : prev === 'desc' ? 'asc' : 'none'
    );
  }

  return (
    <div className="space-y-6">

      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-[#0B2026]">Resolution Decisions</h1>
          <p className="text-sm text-muted-foreground">
            Audit log of all promoted records — written by the Supervisor agent
          </p>
        </div>
        <button
          onClick={load}
          className="rounded-md border border-border bg-white p-2 shadow-sm hover:bg-muted"
          title="Refresh"
        >
          <RefreshCw className="h-4 w-4 text-muted-foreground" />
        </button>
      </div>

      {/* Summary cards */}
      {!loading && entries.length > 0 && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {Object.entries(OUTCOME_CONFIG).map(([outcome, { label, textColor, icon: Icon }]) => (
            <div key={outcome} className="rounded-lg border border-border bg-white px-4 py-3 shadow-sm">
              <div className="flex items-center gap-2">
                <Icon className={`h-4 w-4 ${textColor}`} />
                <span className="text-xs font-medium text-muted-foreground">{label}</span>
              </div>
              <p className="mt-1 text-2xl font-bold text-[#0B2026]">{counts[outcome] ?? 0}</p>
            </div>
          ))}
        </div>
      )}

      {/* Search box */}
      {!loading && entries.length > 0 && (
        <div className="relative max-w-sm">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <input
            type="text"
            placeholder="Search by facility name…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full rounded-md border border-border bg-white py-2 pl-9 pr-4 text-sm shadow-sm focus:outline-none focus:ring-2 focus:ring-[#FF3621]/40"
          />
        </div>
      )}

      {/* Error */}
      {error && (
        <div className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}

      {/* Table */}
      {loading ? (
        <div className="flex items-center justify-center py-16">
          <Loader2 className="h-6 w-6 animate-spin text-[#FF3621]" />
        </div>
      ) : entries.length === 0 ? (
        <div className="rounded-md border border-dashed border-border bg-white py-16 text-center text-sm text-muted-foreground">
          No decisions yet. Start resolving clusters from the queue.
        </div>
      ) : (
        <div className="overflow-hidden rounded-lg border border-border bg-white shadow-sm">
          <table className="w-full text-sm">
            <thead className="border-b border-border bg-[#EEEDE9]">
              <tr>
                <th className="px-4 py-2.5 text-left text-xs font-semibold text-[#0B2026]">Facility</th>
                <th className="px-4 py-2.5 text-left text-xs font-semibold text-[#0B2026]">Outcome</th>
                {/* Clickable trust score header */}
                <th className="hidden px-4 py-2.5 text-left text-xs font-semibold text-[#0B2026] sm:table-cell">
                  <button
                    onClick={cycleScoreSort}
                    className="inline-flex items-center gap-1 hover:text-[#FF3621] transition-colors"
                    title="Sort by trust score"
                  >
                    Trust Score
                    {scoreSort === 'none' && <ChevronsUpDown className="h-3 w-3 text-muted-foreground" />}
                    {scoreSort === 'desc' && <ChevronDown className="h-3 w-3 text-[#FF3621]" />}
                    {scoreSort === 'asc'  && <ChevronUp   className="h-3 w-3 text-[#FF3621]" />}
                  </button>
                </th>
                <th className="hidden px-4 py-2.5 text-left text-xs font-semibold text-[#0B2026] md:table-cell">Agents</th>
                <th className="px-4 py-2.5 text-left text-xs font-semibold text-[#0B2026]">Date</th>
                <th className="px-3 py-2.5" />
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {displayedEntries.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-4 py-10 text-center text-sm text-muted-foreground">
                    No results for &ldquo;{search}&rdquo;
                  </td>
                </tr>
              ) : (
                displayedEntries.map((entry) => (
                  <DecisionRow key={entry.id} entry={entry} />
                ))
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
