import { useEffect, useRef, useState } from 'react';
import {
  Input,
  useAgentChat,
  usePluginClientConfig,
} from '@databricks/appkit-ui/react';
import { Send, Loader2, Bot, User, Zap } from 'lucide-react';

interface Message {
  id: string;
  role: 'user' | 'assistant' | 'tool';
  content: string;
  toolName?: string;
}

interface AgentsClientConfig {
  agents: string[];
  defaultAgent: string | null;
}

interface AgentChatProps {
  agentName?: string;
  initialMessage?: string;
  placeholder?: string;
  started?: boolean;
  onStreamingChange?: (streaming: boolean) => void;
  onMessagesChange?: (messages: { role: string; content: string }[]) => void;
}

// ── Agent activity feed ───────────────────────────────────────────────────────

const AGENT_LABELS: Record<string, string> = {
  'evidence-fetcher':                'Fetching raw record…',
  'website-validator':               'Checking website…',
  'phone-validator':                 'Validating phone number…',
  'location-validator':              'Verifying location & coordinates…',
  'facebook-validator':              'Checking Facebook page…',
  'similarity-scorer':               'Scoring name & address similarity…',
  'duplicate-detector':              'Scanning for duplicate records…',
  'context-validator':               'Assessing record completeness…',
  'skill-matcher':                   'Matching specialties to equipment…',
  'source-authority-validator':      'Checking source authority…',
  'controlled-vocabulary-validator': 'Validating controlled vocabulary…',
};

const PLAYBACK_STEP_MS = 400;

function agentLabel(name: string): string {
  return AGENT_LABELS[name] ?? `Calling ${name.replace(/-/g, ' ')}…`;
}

/** Extract row_id from the initial message, e.g. "row_id: 12345" */
function extractRowId(msg: string): string | null {
  const m = msg.match(/row_id[:\s]+(\d+)/i);
  return m ? m[1] : null;
}

// ── Content cleaner ───────────────────────────────────────────────────────────

function cleanContent(raw: string): string {
  let s = raw
    .replace(/^Verifying record…\s*/i, '')
    .replace(/PROMOTION_PROPOSAL:[\s\S]*$/, '')
    .trimEnd();
  let result = '';
  let i = 0;
  while (i < s.length) {
    if (s[i] === '\n' || s[i] === '\r' || s[i] === ' ' || s[i] === '\t') {
      result += s[i]; i++; continue;
    }
    if (s[i] === '{') {
      let depth = 0, inString = false, escape = false, j = i;
      while (j < s.length) {
        const ch = s[j];
        if (escape) { escape = false; j++; continue; }
        if (ch === '\\' && inString) { escape = true; j++; continue; }
        if (ch === '"') { inString = !inString; j++; continue; }
        if (inString) { j++; continue; }
        if (ch === '{') depth++;
        else if (ch === '}') { depth--; if (depth === 0) { j++; break; } }
        j++;
      }
      const blob = s.slice(i, j);
      let drop = false;
      try {
        const obj = JSON.parse(blob) as Record<string, unknown>;
        if (typeof obj['agent'] === 'string' || ('name' in obj && 'latitude' in obj) || ('row_id' in obj && 'candidates' in obj)) drop = true;
      } catch { /* keep */ }
      if (!drop) result += blob;
      i = j;
    } else { result += s[i]; i++; }
  }
  return result.replace(/\n{3,}/g, '\n\n').trim();
}

// ── Component ─────────────────────────────────────────────────────────────────

