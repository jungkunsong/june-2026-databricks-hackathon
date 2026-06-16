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
  /** Seed message sent automatically on mount */
  initialMessage?: string;
  placeholder?: string;
  started?: boolean;
  onStreamingChange?: (streaming: boolean) => void;
  /** Called whenever the message list changes — lets parent parse proposals */
  onMessagesChange?: (messages: { role: string; content: string }[]) => void;
}

// ── Agent activity feed ───────────────────────────────────────────────────────

const AGENT_LABELS: Record<string, string> = {
  'agent-evidence-fetcher':               'Fetching raw record…',
  'agent-website-validator':              'Checking website…',
  'agent-phone-validator':                'Validating phone number…',
  'agent-location-validator':             'Verifying location & coordinates…',
  'agent-facebook-validator':             'Checking Facebook page…',
  'agent-similarity-scorer':              'Scoring name & address similarity…',
  'agent-duplicate-detector':             'Scanning for duplicate records…',
  'agent-context-validator':              'Assessing record completeness…',
  'agent-skill-matcher':                  'Matching specialties to equipment…',
  'agent-source-authority-validator':     'Checking source authority…',
  'agent-controlled-vocabulary-validator':'Validating controlled vocabulary…',
};

function agentLabel(toolName: string): string {
  return AGENT_LABELS[toolName] ?? `Calling ${toolName.replace(/^agent-/, '').replace(/-/g, ' ')}…`;
}

/**
 * Strip raw sub-agent JSON blobs and the PROMOTION_PROPOSAL block from a
 * supervisor message before displaying it to the user.
 *
 * The supervisor emits tool-result JSON objects concatenated directly before
 * the human-readable prose — sometimes with newlines between them, sometimes
 * without (e.g. `}{` back-to-back as a single streaming string). A line-based
 * approach fails in the no-newline case, so we use a character-level scanner
 * that walks the string, extracts every top-level JSON object, checks whether
 * it looks like a sub-agent result, and removes it.
 */
function cleanContent(raw: string): string {
  // 1. Remove PROMOTION_PROPOSAL block (everything from the marker to end)
  let s = raw.replace(/PROMOTION_PROPOSAL:[\s\S]*$/, '').trimEnd();

  // 2. Walk the string character-by-character, collecting top-level JSON
  //    objects. For each one, decide whether to keep or drop it.
  let result = '';
  let i = 0;
  while (i < s.length) {
    // Skip whitespace between tokens
    if (s[i] === '\n' || s[i] === '\r' || s[i] === ' ' || s[i] === '\t') {
      // Preserve whitespace that isn't between two JSON blobs
      result += s[i];
      i++;
      continue;
    }

    if (s[i] === '{') {
      // Extract the full balanced JSON object starting at i
      let depth = 0;
      let inString = false;
      let escape = false;
      let j = i;
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
        // Drop if it's a sub-agent result or evidence-fetcher output
        if (
          typeof obj['agent'] === 'string' ||          // all sub-agent results
          ('name' in obj && 'latitude' in obj) ||       // evidence-fetcher
          ('row_id' in obj && 'candidates' in obj)      // duplicate-detector alt
        ) {
          drop = true;
        }
      } catch {
        // Not valid JSON — keep as-is
      }

      if (!drop) result += blob;
      i = j;
    } else {
      result += s[i];
      i++;
    }
  }

  // 3. Collapse runs of 3+ blank lines and trim
  return result.replace(/\n{3,}/g, '\n\n').trim();
}

