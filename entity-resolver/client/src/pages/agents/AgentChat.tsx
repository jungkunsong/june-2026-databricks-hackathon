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

// Keys match the bare agent names used in PROMOTION_PROPOSAL agent_scores
// (e.g. "evidence-fetcher", not "agent-evidence-fetcher")
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

// Canonical agent order — used to sort the feed consistently
const AGENT_ORDER = [
  'evidence-fetcher',
  'website-validator',
  'phone-validator',
  'location-validator',
  'facebook-validator',
  'similarity-scorer',
  'duplicate-detector',
  'context-validator',
  'skill-matcher',
  'source-authority-validator',
  'controlled-vocabulary-validator',
];

// ms between each agent row appearing during the playback animation
const PLAYBACK_STEP_MS = 400;

function agentLabel(name: string): string {
  return AGENT_LABELS[name] ?? `Calling ${name.replace(/-/g, ' ')}…`;
}

/**
 * Extract agent names from a PROMOTION_PROPOSAL block embedded in content.
 * The supervisor always emits:
 *   PROMOTION_PROPOSAL: { ..., "agent_scores": [{"agent":"evidence-fetcher",...}, ...] }
 * Returns names sorted by AGENT_ORDER, or [] if not found yet.
 */
function extractAgentsFromContent(raw: string): string[] {
  const match = raw.match(/PROMOTION_PROPOSAL:\s*(\{[\s\S]*\})/);
  if (!match) return [];
  try {
    const proposal = JSON.parse(match[1]) as { agent_scores?: { agent: string }[] };
    const scores = proposal.agent_scores;
    if (!Array.isArray(scores)) return [];
    const names = scores.map((s) => s.agent).filter(Boolean);
    // Sort by canonical order; unknown agents go to the end
    return names.sort((a, b) => {
      const ai = AGENT_ORDER.indexOf(a);
      const bi = AGENT_ORDER.indexOf(b);
      if (ai === -1 && bi === -1) return 0;
      if (ai === -1) return 1;
      if (bi === -1) return -1;
      return ai - bi;
    });
  } catch {
    return [];
  }
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
  // allAgents: ordered list parsed from PROMOTION_PROPOSAL.agent_scores in content
  // visibleCount: how many rows are currently shown (animated up one at a time)
  const [isWaiting, setIsWaiting] = useState(false);
  const [allAgents, setAllAgents] = useState<string[]>([]);
  const [visibleCount, setVisibleCount] = useState(0);
  // playback timer ref so we can clear it on reset
  const playbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // true while send() is in-flight (proxy is buffering); set false when send() resolves
  const sendInFlightRef = useRef(false);

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

  // ── Extract agent names from content once PROMOTION_PROPOSAL appears ──────
  // The events array is never populated by the SDK (proxy buffers everything),
  // so we parse agent_scores out of the PROMOTION_PROPOSAL block in content instead.
  useEffect(() => {
    if (allAgents.length > 0) return; // already extracted
    const agents = extractAgentsFromContent(content);
    if (agents.length > 0) setAllAgents(agents);
  }, [content, allAgents.length]);

  // ── Playback animation: step visibleCount up one at a time ────────────────
  useEffect(() => {
    if (allAgents.length === 0) return;
    if (visibleCount >= allAgents.length) return; // done — dedicated effect below handles clearing
    if (playbackTimerRef.current) clearTimeout(playbackTimerRef.current);
    playbackTimerRef.current = setTimeout(() => {
      setVisibleCount((c) => Math.min(c + 1, allAgents.length));
    }, PLAYBACK_STEP_MS);
    return () => { if (playbackTimerRef.current) clearTimeout(playbackTimerRef.current); };
  }, [allAgents, visibleCount]);

  // ── Clear isWaiting once send resolves, streaming ends, and playback is done
  useEffect(() => {
    if (sendInFlightRef.current) return;   // send still in-flight — never clear early
    if (isStreaming) return;               // streaming still active
    if (allAgents.length > 0 && visibleCount < allAgents.length) return; // playback not done
    setIsWaiting(false);
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
    sendInFlightRef.current = true;
    try {
      await send(message);
    } finally {
      sendInFlightRef.current = false;
    }
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