export function AgentChat({ agentName, initialMessage, placeholder, started = false, onStreamingChange, onMessagesChange }: AgentChatProps = {}) {
  const { agents, defaultAgent } = usePluginClientConfig<AgentsClientConfig>('agents');
  const activeAgent = agentName ?? defaultAgent ?? agents[0] ?? null;

  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [pendingAssistantId, setPendingAssistantId] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const sendDoneRef = useRef(false);

  // ── Activity feed state ───────────────────────────────────────────────────
  const [isWaiting, setIsWaiting] = useState(false);
  // agentSteps: live steps arriving from the SSE progress stream
  const [agentSteps, setAgentSteps] = useState<{ agent: string; status: 'running' | 'done' }[]>([]);
  // allAgents / visibleCount: playback animation (used as fallback from PROMOTION_PROPOSAL)
  const [allAgents, setAllAgents] = useState<string[]>([]);
  const [visibleCount, setVisibleCount] = useState(0);
  const playbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sendInFlightRef = useRef(false);
  // ── Poll /api/progress/:rowId/steps every 1.5 s while a run is in flight ──
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // SSE subscription (kept but replaced by polling below)
  const sseRef = useRef<EventSource | null>(null);

  useEffect(() => {
    onMessagesChange?.(messages.map((m) => ({ role: m.role, content: m.content })));
  }, [messages, onMessagesChange]);

  const sendRef = useRef<((msg: string) => Promise<void>) | null>(null);
  const resetRef = useRef<(() => void) | null>(null);
  const seededRef = useRef(false);

  const { content, isStreaming, error, send, reset } = useAgentChat({
    agent: activeAgent ?? '',
  });

  sendRef.current = send;
  resetRef.current = reset;

  // ── Poll /api/progress/:rowId/steps while a run is in flight ────────────
  const subscribeToProgress = (rowId: string) => {
    // Clear any existing SSE / poll
    if (sseRef.current) { sseRef.current.close(); sseRef.current = null; }
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }

    console.log('[Progress] starting poll for rowId', rowId);

    const fetchSteps = async () => {
      try {
        const res = await fetch(`/api/progress/${rowId}/steps`);
        if (!res.ok) { console.warn('[Progress] poll non-ok', res.status); return; }
        const data = await res.json() as { steps: { agent: string; status: 'running' | 'done' }[] };
        console.log('[Progress] poll result', data.steps);
        setAgentSteps(data.steps);
      } catch (err) {
        console.warn('[Progress] poll error', err);
      }
    };

    // Fire immediately, then every 1.5 s
    void fetchSteps();
    pollRef.current = setInterval(fetchSteps, 1500);
  };

  // ── Fallback: parse PROMOTION_PROPOSAL from content if SSE yielded nothing
  useEffect(() => {
    if (agentSteps.length > 0) return; // SSE is working — no need for fallback
    if (allAgents.length > 0) return;
    const match = content.match(/PROMOTION_PROPOSAL:\s*(\{[\s\S]*\})/);
    if (!match) return;
    try {
      const proposal = JSON.parse(match[1]) as { agent_scores?: { agent: string }[] };
      const names = (proposal.agent_scores ?? []).map((s) => s.agent).filter(Boolean);
      if (names.length > 0) setAllAgents(names);
    } catch { /* ignore */ }
  }, [content, agentSteps.length, allAgents.length]);

  // ── Playback animation for fallback path ─────────────────────────────────
  useEffect(() => {
    if (allAgents.length === 0) return;
    if (visibleCount >= allAgents.length) return;
    if (playbackTimerRef.current) clearTimeout(playbackTimerRef.current);
    playbackTimerRef.current = setTimeout(() => {
      setVisibleCount((c) => Math.min(c + 1, allAgents.length));
    }, PLAYBACK_STEP_MS);
    return () => { if (playbackTimerRef.current) clearTimeout(playbackTimerRef.current); };
  }, [allAgents, visibleCount]);

  // ── Clear isWaiting once send resolves, streaming ends, and animation done
  useEffect(() => {
    if (sendInFlightRef.current) return;
    if (isStreaming) return;
    // SSE path: wait for all steps to be 'done' or SSE closed
    if (agentSteps.length > 0 && agentSteps.some((s) => s.status === 'running')) return;
    // Fallback path: wait for playback
    if (allAgents.length > 0 && visibleCount < allAgents.length) return;
    // Stop polling — run is complete
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
    setIsWaiting(false);
  }, [isStreaming, agentSteps, visibleCount, allAgents.length]);

  useEffect(() => { onStreamingChange?.(isStreaming); }, [isStreaming, onStreamingChange]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages, content, agentSteps, visibleCount]);

  // Update the in-progress assistant bubble
  useEffect(() => {
    if (!pendingAssistantId) return;
    setMessages((prev) => prev.map((m) => m.id === pendingAssistantId ? { ...m, content } : m));
    if (sendDoneRef.current) {
      sendDoneRef.current = false;
      setPendingAssistantId(null);
    }
  }, [content, pendingAssistantId]);

  // Helper to reset all feed state between runs
  const resetFeed = (rowId?: string | null) => {
    if (playbackTimerRef.current) clearTimeout(playbackTimerRef.current);
    if (sseRef.current) { sseRef.current.close(); sseRef.current = null; }
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
    setIsWaiting(true);
    setAgentSteps([]);
    setAllAgents([]);
    setVisibleCount(0);
    if (rowId) subscribeToProgress(rowId);
  };

  // Cleanup SSE/poll on unmount
  useEffect(() => () => {
    sseRef.current?.close();
    if (pollRef.current) clearInterval(pollRef.current);
  }, []);

  useEffect(() => {
    if (!started || !activeAgent || seededRef.current) return;
    const msg = initialMessage?.trim();
    if (!msg) return;
    seededRef.current = true;
    const assistantId = `a-seed-${Date.now()}`;
    const rowId = extractRowId(msg);
    resetRef.current?.();
    resetFeed(rowId);
    setMessages([
      { id: `u-seed-${Date.now()}`, role: 'user', content: msg },
      { id: assistantId, role: 'assistant', content: '' },
    ]);
    setPendingAssistantId(assistantId);
    const trySend = async (attemptsLeft: number): Promise<void> => {
      try {
        sendInFlightRef.current = true;
        await sendRef.current!(msg);
        sendDoneRef.current = true;
      } catch (err) {
        const is429 = String(err).includes('429') || String(err).toLowerCase().includes('rate limit') || String(err).toLowerCase().includes('too many requests');
        if (is429 && attemptsLeft > 1) {
          await new Promise((r) => setTimeout(r, (4 - attemptsLeft) * 3000));
          await trySend(attemptsLeft - 1);
        } else { throw err; }
      } finally {
        sendInFlightRef.current = false;
      }
    };
    void trySend(3);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [started, activeAgent, initialMessage]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const message = input.trim();
    if (!message || isStreaming || !activeAgent) return;
    setInput('');
    const assistantId = `a-${Date.now()}`;
    const rowId = extractRowId(message);
    resetFeed(rowId);
    setMessages((prev) => [
      ...prev,
      { id: `u-${Date.now()}`, role: 'user', content: message },
      { id: assistantId, role: 'assistant', content: '' },
    ]);
    setPendingAssistantId(assistantId);
    sendInFlightRef.current = true;
    try {
      await send(message);
    } finally {
      sendInFlightRef.current = false;
    }
    sendDoneRef.current = true;
  };

  // ── Render feed rows ──────────────────────────────────────────────────────
  // SSE path: show live steps as they arrive
  // Fallback path: show playback animation from PROMOTION_PROPOSAL
  const usingSse = agentSteps.length > 0;
  const feedRows: { agent: string; status: 'running' | 'done' | 'pending' }[] = usingSse
    ? agentSteps
    : allAgents.slice(0, visibleCount).map((a, i) => ({
        agent: a,
        status: i < visibleCount - 1 ? 'done' : 'running',
      }));
  const playbackInProgress = !usingSse && visibleCount < allAgents.length;
  const showFeed = isWaiting || playbackInProgress || (usingSse && agentSteps.some((s) => s.status === 'running'));

  return (
    <div className="flex h-full flex-col">
      <div ref={scrollRef} className="flex-1 overflow-y-auto p-4">
        {messages.length === 0 && (
          <div className="flex flex-col items-center justify-center h-full gap-2 text-center">
            <Bot className="h-8 w-8 text-muted-foreground/40" />
            <p className="text-xs text-muted-foreground">
              {started ? 'Supervisor Agent is initialising…' : 'The Supervisor Agent is ready.'}
            </p>
          </div>
        )}

        <div className="space-y-3">
          {messages.map((m) => {
            const isUser = m.role === 'user';
            const isPendingBubble = m.id === pendingAssistantId;

            return (
              <div key={m.id}>
                <div className={`flex items-start gap-2 ${isUser ? 'flex-row-reverse' : ''}`}>
                  <div className={`flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full ${isUser ? 'bg-[#FF3621]' : 'bg-[#0B2026]'}`}>
                    {isUser ? <User className="h-3 w-3 text-white" /> : <Bot className="h-3 w-3 text-white" />}
                  </div>
                  <div className={`max-w-[85%] rounded-lg px-3 py-2 text-sm ${isUser ? 'bg-[#FF3621]/10 text-[#0B2026]' : 'bg-[#EEEDE9] text-[#0B2026]'}`}>

                    {/* ── Activity feed ── */}
                    {isPendingBubble && (isWaiting || showFeed) && (
                      <div className="mb-2 space-y-1.5">
                        {feedRows.length === 0 ? (
                          <div className="flex items-center gap-2">
                            <div className="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full bg-white/60">
                              <Loader2 className="h-3 w-3 animate-spin text-[#FF3621]" />
                            </div>
                            <span className="text-xs text-muted-foreground animate-pulse">Contacting agents…</span>
                          </div>
                        ) : (
                          feedRows.map(({ agent, status }) => (
                            <div key={agent} className="flex items-center gap-2">
                              <div className="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full bg-white/60">
                                {status === 'running'
                                  ? <Loader2 className="h-3 w-3 animate-spin text-[#FF3621]" />
                                  : <Zap className="h-3 w-3 text-green-600" />
                                }
                              </div>
                              <span className={`text-xs ${status === 'running' ? 'text-[#0B2026] font-medium' : 'text-muted-foreground line-through'}`}>
                                {agentLabel(agent)}
                              </span>
                            </div>
                          ))
                        )}
                        {cleanContent(m.content) && <div className="border-t border-black/10 pt-2" />}
                      </div>
                    )}

                    {/* ── Message content ── */}
                    <div className="whitespace-pre-wrap leading-relaxed">
                      {(m.content ? cleanContent(m.content) : '') || (isPendingBubble && isStreaming ? (
                        <span className="flex items-center gap-1 text-muted-foreground">
                          <Loader2 className="h-3 w-3 animate-spin" />
                          Analysing…
                        </span>
                      ) : '')}
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {error && (
        <div className="mx-4 mb-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
          {error}
        </div>
      )}

      {started && (
        <form onSubmit={handleSubmit} className="flex gap-2 border-t border-border p-3">
          <Input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={placeholder ?? (activeAgent ? 'Reply to Supervisor…' : 'No agents registered')}
            disabled={!activeAgent || isStreaming}
            className="flex-1 text-sm text-[#0B2026] bg-white placeholder:text-muted-foreground"
          />
          <button
            type="submit"
            disabled={!input.trim() || !activeAgent || isStreaming}
            className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-md bg-[#FF3621] text-white hover:bg-[#e02e1a] disabled:opacity-40"
          >
            {isStreaming ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
          </button>
        </form>
      )}
    </div>
  );
}
