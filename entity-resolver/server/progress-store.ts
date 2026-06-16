/**
 * In-memory progress store for agent run status.
 *
 * Keyed by row_id (string). Each entry holds an ordered list of agent steps
 * and a set of SSE response objects waiting for updates.
 *
 * Lifecycle: created when the first tool fires, TTL-cleaned after 10 minutes.
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

// Active run ID — set by evidence-fetcher when it fires, used by other agents
let activeRunId: string | null = null;
export function setActiveRunId(id: string): void { activeRunId = id; }
export function getActiveRunId(): string | null { return activeRunId; }

function getOrCreate(runId: string): RunState {
  let state = store.get(runId);
  if (!state) {
    state = { steps: [], clients: new Set(), createdAt: Date.now() };
    store.set(runId, state);
    // Schedule cleanup
    setTimeout(() => store.delete(runId), TTL_MS);
  }
  return state;
}

/** Called by each sub-agent tool when it starts executing. */
export function emitAgentStart(runId: string, agent: string): void {
  const state = getOrCreate(runId);
  // Mark any previous 'running' step for this agent as done (shouldn't happen, but be safe)
  for (const s of state.steps) {
    if (s.agent === agent && s.status === 'running') s.status = 'done';
  }
  const step: ProgressStep = { agent, status: 'running', ts: Date.now() };
  state.steps.push(step);
  broadcast(state, step);
}

/** Called by each sub-agent tool when it finishes executing. */
export function emitAgentDone(runId: string, agent: string): void {
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
  // Replay history so a late-connecting client catches up
  for (const step of state.steps) {
    res.write(`data: ${JSON.stringify(step)}\n\n`);
  }
  state.clients.add(res);
  res.on('close', () => state.clients.delete(res));
}
