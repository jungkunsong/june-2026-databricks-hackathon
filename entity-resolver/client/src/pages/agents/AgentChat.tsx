import { useEffect, useRef, useState } from 'react';
import {
  type AgentChatEvent,
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
  'agent-evidence-fetcher':                'Fetching raw record…',
  'agent-website-validator':               'Checking website…',
  'agent-phone-validator':                 'Validating phone number…',
  'agent-location-validator':              'Verifying location & coordinates…',
  'agent-facebook-validator':              'Checking Facebook page…',
  'agent-similarity-scorer':               'Scoring name & address similarity…',
  'agent-duplicate-detector':              'Scanning for duplicate records…',
  'agent-context-validator':               'Assessing record completeness…',
  'agent-skill-matcher':                   'Matching specialties to equipment…',
  'agent-source-authority-validator':      'Checking source authority…',
  'agent-controlled-vocabulary-validator': 'Validating controlled vocabulary…',
};

// ms between each agent row appearing during the playback animation
const PLAYBACK_STEP_MS = 400;

function agentLabel(toolName: string): string {
  return AGENT_LABELS[toolName] ?? `Calling ${toolName.replace(/^agent-/, '').replace(/-/g, ' ')}…`;
}

// ── Content cleaner ───────────────────────────────────────────────────────────

