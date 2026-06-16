import { useState, useEffect, useCallback, useRef } from 'react';
import { useLocation, useNavigate } from 'react-router';
import {
  ArrowLeft,
  CheckCircle2,
  Clock,
  Loader2,
  ChevronDown,
  ChevronUp,
  X,
  Check,
  AlertTriangle,
} from 'lucide-react';
import {
  clustersApi,
  tasksApi,
  promoteApi,
  mergeApi,
  type FacilityRecord,
  type ResolutionTask,
} from '../lib/api';
import { AgentChat } from './agents/AgentChat';
import {
  parseProposal,
  buildInitialMessage,
  FieldApprovalTable,
  TrustScorePanel,
  type PromotionProposal,
  type FieldDecision,
  type AgentScore,
} from './ResolvePage';

// ── Types ─────────────────────────────────────────────────────────────────────

type ItemStatus = 'pending' | 'running' | 'done' | 'deferred' | 'error';

interface BulkItem {
  clusterId: string;
  facilityName: string | null;
  status: ItemStatus;
  proposal: PromotionProposal | null;
  task: ResolutionTask | null;
  error: string | null;
}

// ── Status badge ──────────────────────────────────────────────────────────────

const STATUS_BADGE: Record<ItemStatus, { label: string; cls: string }> = {
  pending:  { label: 'Pending',  cls: 'bg-gray-100 text-gray-600 border-gray-200' },
  running:  { label: 'Running',  cls: 'bg-blue-100 text-blue-700 border-blue-200' },
  done:     { label: 'Done',     cls: 'bg-green-100 text-green-700 border-green-200' },
  deferred: { label: 'Deferred', cls: 'bg-amber-100 text-amber-700 border-amber-200' },
  error:    { label: 'Error',    cls: 'bg-red-100 text-red-700 border-red-200' },
};

