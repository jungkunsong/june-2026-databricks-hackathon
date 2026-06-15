import { useState, useEffect } from 'react';
import { Loader2, CheckCircle2, XCircle, Clock, GitMerge, AlertCircle } from 'lucide-react';
import { decisionsApi, type Decision } from '../lib/api';

const OUTCOME_CONFIG: Record<string, { label: string; color: string; icon: typeof CheckCircle2 }> = {
  merged: { label: 'Merged', color: 'text-green-700 bg-green-100', icon: GitMerge },
  split: { label: 'Split', color: 'text-blue-700 bg-blue-100', icon: XCircle },
  confirmed_duplicate: { label: 'Duplicate', color: 'text-purple-700 bg-purple-100', icon: CheckCircle2 },
  confirmed_distinct: { label: 'Distinct', color: 'text-sky-700 bg-sky-100', icon: XCircle },
  deferred: { label: 'Deferred', color: 'text-gray-600 bg-gray-100', icon: Clock },
};

export function DecisionsPage() {
  const [decisions, setDecisions] = useState<(Decision & { cluster_id: string })[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    decisionsApi.list()
      .then(setDecisions)
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  }, []);

  // Summary counts
  const counts = decisions.reduce<Record<string, number>>((acc, d) => {
    acc[d.outcome] = (acc[d.outcome] ?? 0) + 1;
    return acc;
  }, {});

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-[#0B2026]">Resolution Decisions</h1>
        <p className="text-sm text-muted-foreground">Audit log of all completed resolutions</p>
      </div>

      {/* Summary cards */}
      {!loading && decisions.length > 0 && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {Object.entries(OUTCOME_CONFIG).map(([outcome, { label, color, icon: Icon }]) => (
            <div key={outcome} className="rounded-lg border border-border bg-white p-4 shadow-sm">
              <div className="flex items-center gap-2">
                <span className={`rounded-full p-1.5 ${color}`}>
                  <Icon className="h-3.5 w-3.5" />
                </span>
                <span className="text-xs text-muted-foreground">{label}</span>
              </div>
              <p className="mt-2 text-2xl font-bold text-[#0B2026]">{counts[outcome] ?? 0}</p>
            </div>
          ))}
        </div>
      )}

      {/* Error */}
      {error && (
        <div className="flex items-center gap-2 rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          <AlertCircle className="h-4 w-4 flex-shrink-0" />
          {error}
        </div>
      )}

      {/* Table */}
      {loading ? (
        <div className="flex items-center justify-center py-16">
          <Loader2 className="h-6 w-6 animate-spin text-[#FF3621]" />
        </div>
      ) : decisions.length === 0 ? (
        <div className="rounded-md border border-dashed border-border bg-white py-16 text-center text-sm text-muted-foreground">
          No decisions yet. Start resolving clusters from the queue.
        </div>
      ) : (
        <div className="overflow-hidden rounded-lg border border-border bg-white shadow-sm">
          <table className="w-full text-sm">
            <thead className="border-b border-border bg-[#EEEDE9]">
              <tr>
                <th className="px-4 py-2.5 text-left text-xs font-semibold text-[#0B2026]">Cluster</th>
                <th className="px-4 py-2.5 text-left text-xs font-semibold text-[#0B2026]">Outcome</th>
                <th className="hidden px-4 py-2.5 text-left text-xs font-semibold text-[#0B2026] sm:table-cell">Confidence</th>
                <th className="hidden px-4 py-2.5 text-left text-xs font-semibold text-[#0B2026] md:table-cell">Decided By</th>
                <th className="px-4 py-2.5 text-left text-xs font-semibold text-[#0B2026]">Date</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {decisions.map((d) => {
                const cfg = OUTCOME_CONFIG[d.outcome] ?? { label: d.outcome, color: 'text-gray-600 bg-gray-100', icon: AlertCircle };
                const Icon = cfg.icon;
                return (
                  <tr key={d.id} className="hover:bg-[#F9F7F4]">
                    <td className="px-4 py-3">
                      <span className="font-mono text-xs text-muted-foreground">
                        {d.cluster_id.slice(0, 16)}…
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${cfg.color}`}>
                        <Icon className="h-3 w-3" />
                        {cfg.label}
                      </span>
                    </td>
                    <td className="hidden px-4 py-3 sm:table-cell">
                      {d.confidence != null ? (
                        <div className="flex items-center gap-2">
                          <div className="h-1.5 w-16 overflow-hidden rounded-full bg-[#EEEDE9]">
                            <div
                              className="h-full rounded-full bg-[#FF3621]"
                              style={{ width: `${Math.round(Number(d.confidence) * 100)}%` }}
                            />
                          </div>
                          <span className="text-xs text-muted-foreground">
                            {Math.round(Number(d.confidence) * 100)}%
                          </span>
                        </div>
                      ) : (
                        <span className="text-xs text-muted-foreground">—</span>
                      )}
                    </td>
                    <td className="hidden px-4 py-3 text-xs text-muted-foreground md:table-cell">
                      {d.decided_by}
                    </td>
                    <td className="px-4 py-3 text-xs text-muted-foreground">
                      {new Date(d.created_at).toLocaleDateString()}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
