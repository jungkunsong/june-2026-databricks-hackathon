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

// Keys that appear inside sub-agent JSON blobs — used to infer which agent
// returned a result when we parse the streaming content directly.
const AGENT_RESULT_KEYS: [string, string][] = [
  ['"agent":"evidence-fetcher"',               'agent-evidence-fetcher'],
  ['"agent":"website-validator"',              'agent-website-validator'],
  ['"agent":"phone-validator"',                'agent-phone-validator'],
  ['"agent":"location-validator"',             'agent-location-validator'],
  ['"agent":"facebook-validator"',             'agent-facebook-validator'],
  ['"agent":"similarity-scorer"',              'agent-similarity-scorer'],
  ['"agent":"duplicate-detector"',             'agent-duplicate-detector'],
  ['"agent":"context-validator"',              'agent-context-validator'],
  ['"agent":"skill-matcher"',                  'agent-skill-matcher'],
  ['"agent":"source-authority-validator"',     'agent-source-authority-validator'],
  ['"agent":"controlled-vocabulary-validator"','agent-controlled-vocabulary-validator'],
  // evidence-fetcher result has no "agent" key — detect by unique field combo
  ['"latitude"',                               'agent-evidence-fetcher'],
];

function agentLabel(toolName: string): string {
  return AGENT_LABELS[toolName] ?? `Calling ${toolName.replace(/^agent-/, '').replace(/-/g, ' ')}…`;
}

/**
 * Scan the raw streaming content for sub-agent result blobs and return the
 * ordered list of agent names whose results have appeared so far.
 * This is the fallback path when onEvent tool_call events don't fire.
 */
function parseAgentsFromContent(raw: string): string[] {
  const seen: string[] = [];
  const seenSet = new Set<string>();
  for (const [key, agentName] of AGENT_RESULT_KEYS) {
    if (raw.includes(key) && !seenSet.has(agentName)) {
      seen.push(agentName);
      seenSet.add(agentName);
    }
  }
  return seen;
}

/**
 * Strip raw sub-agent JSON blobs and the PROMOTION_PROPOSAL block from a
 * supervisor message before displaying it to the user.
 */
function cleanContent(raw: string): string {
  // 1. Remove PROMOTION_PROPOSAL block (everything from the marker to end)
  let s = raw.replace(/PROMOTION_PROPOSAL:[\s\S]*$/, '').trimEnd();

  // 2. Walk the string character-by-character, collecting top-level JSON objects.
  let result = '';
  let i = 0;
  while (i < s.length) {
    if (s[i] === '\n' || s[i] === '\r' || s[i] === ' ' || s[i] === '\t') {
      result += s[i];
      i++;
      continue;
    }
    if (s[i] === '{') {
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
        if (
          typeof obj['agent'] === 'string' ||
          ('name' in obj && 'latitude' in obj) ||
          ('row_id' in obj && 'candidates' in obj)
        ) {
          drop = true;
        }
      } catch { /* not valid JSON — keep */ }
      if (!drop) result += blob;
      i = j;
    } else {
      result += s[i];
      i++;
    }
  }

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
  const sendDoneRef = useRef(false);

  // Notify parent whenever messages change so it can parse proposals
  useEffect(() => {
    onMessagesChange?.(messages.map((m) => ({ role: m.role, content: m.content })));
  }, [messages, onMessagesChange]);

  const sendRef = useRef<((msg: string) => Promise<void>) | null>(null);
  const resetRef = useRef<(() => void) | null>(null);
  const seededRef = useRef(false);

  const handleEvent = (event: AgentChatEvent) => {
    // Capture tool_call events from the supervisor's own LLM calls
    if (
      event.type === 'response.output_item.added' &&
      event.item?.type === 'function_call' &&
      event.item.name
    ) {
      setMessages((prev) => {
        // Deduplicate: don't add the same agent twice
        if (prev.some((m) => m.role === 'tool' && m.toolName === event.item?.name)) return prev;
        return [
          ...prev,
          {
            id: `t-${Date.now()}-${Math.random()}`,
            role: 'tool',
            toolName: event.item?.name,
            content: event.item?.arguments ?? '',
          },
        ];
      });
    }
  };

  const { content, isStreaming, error, send, reset } = useAgentChat({
    agent: activeAgent ?? '',
    onEvent: handleEvent,
  });

  sendRef.current = send;
  resetRef.current = reset;

  useEffect(() => {
    onStreamingChange?.(isStreaming);
  }, [isStreaming, onStreamingChange]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages, content]);

  // Update the in-progress assistant bubble with streamed content.
  // Also inject tool messages parsed from the content stream as a fallback
  // (in case onEvent tool_call events don't fire for sub-agent dispatches).
  useEffect(() => {
    if (!pendingAssistantId) return;

    // Fallback: parse agent names from the raw streaming content
    if (content) {
      const agentsInContent = parseAgentsFromContent(content);
      if (agentsInContent.length > 0) {
        setMessages((prev) => {
          const existingToolNames = new Set(prev.filter(m => m.role === 'tool').map(m => m.toolName));
          const newTools: Message[] = agentsInContent
            .filter(name => !existingToolNames.has(name))
            .map(name => ({
              id: `t-content-${name}`,
              role: 'tool' as const,
              toolName: name,
              content: '',
            }));
          if (newTools.length === 0) return prev;
          // Insert new tool messages just before the pending assistant bubble
          const assistantIdx = prev.findIndex(m => m.id === pendingAssistantId);
          if (assistantIdx === -1) return [...prev, ...newTools];
          return [
            ...prev.slice(0, assistantIdx),
            ...newTools,
            ...prev.slice(assistantIdx),
          ];
        });
      }
    }

    setMessages((prev) =>
      prev.map((m) => m.id === pendingAssistantId ? { ...m, content } : m),
    );
    if (sendDoneRef.current) {
      sendDoneRef.current = false;
      setPendingAssistantId(null);
    }
  }, [content, pendingAssistantId]);

  useEffect(() => {
    if (!started || !activeAgent || seededRef.current) return;
    const msg = initialMessage?.trim();
    if (!msg) return;

    seededRef.current = true;
    const assistantId = `a-seed-${Date.now()}`;

    resetRef.current?.();

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
        const is429 =
          String(err).includes('429') ||
          String(err).toLowerCase().includes('rate limit') ||
          String(err).toLowerCase().includes('too many requests');
        if (is429 && attemptsLeft > 1) {
          const delay = (4 - attemptsLeft) * 3000;
          await new Promise((r) => setTimeout(r, delay));
          await trySend(attemptsLeft - 1);
        } else {
          throw err;
        }
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
            // Hide tool rows once streaming is done (clean final view)
            if (!isStreaming) return null;
            const label = agentLabel(m.toolName ?? '');
            const toolMessages = messages.filter((x) => x.role === 'tool');
            const isLatest = toolMessages[toolMessages.length - 1]?.id === m.id;
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
          void idx; // suppress unused warning
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