function StatusBadge({ status }: { status: ItemStatus }) {
  const { label, cls } = STATUS_BADGE[status];
  return (
    <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-semibold ${cls}`}>
      {status === 'running' && <Loader2 className="mr-1 h-2.5 w-2.5 animate-spin" />}
      {status === 'done'    && <Check   className="mr-1 h-2.5 w-2.5" />}
      {status === 'deferred'&& <Clock   className="mr-1 h-2.5 w-2.5" />}
      {status === 'error'   && <AlertTriangle className="mr-1 h-2.5 w-2.5" />}
      {label}
    </span>
  );
}

// ── Per-cluster review panel ──────────────────────────────────────────────────

interface ClusterPanelProps {
  item: BulkItem;
  initialMessage: string;
  agentStarted: boolean;
  onApprove: (decisions: Record<string, FieldDecision>, humanNotes: string) => Promise<void>;
  onDefer:   (humanNotes: string) => Promise<void>;
  promoting: boolean;
  promoteError: string | null;
  onProposalChange: (p: PromotionProposal | null) => void;
  onScoresChange: (s: AgentScore[] | null) => void;
  frozenScores: AgentScore[] | null;
}

function ClusterPanel({
  item,
  initialMessage,
  agentStarted,
  onApprove,
  onDefer,
  promoting,
  promoteError,
  onProposalChange,
  onScoresChange,
  frozenScores,
}: ClusterPanelProps) {
  const [agentMessages, setAgentMessages] = useState<{ role: string; content: string }[]>([]);
  const [agentStreaming, setAgentStreaming] = useState(false);
  const [decisions, setDecisions] = useState<Record<string, FieldDecision>>({});
  const [humanNotes, setHumanNotes] = useState('');
  const [chatCollapsed, setChatCollapsed] = useState(false);
  const [proposalCollapsed, setProposalCollapsed] = useState(false);

  // Parse proposal from agent messages
  useEffect(() => {
    if (agentMessages.length === 0) return;
    const parsed = parseProposal(agentMessages);
    onProposalChange(parsed);
    if (parsed) {
      if (parsed.agent_scores && parsed.agent_scores.length > 0) {
        onScoresChange(parsed.agent_scores);
      }
      setDecisions((prev) => {
        const next = { ...prev };
        for (const f of parsed.fields) {
          if (!(f.field in next)) {
            next[f.field] = { action: 'accept', overrideValue: '' };
          }
        }
        return next;
      });
      // Auto-expand proposal pane when proposal arrives
      if (!agentStreaming) setProposalCollapsed(false);
    }
  }, [agentMessages, agentStreaming, onProposalChange, onScoresChange]);

  const proposal = item.proposal;
  const mergeIntoRowId = proposal?.merge_into_row_id ?? null;

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* Chat + proposal split */}
      <div className="flex flex-col flex-1 min-h-0 overflow-hidden rounded-lg border border-border bg-white">
        {/* Chat pane */}
        <div className={`flex flex-col min-h-0 border-b border-border transition-all ${chatCollapsed ? 'flex-[0_0_auto]' : 'flex-1'}`}>
          <button
            onClick={() => setChatCollapsed((v) => !v)}
            className="flex w-full items-center justify-between px-3 py-1.5 bg-[#F4F2EE] border-b border-border/60 flex-shrink-0 cursor-pointer hover:bg-[#EEEDE9] transition-colors"
          >
            <span className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              {agentStreaming && <Loader2 className="h-3 w-3 animate-spin text-blue-500" />}
              Supervisor chat
            </span>
            {chatCollapsed
              ? <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
              : <ChevronUp   className="h-3.5 w-3.5 text-muted-foreground" />
            }
          </button>
          <div className={`flex-1 min-h-0 overflow-hidden ${chatCollapsed ? 'hidden' : ''}`}>
            {/* key=clusterId forces remount per cluster — correct for fresh agent */}
            <AgentChat
              key={item.clusterId}
              initialMessage={initialMessage}
              started={agentStarted}
              placeholder="Reply to Supervisor…"
              onStreamingChange={setAgentStreaming}
              onMessagesChange={setAgentMessages}
            />
          </div>
        </div>

        {/* Proposal pane */}
        {proposal && (
          <div className={`flex flex-col min-h-0 bg-[#FAFAF9] transition-all ${proposalCollapsed ? 'flex-[0_0_auto]' : 'flex-1 overflow-y-auto'}`}>
            <button
              onClick={() => setProposalCollapsed((v) => !v)}
              className="flex w-full items-center justify-between px-3 py-1.5 bg-[#F4F2EE] border-b border-border/60 flex-shrink-0 cursor-pointer hover:bg-[#EEEDE9] transition-colors"
            >
              <span className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                <CheckCircle2 className="h-3 w-3 text-green-600" />
                Review &amp; approve
              </span>
              {proposalCollapsed
                ? <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
                : <ChevronUp   className="h-3.5 w-3.5 text-muted-foreground" />
              }
            </button>
            <div className={`px-4 pt-3 pb-3 space-y-3 ${proposalCollapsed ? 'hidden' : ''}`}>
              <FieldApprovalTable
                proposal={proposal}
                decisions={decisions}
                onDecisionChange={(field, d) => setDecisions((prev) => ({ ...prev, [field]: d }))}
                disabled={promoting}
              />
              <textarea
                value={humanNotes}
                onChange={(e) => setHumanNotes(e.target.value)}
                placeholder="Optional reviewer notes…"
                rows={2}
                className="w-full rounded-md border border-border bg-white px-3 py-2 text-xs text-[#0B2026] placeholder:text-muted-foreground/60 resize-none focus:outline-none focus:ring-1 focus:ring-[#FF3621]/40"
              />
              {promoteError && <p className="text-xs text-red-600">{promoteError}</p>}

              {/* Merge action */}
              {mergeIntoRowId != null ? (
                <div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2.5 space-y-2">
                  <div className="flex items-start gap-2">
                    <X className="h-4 w-4 text-amber-600 mt-0.5 flex-shrink-0" />
                    <p className="text-xs font-semibold text-amber-800">
                      Duplicate detected — merge into row {mergeIntoRowId}
                    </p>
                  </div>
                  <div className="flex gap-2">
                    <button
                      disabled={promoting}
                      onClick={() => onApprove(decisions, humanNotes)}
                      className="flex-1 rounded-md bg-amber-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-amber-700 disabled:opacity-50 transition-colors"
                    >
                      {promoting ? <Loader2 className="h-3.5 w-3.5 animate-spin mx-auto" /> : 'Confirm Merge'}
                    </button>
                    <button
                      disabled={promoting}
                      onClick={() => onDefer(humanNotes)}
                      className="flex-1 rounded-md border border-border bg-white px-3 py-1.5 text-xs font-semibold text-[#0B2026] hover:bg-muted disabled:opacity-50 transition-colors"
                    >
                      Defer
                    </button>
                  </div>
                </div>
              ) : (
                <div className="flex gap-2">
                  <button
                    disabled={promoting || !proposal}
                    onClick={() => onApprove(decisions, humanNotes)}
                    className="flex-1 rounded-md bg-[#FF3621] px-3 py-1.5 text-xs font-semibold text-white hover:bg-[#E02D1A] disabled:opacity-50 transition-colors"
                  >
                    {promoting ? <Loader2 className="h-3.5 w-3.5 animate-spin mx-auto" /> : 'Approve & Promote'}
                  </button>
                  <button
                    disabled={promoting}
                    onClick={() => onDefer(humanNotes)}
                    className="flex-1 rounded-md border border-border bg-white px-3 py-1.5 text-xs font-semibold text-[#0B2026] hover:bg-muted disabled:opacity-50 transition-colors"
                  >
                    Defer
                  </button>
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Trust scores */}
      {frozenScores && frozenScores.length > 0 && (
        <div className="mt-3 flex-shrink-0">
          <TrustScorePanel scores={frozenScores} />
        </div>
      )}
    </div>
  );
}

// ── Main BulkReviewPage ───────────────────────────────────────────────────────

export function BulkReviewPage() {
  const location = useLocation();
  const navigate = useNavigate();
  const state = location.state as { clusterIds?: string[] } | null;
  const clusterIds: string[] = state?.clusterIds ?? [];

  // ── State ──────────────────────────────────────────────────────────────────
  const [items, setItems] = useState<BulkItem[]>(() =>
    clusterIds.map((id) => ({
      clusterId: id,
      facilityName: null,
      status: 'pending' as ItemStatus,
      proposal: null,
      task: null,
      error: null,
    }))
  );
  const [activeIndex, setActiveIndex] = useState(0);

  // Per-active-cluster state (reset when activeIndex changes)
  const [records, setRecords] = useState<FacilityRecord[]>([]);
  const [initialMessage, setInitialMessage] = useState('');
  const [agentStarted, setAgentStarted] = useState(false);
  const [promoting, setPromoting] = useState(false);
  const [promoteError, setPromoteError] = useState<string | null>(null);
  const [frozenScores, setFrozenScores] = useState<AgentScore[] | null>(null);
  const [loadingCluster, setLoadingCluster] = useState(false);

  // Track whether we've initialized the first cluster
  const initializedRef = useRef(false);

  // Redirect if no clusters were passed
  useEffect(() => {
    if (clusterIds.length === 0) {
      navigate('/queue', { replace: true });
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Load records + create task + start agent for a given index
  const startCluster = useCallback(async (index: number, itemList: BulkItem[]) => {
    const item = itemList[index];
    if (!item) return;

    setLoadingCluster(true);
    setRecords([]);
    setInitialMessage('');
    setAgentStarted(false);
    setPromoting(false);
    setPromoteError(null);
    setFrozenScores(null);

    // Mark as running
    setItems((prev) => {
      const next = [...prev];
      next[index] = { ...next[index], status: 'running' };
      return next;
    });

    try {
      // Load records
      const recs = await clustersApi.records(item.clusterId);
      setRecords(recs);

      // Resolve facility name from records
      const name = recs[0]?.name ?? null;
      setItems((prev) => {
        const next = [...prev];
        next[index] = { ...next[index], facilityName: name ?? next[index].facilityName };
        return next;
      });

      // Create task (idempotent)
      const task = await tasksApi.create(item.clusterId);
      setItems((prev) => {
        const next = [...prev];
        next[index] = { ...next[index], task };
        return next;
      });

      // Build seed message and start agent
      const msg = buildInitialMessage(item.clusterId, recs);
      setInitialMessage(msg);
      setAgentStarted(true);
    } catch (e) {
      setItems((prev) => {
        const next = [...prev];
        next[index] = { ...next[index], status: 'error', error: String(e) };
        return next;
      });
    } finally {
      setLoadingCluster(false);
    }
  }, []);

  // Initialize first cluster on mount
  useEffect(() => {
    if (initializedRef.current || clusterIds.length === 0) return;
    initializedRef.current = true;
    void startCluster(0, items);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Advance to next pending cluster — 2s cooldown to avoid 429 rate limits
  const advanceToNext = useCallback((currentItems: BulkItem[]) => {
    const nextIndex = currentItems.findIndex((it, i) => i > activeIndex && it.status === 'pending');
    if (nextIndex === -1) {
      // All done — stay on last item (summary will render)
      return;
    }
    setActiveIndex(nextIndex);
    // Brief pause before firing the next agent to avoid back-to-back 429s
    setTimeout(() => {
      void startCluster(nextIndex, currentItems);
    }, 2000);
  }, [activeIndex, startCluster]);

  // Helpers to get current task
  function getCurrentTask(): ResolutionTask | null {
    return items[activeIndex]?.task ?? null;
  }

  // Approve handler
  async function handleApprove(decisions: Record<string, FieldDecision>, humanNotes: string) {
    const item = items[activeIndex];
    const proposal = item?.proposal;
    if (!proposal) return;

    const activeTask = getCurrentTask();
    if (!activeTask) { setPromoteError('Task not ready yet.'); return; }

    setPromoting(true);
    setPromoteError(null);

    try {
      const mergeIntoRowId = proposal.merge_into_row_id ?? null;

      if (mergeIntoRowId != null) {
        // Merge path
        await mergeApi.merge({
          task_id: activeTask.id,
          raw_row_id: activeTask.raw_row_id,
          merge_into_row_id: mergeIntoRowId,
          facility_name: item.facilityName ?? records[0]?.name ?? null,
          reasoning: proposal.reasoning || `Merged into row ${mergeIntoRowId}`,
          confidence: proposal.confidence ?? null,
          agents_consulted: proposal.agents_consulted ?? null,
          human_notes: humanNotes.trim() || null,
          agent_scores: proposal.agent_scores ?? null,
        });
      } else {
        // Promote path
        const resolvedFields: Record<string, unknown> = {};
        for (const f of proposal.fields) {
          const dec = decisions[f.field];
          resolvedFields[f.field] = dec?.action === 'edit' ? dec.overrideValue : f.value;
        }
        await promoteApi.promote({
          task_id: activeTask.id,
          raw_row_id: activeTask.raw_row_id,
          facility_name: item.facilityName ?? records[0]?.name ?? null,
          outcome: proposal.outcome === 'deferred' ? 'partial' : proposal.outcome,
          confidence: proposal.confidence,
          reasoning: proposal.reasoning,
          agents_consulted: proposal.agents_consulted,
          verifications: proposal.fields.map((f) => ({
            field: f.field,
            status: f.status,
            old_value: f.old_value ?? null,
            new_value: decisions[f.field]?.action === 'edit' ? decisions[f.field].overrideValue : String(f.value ?? ''),
            agent: f.agent ?? undefined,
            supervisor_reasoning: f.note,
          })),
          human_notes: humanNotes.trim() || null,
          agent_scores: proposal.agent_scores ?? null,
          resolved_fields: resolvedFields,
        });
      }

      // Mark done
      const updatedItems = items.map((it, i) =>
        i === activeIndex ? { ...it, status: 'done' as ItemStatus } : it
      );
      setItems(updatedItems);
      advanceToNext(updatedItems);
    } catch (e) {
      setPromoteError(String(e));
    } finally {
      setPromoting(false);
    }
  }

  // Defer handler
  async function handleDefer(humanNotes: string) {
    const item = items[activeIndex];
    const proposal = item?.proposal;

    const activeTask = getCurrentTask();
    if (!activeTask) { setPromoteError('Task not ready yet.'); return; }

    setPromoting(true);
    setPromoteError(null);

    try {
      await promoteApi.promote({
        task_id: activeTask.id,
        raw_row_id: activeTask.raw_row_id,
        facility_name: item?.facilityName ?? records[0]?.name ?? null,
        outcome: 'deferred',
        confidence: proposal?.confidence ?? null,
        reasoning: proposal?.reasoning ?? 'Deferred by reviewer.',
        agents_consulted: proposal?.agents_consulted ?? null,
        verifications: null,
        human_notes: humanNotes.trim() || null,
        agent_scores: proposal?.agent_scores ?? null,
      });

      const updatedItems = items.map((it, i) =>
        i === activeIndex ? { ...it, status: 'deferred' as ItemStatus } : it
      );
      setItems(updatedItems);
      advanceToNext(updatedItems);
    } catch (e) {
      setPromoteError(String(e));
    } finally {
      setPromoting(false);
    }
  }

  // Proposal/scores change handlers (called from ClusterPanel)
  function handleProposalChange(p: PromotionProposal | null) {
    setItems((prev) => {
      const next = [...prev];
      next[activeIndex] = { ...next[activeIndex], proposal: p };
      return next;
    });
  }

  function handleScoresChange(s: AgentScore[] | null) {
    setFrozenScores((prev) => prev ?? s);
  }

  // ── Derived ────────────────────────────────────────────────────────────────
  const doneCount = items.filter((it) => it.status === 'done' || it.status === 'deferred').length;
  const total = items.length;
  const allComplete = doneCount === total;
  const activeItem = items[activeIndex];

  // ── Render ─────────────────────────────────────────────────────────────────
  if (clusterIds.length === 0) return null;

  return (
    <div className="flex flex-col h-[calc(100vh-7rem)] gap-0">
      {/* Top bar */}
      <div className="flex items-center justify-between flex-shrink-0 mb-3">
        <button
          onClick={() => navigate('/queue')}
          className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-3.5 w-3.5" /> Back to queue
        </button>
        <div className="flex items-center gap-3">
          <span className="text-sm font-medium text-[#0B2026]">
            {doneCount} of {total} complete
          </span>
          {/* Progress bar */}
          <div className="w-32 h-1.5 rounded-full bg-muted overflow-hidden">
            <div
              className="h-full rounded-full bg-[#FF3621] transition-all"
              style={{ width: `${(doneCount / total) * 100}%` }}
            />
          </div>
        </div>
      </div>

      {/* All-done summary */}
      {allComplete ? (
        <div className="flex flex-col items-center justify-center flex-1 gap-4">
          <CheckCircle2 className="h-12 w-12 text-green-500" />
          <div className="text-center">
            <p className="text-lg font-semibold text-[#0B2026]">Bulk review complete</p>
            <p className="text-sm text-muted-foreground mt-1">
              {items.filter((it) => it.status === 'done').length} approved,{' '}
              {items.filter((it) => it.status === 'deferred').length} deferred
            </p>
          </div>
          <div className="flex gap-3">
            <button
              onClick={() => navigate('/decisions')}
              className="rounded-md bg-[#FF3621] px-4 py-2 text-sm font-semibold text-white hover:bg-[#E02D1A] transition-colors"
            >
              View Decisions
            </button>
            <button
              onClick={() => navigate('/queue')}
              className="rounded-md border border-border bg-white px-4 py-2 text-sm font-semibold text-[#0B2026] hover:bg-muted transition-colors"
            >
              Back to Queue
            </button>
          </div>
        </div>
      ) : (
        /* Main layout: sidebar + right panel */
        <div className="flex flex-1 min-h-0 gap-4">
          {/* Sidebar */}
          <div className="w-64 flex-shrink-0 flex flex-col min-h-0 rounded-lg border border-border bg-white overflow-hidden">
            <div className="px-3 py-2 border-b border-border/60 bg-[#F4F2EE] flex-shrink-0">
              <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                Queue ({total})
              </span>
            </div>
            <div className="flex-1 overflow-y-auto">
              {items.map((item, idx) => (
                <button
                  key={item.clusterId}
                  onClick={() => {
                    if (idx === activeIndex) return;
                    // Allow jumping to any item (agent will already be running or done)
                    setActiveIndex(idx);
                    if (item.status === 'pending') {
                      void startCluster(idx, items);
                    }
                  }}
                  className={`w-full text-left px-3 py-2.5 border-b border-border/40 transition-colors ${
                    idx === activeIndex
                      ? 'bg-[#FF3621]/8 border-l-2 border-l-[#FF3621]'
                      : 'hover:bg-muted/50'
                  }`}
                >
                  <div className="flex items-start justify-between gap-1.5">
                    <span className="text-xs font-medium text-[#0B2026] leading-tight line-clamp-2 flex-1">
                      {item.facilityName ?? item.clusterId}
                    </span>
                    <StatusBadge status={item.status} />
                  </div>
                  <span className="text-[10px] text-muted-foreground mt-0.5 block truncate">
                    {item.clusterId}
                  </span>
                </button>
              ))}
            </div>
          </div>

          {/* Right panel */}
          <div className="flex-1 min-w-0 flex flex-col min-h-0">
            {loadingCluster ? (
              <div className="flex items-center justify-center flex-1">
                <Loader2 className="h-6 w-6 animate-spin text-[#FF3621]" />
              </div>
            ) : activeItem?.status === 'error' ? (
              <div className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
                {activeItem.error ?? 'Unknown error'}
                <button
                  onClick={() => void startCluster(activeIndex, items)}
                  className="ml-3 text-xs underline"
                >
                  Retry
                </button>
              </div>
            ) : activeItem?.status === 'done' || activeItem?.status === 'deferred' ? (
              <div className="flex flex-col items-center justify-center flex-1 gap-3">
                {activeItem.status === 'done'
                  ? <CheckCircle2 className="h-8 w-8 text-green-500" />
                  : <Clock className="h-8 w-8 text-amber-500" />
                }
                <p className="text-sm font-medium text-[#0B2026]">
                  {activeItem.status === 'done' ? 'Approved & promoted' : 'Deferred for later review'}
                </p>
                <p className="text-xs text-muted-foreground">
                  {activeItem.facilityName ?? activeItem.clusterId}
                </p>
              </div>
            ) : (
              /* Active cluster panel */
              <div className="flex flex-col flex-1 min-h-0">
                {/* Cluster header */}
                <div className="flex items-center gap-2 mb-3 flex-shrink-0">
                  <h2 className="text-base font-semibold text-[#0B2026] truncate">
                    {activeItem?.facilityName ?? activeItem?.clusterId ?? '—'}
                  </h2>
                  {activeItem && <StatusBadge status={activeItem.status} />}
                  <span className="ml-auto text-xs text-muted-foreground">
                    {activeIndex + 1} / {total}
                  </span>
                </div>

                <ClusterPanel
                  item={activeItem!}
                  initialMessage={initialMessage}
                  agentStarted={agentStarted}
                  onApprove={handleApprove}
                  onDefer={handleDefer}
                  promoting={promoting}
                  promoteError={promoteError}
                  onProposalChange={handleProposalChange}
                  onScoresChange={handleScoresChange}
                  frozenScores={frozenScores}
                />
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
