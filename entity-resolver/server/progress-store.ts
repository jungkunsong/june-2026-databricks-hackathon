/**
 * In-memory progress store for agent run status.
 *
 * Keyed by row_id (string). Each entry holds an ordered list of agent steps.
 * The client polls GET /api/progress/:runId/steps every 1.5 s to get updates.
 *
 * Run-ID propagation: a module-level `activeRunId` is set by evidence-fetcher
 * when it fires. All other sub-agents call getActiveRunId() to retrieve it.
 * This works because all agent tool `execute` callbacks run in the same
 * Node.js process (AppKit dispatches tool calls locally), and runs are
 * sequential for a single user session.
 *
 * AsyncLocalStorage was tried but doesn't propagate across the AppKit
 * sub-agent dispatch boundary (each sub-agent is a separate runSubAgent call
 * from the supervisor's async context, not a child of evidence-fetcher's).
 */

import type { Response } from 'express';

export interface ProgressStep {
  agent: string;   // e.g. "website-validator"
  status: 'running' | 'done';
  ts: number;
}

interface RunState {
  steps: ProgressStep[];
  clients: Set<Response>;
  createdAt: number;
}

const store = new Map<string, RunState>();

const TTL_MS = 10 * 60 * 1000; // 10 minutes

// ── Module-level active run ID ────────────────────────────────────────────────
let activeRunId: string | null = null;

export function setActiveRunId(id: string): void {
  console.log('[progress-store] setActiveRunId', id);
  activeRunId = id;
}

export function getActiveRunId(): string | null {
  return activeRunId;
}

/** No-op kept for any callers that used the old AsyncLocalStorage API. */
export function runWithRunId<T>(runId: string, fn: () => Promise<T>): Promise<T> {
  setActiveRunId(runId);
  return fn();
}

function getOrCreate(runId: string): RunState {
  let state = store.get(runId);
  if (!state) {
    state = { steps: [], clients: new Set(), createdAt: Date.now() };
    store.set(runId, state);
    setTimeout(() => {
      const s = store.get(runId);
      if (s && Date.now() - s.createdAt >= TTL_MS) store.delete(runId);
    }, TTL_MS);
  }
  return state;
}

/** Called by each sub-agent tool when it starts executing. */
export function emitAgentStart(runId: string, agent: string): void {
  console.log('[progress-store] emitAgentStart', runId, agent);
  const state = getOrCreate(runId);
  // Avoid duplicate running entries
  if (state.steps.some((s) => s.agent === agent && s.status === 'running')) return;
  const step: ProgressStep = { agent, status: 'running', ts: Date.now() };
  state.steps.push(step);
  broadcast(state, step);
}

/** Called by each sub-agent tool when it finishes executing. */
export function emitAgentDone(runId: string, agent: string): void {
  console.log('[progress-store] emitAgentDone', runId, agent);
  const state = store.get(runId);
  if (!state) return;
  for (const s of state.steps) {
    if (s.agent === agent && s.status === 'running') {
      s.status = 'done';
      broadcast(state, s);
      return;
    }
  }
}

function broadcast(state: RunState, step: ProgressStep): void {
  const data = `data: ${JSON.stringify(step)}\n\n`;
  for (const client of state.clients) {
    try { client.write(data); } catch { /* client disconnected */ }
  }
}

/** Subscribe an SSE response to a run. Replays existing steps immediately. */
export function subscribe(runId: string, res: Response): void {
  const state = getOrCreate(runId);
  for (const step of state.steps) {
    res.write(`data: ${JSON.stringify(step)}\n\n`);
  }
  state.clients.add(res);
  res.on('close', () => state.clients.delete(res));
}

/** Return a snapshot of steps for a run (used by the polling endpoint). */
export function getSteps(runId: string): ProgressStep[] {
  const steps = store.get(runId)?.steps ?? [];
  console.log('[progress-store] getSteps', runId, '->', steps.length, 'steps');
  return steps;
}