function cleanContent(raw: string): string {
  // Strip the status line emitted to break proxy buffering, and the proposal block
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
  // isWaiting: true from the moment send() fires until playback animation finishes.
  //   The proxy buffers all SSE until the run completes, so isStreaming stays false
  //   during the entire agent run. isWaiting lets us show the feed regardless.
  // allAgents: full ordered list extracted from the event batch when it arrives
  // visibleCount: how many rows are currently shown (animated up one at a time)
  const [isWaiting, setIsWaiting] = useState(false);
  const [allAgents, setAllAgents] = useState<string[]>([]);
  const [visibleCount, setVisibleCount] = useState(0);
  // playback timer ref so we can clear it on reset
  const playbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    onMessagesChange?.(messages.map((m) => ({ role: m.role, content: m.content })));
  }, [messages, onMessagesChange]);

  const sendRef = useRef<((msg: string) => Promise<void>) | null>(null);
  const resetRef = useRef<(() => void) | null>(null);
  const seededRef = useRef(false);

  // ── Collect agent names from every event batch ────────────────────────────
  const lastProcessedEventIdx = useRef(0);

  const handleEvent = (event: AgentChatEvent) => {
    if (
      event.type === 'response.output_item.added' &&
      event.item?.type === 'function_call' &&
      event.item.name?.startsWith('agent-')
    ) {
      const name = event.item.name;
      setAllAgents((prev) => prev.includes(name) ? prev : [...prev, name]);
    }
  };

  const { content, events, isStreaming, error, send, reset } = useAgentChat({
    agent: activeAgent ?? '',
    onEvent: handleEvent,
  });

  sendRef.current = send;
  resetRef.current = reset;

  // Secondary path: scan new events for function_call items
  useEffect(() => {
    const newEvents = events.slice(lastProcessedEventIdx.current);
    lastProcessedEventIdx.current = events.length;
    for (const event of newEvents) {
      if (
        event.type === 'response.output_item.added' &&
        event.item?.type === 'function_call' &&
        event.item.name?.startsWith('agent-')
      ) {
        const name = event.item.name as string;
        setAllAgents((prev) => prev.includes(name) ? prev : [...prev, name]);
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [events]);

  // ── Playback animation: when allAgents grows, step visibleCount up one at a time
  useEffect(() => {
    if (allAgents.length === 0) return;
    if (visibleCount >= allAgents.length) {
      // Animation done — if streaming is also finished, clear waiting
      if (!isStreaming) setIsWaiting(false);
      return;
    }
    if (playbackTimerRef.current) clearTimeout(playbackTimerRef.current);
    playbackTimerRef.current = setTimeout(() => {
      setVisibleCount((c) => Math.min(c + 1, allAgents.length));
    }, PLAYBACK_STEP_MS);
    return () => { if (playbackTimerRef.current) clearTimeout(playbackTimerRef.current); };
  }, [allAgents, visibleCount, isStreaming]);

  // When streaming ends and playback is already complete, clear waiting
  useEffect(() => {
    if (!isStreaming && visibleCount >= allAgents.length && allAgents.length > 0) {
      setIsWaiting(false);
    }
  }, [isStreaming, visibleCount, allAgents.length]);

  useEffect(() => { onStreamingChange?.(isStreaming); }, [isStreaming, onStreamingChange]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages, content, visibleCount]);

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
  const resetFeed = () => {
    if (playbackTimerRef.current) clearTimeout(playbackTimerRef.current);
    setIsWaiting(true);
    setAllAgents([]);
    setVisibleCount(0);
    lastProcessedEventIdx.current = 0;
  };

  useEffect(() => {
    if (!started || !activeAgent || seededRef.current) return;
    const msg = initialMessage?.trim();
    if (!msg) return;
    seededRef.current = true;
    const assistantId = `a-seed-${Date.now()}`;
    resetRef.current?.();
    resetFeed();
    setMessages([
      { id: `u-seed-${Date.now()}`, role: 'user', content: msg },
      { id: assistantId, role: 'assistant', content: '' },
    ]);
    setPendingAssistantId(assistantId);
    const trySend = async (attemptsLeft: number): Promise<void> => {
      try {
        await sendRef.current!(msg);
        sendDoneRef.current = true;
      } catch (err) {
        const is429 = String(err).includes('429') || String(err).toLowerCase().includes('rate limit') || String(err).toLowerCase().includes('too many requests');
        if (is429 && attemptsLeft > 1) {
          await new Promise((r) => setTimeout(r, (4 - attemptsLeft) * 3000));
          await trySend(attemptsLeft - 1);
        } else { throw err; }
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
    resetFeed();
    setMessages((prev) => [
      ...prev,
      { id: `u-${Date.now()}`, role: 'user', content: message },
      { id: assistantId, role: 'assistant', content: '' },
    ]);
    setPendingAssistantId(assistantId);
    await send(message);
    sendDoneRef.current = true;
  };

  // Feed visibility: show while waiting for results OR while playback is animating
  const feedRows = allAgents.slice(0, visibleCount);
  const playbackInProgress = visibleCount < allAgents.length;
  // Spinner on the last row while: no agents yet (still waiting) OR mid-playback
  const lastRowSpinning = isWaiting && (allAgents.length === 0 || playbackInProgress);
  return (
    <div className="flex h-full flex-col">
      <div ref={scrollRef} className="flex-1 overflow-y-auto p-4">
        {/* Empty state */}
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

                    {/* ── Activity feed — shown while waiting or animating ── */}
                    {isPendingBubble && (isWaiting || playbackInProgress) && (
                      <div className="mb-2 space-y-1.5">
                        {feedRows.length === 0 ? (
                          // No agents yet — proxy is still buffering, show pulsing placeholder
                          <div className="flex items-center gap-2">
                            <div className="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full bg-white/60">
                              <Loader2 className="h-3 w-3 animate-spin text-[#FF3621]" />
                            </div>
                            <span className="text-xs text-muted-foreground animate-pulse">Contacting agents…</span>
                          </div>
                        ) : (
                          feedRows.map((name, idx) => {
                            const isLatestRow = idx === feedRows.length - 1;
                            const spinning = isLatestRow && lastRowSpinning;
                            return (
                              <div key={name} className="flex items-center gap-2">
                                <div className="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full bg-white/60">
                                  {spinning
                                    ? <Loader2 className="h-3 w-3 animate-spin text-[#FF3621]" />
                                    : <Zap className="h-3 w-3 text-green-600" />
                                  }
                                </div>
                                <span className={`text-xs ${spinning ? 'text-[#0B2026] font-medium' : 'text-muted-foreground line-through'}`}>
                                  {agentLabel(name)}
                                </span>
                              </div>
                            );
                          })
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