export function AgentChat({ agentName, initialMessage, placeholder, started = false, onStreamingChange, onMessagesChange }: AgentChatProps = {}) {
  const { agents, defaultAgent } =
    usePluginClientConfig<AgentsClientConfig>('agents');
  const activeAgent = agentName ?? defaultAgent ?? agents[0] ?? null;

  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [pendingAssistantId, setPendingAssistantId] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  // Tracks whether send() has resolved but we're waiting for the final content sync
  const sendDoneRef = useRef(false);

  // Notify parent whenever messages change so it can parse proposals
  useEffect(() => {
    onMessagesChange?.(messages.map((m) => ({ role: m.role, content: m.content })));
  }, [messages, onMessagesChange]);

  // Use a ref so the seed effect always sees the latest `send` without
  // needing it in the dependency array (avoids re-triggering on every render).
  const sendRef = useRef<((msg: string) => Promise<void>) | null>(null);
  const resetRef = useRef<(() => void) | null>(null);
  // Guard: fire the seed message exactly once
  const seededRef = useRef(false);

  const handleEvent = (event: AgentChatEvent) => {
    if (
      event.type === 'response.output_item.added' &&
      event.item?.type === 'function_call' &&
      event.item.name
    ) {
      setMessages((prev) => [
        ...prev,
        {
          id: `t-${Date.now()}-${Math.random()}`,
          role: 'tool',
          toolName: event.item?.name,
          content: event.item?.arguments ?? '',
        },
      ]);
    }
  };

  const { content, isStreaming, error, send, reset } = useAgentChat({
    agent: activeAgent ?? '',
    onEvent: handleEvent,
  });

  // Keep refs in sync with the latest send/reset functions
  sendRef.current = send;
  resetRef.current = reset;

  // Sync streaming state to parent
  useEffect(() => {
    onStreamingChange?.(isStreaming);
  }, [isStreaming, onStreamingChange]);

  // Scroll to bottom on new content
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages, content]);

  // Update the in-progress assistant bubble with streamed content
  useEffect(() => {
    if (!pendingAssistantId) return;
    setMessages((prev) =>
      prev.map((m) =>
        m.id === pendingAssistantId ? { ...m, content } : m,
      ),
    );
    // If send() already resolved, clear the pending ID now that content is synced
    if (sendDoneRef.current) {
      sendDoneRef.current = false;
      setPendingAssistantId(null);
    }
  }, [content, pendingAssistantId]);

  // Fire the seed message once — runs when started=true AND activeAgent is known
  // Uses refs so it doesn't re-fire if send/initialMessage identity changes.
  useEffect(() => {
    if (!started || !activeAgent || seededRef.current) return;
    const msg = initialMessage?.trim();
    if (!msg) return;

    seededRef.current = true;
    const assistantId = `a-seed-${Date.now()}`;

    // Reset the thread so every verification starts fresh — prevents the
    // model from losing track of its tools on a long accumulated thread.
    resetRef.current?.();

    setMessages([
      { id: `u-seed-${Date.now()}`, role: 'user', content: msg },
      { id: assistantId, role: 'assistant', content: '' },
    ]);
    setPendingAssistantId(assistantId);

    // Retry with exponential backoff on 429 rate-limit errors (up to 3 attempts)
    const trySend = async (attemptsLeft: number): Promise<void> => {
      try {
        await sendRef.current!(msg);
        sendDoneRef.current = true;
      } catch (err) {
        const is429 =
          String(err).includes('429') ||
          String(err).toLowerCase().includes('rate limit') ||
          String(err).toLowerCase().includes('too many requests');
        if (is429 && attemptsLeft > 1) {
          const delay = (4 - attemptsLeft) * 3000; // 3s, 6s
          await new Promise((r) => setTimeout(r, delay));
          await trySend(attemptsLeft - 1);
        } else {
          throw err;
        }
      }
    };
    void trySend(3);
  // Only re-evaluate when the things that gate the send change
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [started, activeAgent, initialMessage]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const message = input.trim();
    if (!message || isStreaming || !activeAgent) return;
    setInput('');
    const assistantId = `a-${Date.now()}`;
    setMessages((prev) => [
      ...prev,
      { id: `u-${Date.now()}`, role: 'user', content: message },
      { id: assistantId, role: 'assistant', content: '' },
    ]);
    setPendingAssistantId(assistantId);
    await send(message);
    sendDoneRef.current = true;
  };

  return (
    <div className="flex h-full flex-col">
      {/* Messages */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto space-y-3 p-4">
        {messages.length === 0 && (
          <div className="flex flex-col items-center justify-center h-full gap-2 text-center">
            <Bot className="h-8 w-8 text-muted-foreground/40" />
            <p className="text-xs text-muted-foreground">
              {started ? 'Supervisor Agent is initialising…' : 'The Supervisor Agent is ready.'}
            </p>
          </div>
        )}
        {messages.map((m, idx) => {
          // ── Tool call row — live activity feed ──────────────────────────
          if (m.role === 'tool') {
            // Only show tool messages while streaming (hide once final answer arrives)
            if (!isStreaming) return null;
            const label = agentLabel(m.toolName ?? '');
            // The very last tool message gets a spinner; earlier ones get a check
            const isLatest = idx === messages.map((x, i) => x.role === 'tool' ? i : -1).filter(i => i >= 0).at(-1);
            return (
              <div key={m.id} className="flex items-center gap-2 pl-1">
                <div className="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full bg-[#EEEDE9]">
                  {isLatest
                    ? <Loader2 className="h-3 w-3 animate-spin text-[#FF3621]" />
                    : <Zap className="h-3 w-3 text-green-600" />
                  }
                </div>
                <span className={`text-xs ${isLatest ? 'text-[#0B2026] font-medium' : 'text-muted-foreground line-through'}`}>
                  {label}
                </span>
              </div>
            );
          }

          // ── User / assistant bubble ──────────────────────────────────────
          const isUser = m.role === 'user';
          return (
            <div key={m.id} className={`flex items-start gap-2 ${isUser ? 'flex-row-reverse' : ''}`}>
              <div className={`flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full ${isUser ? 'bg-[#FF3621]' : 'bg-[#0B2026]'}`}>
                {isUser
                  ? <User className="h-3 w-3 text-white" />
                  : <Bot className="h-3 w-3 text-white" />
                }
              </div>
              <div className={`max-w-[85%] rounded-lg px-3 py-2 text-sm ${isUser ? 'bg-[#FF3621]/10 text-[#0B2026]' : 'bg-[#EEEDE9] text-[#0B2026]'}`}>
                <div className="whitespace-pre-wrap leading-relaxed">
                  {(m.content ? cleanContent(m.content) : '') || (isStreaming && m.id === pendingAssistantId ? (
                    // Only show "Preparing summary…" once agents have started firing.
                    // Before that, the activity feed rows below the bubble handle the loading state.
                    messages.some((x) => x.role === 'tool') ? (
                      <span className="flex items-center gap-1 text-muted-foreground">
                        <Loader2 className="h-3 w-3 animate-spin" /> Preparing summary…
                      </span>
                    ) : null
                  ) : '')}
                </div>
              </div>
            </div>
          );
        })}
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
            {isStreaming
              ? <Loader2 className="h-4 w-4 animate-spin" />
              : <Send className="h-4 w-4" />
            }
          </button>
        </form>
      )}
    </div>
  );
}
