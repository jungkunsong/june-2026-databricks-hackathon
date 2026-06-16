import { useState, useEffect, useCallback } from 'react';
import { useNavigate, useLocation } from 'react-router';
import { Search, MapPin, Building2, Layers, ArrowRight, RefreshCw, CheckSquare, Square, Zap } from 'lucide-react';
import { clustersApi, type ClusterSummary } from '../lib/api';

export function QueuePage() {
  const navigate = useNavigate();
  const location = useLocation();
  const [clusters, setClusters] = useState<ClusterSummary[]>([]);
  const [total, setTotal] = useState<number | null>(null);
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(0);
  // Optimistically hidden cluster IDs — removed immediately on return from ResolvePage
  const [hiddenClusterIds, setHiddenClusterIds] = useState<Set<string>>(new Set());
  // Bulk selection
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const PAGE_SIZE = 20;

  // When navigating back from ResolvePage after a promotion, hide the resolved
  // cluster immediately (before the refetch completes) so the list feels instant.
  useEffect(() => {
    const state = location.state as { resolvedClusterId?: string } | null;
    if (state?.resolvedClusterId) {
      setHiddenClusterIds((prev) => new Set([...prev, state.resolvedClusterId!]));
      setSelected((prev) => { const next = new Set(prev); next.delete(state.resolvedClusterId!); return next; });
      setTotal((prev) => (prev !== null ? Math.max(0, prev - 1) : prev));
      window.history.replaceState({}, '');
    }
  }, [location.state]);

  // Debounce search
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search), 350);
    return () => clearTimeout(t);
  }, [search]);

  const loadClusters = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [rows, countResult] = await Promise.all([
        clustersApi.list({ limit: PAGE_SIZE, offset: page * PAGE_SIZE, search: debouncedSearch }),
        clustersApi.count(),
      ]);
      setClusters(rows);
      setTotal(countResult.total);
      setHiddenClusterIds((prev) => {
        if (prev.size === 0) return prev;
        const freshIds = new Set(rows.map((r) => r.cluster_id));
        const stillHidden = new Set([...prev].filter((id) => !freshIds.has(id)));
        return stillHidden.size === prev.size ? prev : stillHidden;
      });
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, [page, debouncedSearch]);

  useEffect(() => {
    void loadClusters();
  }, [loadClusters]);

  useEffect(() => { setPage(0); }, [debouncedSearch]);

  // Clear selection when page changes
  useEffect(() => { setSelected(new Set()); }, [page, debouncedSearch]);

  const visibleClusters = clusters.filter((c) => !hiddenClusterIds.has(c.cluster_id));

  function toggleSelect(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  function toggleSelectAll() {
    const visibleIds = visibleClusters.map((c) => c.cluster_id);
    const allSelected = visibleIds.every((id) => selected.has(id));
    if (allSelected) {
      setSelected((prev) => { const next = new Set(prev); visibleIds.forEach((id) => next.delete(id)); return next; });
    } else {
      setSelected((prev) => new Set([...prev, ...visibleIds]));
    }
  }

  function startResolution(clusterId: string) {
    navigate(`/resolve/${clusterId}`);
  }

  function startBulkValidation() {
    const ids = [...selected];
    if (ids.length === 0) return;
    navigate('/bulk-review', { state: { clusterIds: ids } });
  }

  const visibleIds = visibleClusters.map((c) => c.cluster_id);
  const allVisibleSelected = visibleIds.length > 0 && visibleIds.every((id) => selected.has(id));
  const someVisibleSelected = visibleIds.some((id) => selected.has(id));

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-bold text-[#0B2026]">Resolution Queue</h1>
        <p className="text-sm text-muted-foreground">
          {total !== null
            ? `${total.toLocaleString()} ${total === 1 ? 'facility' : 'facilities'} awaiting validation`
            : 'Loading cluster count…'}
        </p>
      </div>

      {/* Search + refresh + bulk action */}
      <div className="flex gap-2 items-center">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <input
            type="text"
            placeholder="Search by facility name…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full rounded-md border border-border bg-white py-2 pl-9 pr-4 text-sm shadow-sm focus:outline-none focus:ring-2 focus:ring-[#FF3621]/40"
          />
        </div>
        <button
          onClick={() => { void loadClusters(); }}
          className="rounded-md border border-border bg-white p-2 shadow-sm hover:bg-muted"
          title="Refresh"
        >
          <RefreshCw className="h-4 w-4 text-muted-foreground" />
        </button>
        {selected.size > 0 && (
          <button
            onClick={startBulkValidation}
            className="flex items-center gap-2 rounded-md bg-[#FF3621] px-4 py-2 text-sm font-semibold text-white hover:bg-[#e02e1a] transition-colors shadow-sm"
          >
            <Zap className="h-4 w-4" />
            Validate {selected.size} selected
          </button>
        )}
      </div>

      {/* Error */}
      {error && (
        <div className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}

      {/* Table */}
      {!loading && visibleClusters.length === 0 && !error && (
        <div className="rounded-md border border-dashed border-border bg-white py-16 text-center text-sm text-muted-foreground">
          {search ? `No facilities matching "${search}"` : 'No facilities in the queue.'}
        </div>
      )}

      {(loading || visibleClusters.length > 0) && (
        <div className="rounded-lg border border-border bg-white overflow-hidden shadow-sm">
          <table className="w-full text-sm">
            <thead className="bg-[#EEEDE9] border-b border-border">
              <tr>
                {/* Select-all checkbox */}
                <th className="w-10 px-3 py-3">
                  <button
                    onClick={toggleSelectAll}
                    className="flex items-center justify-center text-muted-foreground hover:text-[#0B2026] transition-colors"
                    title={allVisibleSelected ? 'Deselect all' : 'Select all'}
                  >
                    {allVisibleSelected
                      ? <CheckSquare className="h-4 w-4 text-[#FF3621]" />
                      : someVisibleSelected
                        ? <CheckSquare className="h-4 w-4 text-[#FF3621]/50" />
                        : <Square className="h-4 w-4" />
                    }
                  </button>
                </th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-[#0B2026]">Facility</th>
                <th className="hidden px-4 py-3 text-left text-xs font-semibold text-[#0B2026] md:table-cell">Location</th>
                <th className="hidden px-4 py-3 text-left text-xs font-semibold text-[#0B2026] sm:table-cell">Records</th>
                <th className="w-10 px-3 py-3" />
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {loading
                ? Array.from({ length: 5 }).map((_, i) => (
                    <tr key={i} className="animate-pulse">
                      <td className="px-3 py-4"><div className="h-4 w-4 rounded bg-muted" /></td>
                      <td className="px-4 py-4"><div className="h-4 w-48 rounded bg-muted" /></td>
                      <td className="hidden px-4 py-4 md:table-cell"><div className="h-4 w-32 rounded bg-muted" /></td>
                      <td className="hidden px-4 py-4 sm:table-cell"><div className="h-4 w-12 rounded bg-muted" /></td>
                      <td className="px-3 py-4" />
                    </tr>
                  ))
                : visibleClusters.map((cluster) => {
                    const isSelected = selected.has(cluster.cluster_id);
                    return (
                      <tr
                        key={cluster.cluster_id}
                        className={`transition-colors cursor-pointer ${isSelected ? 'bg-[#FF3621]/5' : 'hover:bg-[#F9F7F4]'}`}
                        onClick={() => toggleSelect(cluster.cluster_id)}
                      >
                        {/* Checkbox */}
                        <td className="px-3 py-4" onClick={(e) => e.stopPropagation()}>
                          <button
                            onClick={() => toggleSelect(cluster.cluster_id)}
                            className="flex items-center justify-center text-muted-foreground hover:text-[#FF3621] transition-colors"
                          >
                            {isSelected
                              ? <CheckSquare className="h-4 w-4 text-[#FF3621]" />
                              : <Square className="h-4 w-4" />
                            }
                          </button>
                        </td>

                        {/* Facility name + type */}
                        <td className="px-4 py-4">
                          <div className="font-medium text-[#0B2026] leading-tight">{cluster.representative_name}</div>
                          {cluster.facility_type && (
                            <div className="mt-0.5 flex items-center gap-1 text-xs text-muted-foreground">
                              <Building2 className="h-3 w-3" />
                              {cluster.facility_type}
                            </div>
                          )}
                        </td>

                        {/* Location */}
                        <td className="hidden px-4 py-4 md:table-cell">
                          {(cluster.city || cluster.country) && (
                            <div className="flex items-center gap-1 text-xs text-muted-foreground">
                              <MapPin className="h-3 w-3 flex-shrink-0" />
                              {[cluster.city, cluster.state, cluster.country].filter(Boolean).join(', ')}
                            </div>
                          )}
                        </td>

                        {/* Record count */}
                        <td className="hidden px-4 py-4 sm:table-cell">
                          <div className="flex items-center gap-1 text-xs text-muted-foreground">
                            <Layers className="h-3 w-3" />
                            {cluster.record_count} records
                          </div>
                        </td>

                        {/* Validate button — stops propagation so click doesn't toggle checkbox */}
                        <td className="px-3 py-4" onClick={(e) => e.stopPropagation()}>
                          <button
                            onClick={() => startResolution(cluster.cluster_id)}
                            className="flex items-center gap-1.5 rounded-md border border-border bg-white px-2.5 py-1.5 text-xs font-medium text-muted-foreground hover:bg-[#FF3621] hover:text-white hover:border-[#FF3621] transition-colors whitespace-nowrap"
                            title="Validate this cluster"
                          >
                            <ArrowRight className="h-3 w-3" />
                            Validate
                          </button>
                        </td>
                      </tr>
                    );
                  })
              }
            </tbody>
          </table>
        </div>
      )}

      {/* Pagination */}
      {!loading && total !== null && total > PAGE_SIZE && (
        <div className="flex items-center justify-between text-sm text-muted-foreground">
          <span>
            Showing {page * PAGE_SIZE + 1}–{Math.min((page + 1) * PAGE_SIZE, total)} of {total.toLocaleString()}
          </span>
          <div className="flex gap-2">
            <button
              onClick={() => setPage((p) => Math.max(0, p - 1))}
              disabled={page === 0}
              className="rounded-md border border-border bg-white px-3 py-1.5 text-xs hover:bg-muted disabled:opacity-40"
            >
              Previous
            </button>
            <button
              onClick={() => setPage((p) => p + 1)}
              disabled={(page + 1) * PAGE_SIZE >= total}
              className="rounded-md border border-border bg-white px-3 py-1.5 text-xs hover:bg-muted disabled:opacity-40"
            >
              Next
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
