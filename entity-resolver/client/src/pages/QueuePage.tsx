import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router';
import { Search, MapPin, Building2, Layers, ArrowRight, Loader2, RefreshCw } from 'lucide-react';
import { clustersApi, type ClusterSummary } from '../lib/api';

export function QueuePage() {
  const navigate = useNavigate();
  const [clusters, setClusters] = useState<ClusterSummary[]>([]);
  const [total, setTotal] = useState<number | null>(null);
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(0);
  const PAGE_SIZE = 20;

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
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, [page, debouncedSearch]);

  useEffect(() => {
    void loadClusters();
  }, [loadClusters]);

  // Reset page on search change
  useEffect(() => { setPage(0); }, [debouncedSearch]);

  function startResolution(clusterId: string) {
    navigate(`/resolve/${clusterId}`);
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-bold text-[#0B2026]">Resolution Queue</h1>
        <p className="text-sm text-muted-foreground">
          {total !== null
            ? `${total.toLocaleString()} ambiguous facility clusters awaiting resolution`
            : 'Loading cluster count…'}
        </p>
      </div>

      {/* Search + refresh */}
      <div className="flex gap-2">
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
      </div>

      {/* Error */}
      {error && (
        <div className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}

      {/* Cluster list */}
      {loading ? (
        <div className="flex items-center justify-center py-16">
          <Loader2 className="h-6 w-6 animate-spin text-[#FF3621]" />
        </div>
      ) : clusters.length === 0 ? (
        <div className="rounded-md border border-dashed border-border bg-white py-16 text-center text-sm text-muted-foreground">
          No ambiguous clusters found{search ? ` matching "${search}"` : ''}.
        </div>
      ) : (
        <div className="space-y-2">
          {clusters.map((cluster) => {
            return (
              <div
                key={cluster.cluster_id}
                className="flex items-center gap-4 rounded-lg border border-border bg-white px-4 py-3 shadow-sm transition-shadow hover:shadow-md"
              >
                {/* Icon */}
                <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full bg-[#EEEDE9]">
                  <Building2 className="h-5 w-5 text-[#0B2026]" />
                </div>

                {/* Info */}
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate font-medium text-[#0B2026]">
                      {cluster.representative_name ?? cluster.cluster_id}
                    </span>
                  </div>
                  <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
                    {(cluster.city || cluster.country) && (
                      <span className="flex items-center gap-1">
                        <MapPin className="h-3 w-3" />
                        {[cluster.city, cluster.state, cluster.country].filter(Boolean).join(', ')}
                      </span>
                    )}
                    {cluster.facility_type && (
                      <span className="flex items-center gap-1">
                        <Building2 className="h-3 w-3" />
                        {cluster.facility_type}
                      </span>
                    )}
                    <span className="flex items-center gap-1">
                      <Layers className="h-3 w-3" />
                      {cluster.record_count} records
                    </span>
                  </div>
                </div>

                {/* Action */}
                <div className="flex-shrink-0">
                  <button
                    onClick={() => startResolution(cluster.cluster_id)}
                    className="flex items-center gap-1 rounded-md bg-[#FF3621] px-3 py-1.5 text-xs font-medium text-white hover:bg-[#e02e1a]"
                  >
                    Review <ArrowRight className="h-3 w-3" />
                  </button>
                </div>
              </div>
            );
          })}
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
