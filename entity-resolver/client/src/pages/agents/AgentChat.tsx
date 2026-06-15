import { useEffect, useRef, useState } from 'react';
import {
  type AgentChatEvent,
  Input,
  useAgentChat,
  usePluginClientConfig,
} from '@databricks/appkit-ui/react';
import { Send, Loader2, Bot, User, Wrench } from 'lucide-react';

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
  /** Override which agent to talk to (defaults to the plugin's defaultAgent) */
  agentName?: string;
  /** Seed message sent automatically on mount */
  initialMessage?: string;
  /** Input placeholder text */
  placeholder?: string;
}

export function AgentChat({ agentName, initialMessage, placeholder }: AgentChatProps = {}) {
  const { agents, defaultAgent } =
    usePluginClientConfig<AgentsClientConfig>('agents');
  const activeAgent = agentName ?? defaultAgent ?? agents[0] ?? null;

  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [pendingAssistantId, setPendingAssistantId] = useState<string | null>(null);
  const [seeded, setSeeded] = useState(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);

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

  const { content, isStreaming, error, send } = useAgentChat({
    agent: activeAgent ?? '',
    onEvent: handleEvent,
  });

  useEffect(() => {
    if (!pendingAssistantId) return;
    setMessages((prev) =>
      prev.map((m) =>
        m.id === pendingAssistantId ? { ...m, content } : m,
      ),
    );
  }, [content, pendingAssistantId]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages, content]);

  // Auto-send the initial message once the agent is ready
  useEffect(() => {
    if (!initialMessage || seeded || !activeAgent || isStreaming) return;
    setSeeded(true);
    const assistantId = `a-${Date.now()}`;
    setMessages([
      { id: `u-${Date.now()}`, role: 'user', content: initialMessage },
      { id: assistantId, role: 'assistant', content: '' },
    ]);
    setPendingAssistantId(assistantId);
    void send(initialMessage).then(() => setPendingAssistantId(null));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeAgent]);

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
    setPendingAssistantId(null);
  };

  return (
    <div className="flex h-full flex-col">
      {/* Messages */}
      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto space-y-3 p-4"
      >
        {messages.length === 0 && (
          <div className="flex flex-col items-center justify-center h-full gap-2 text-center">
            <Bot className="h-8 w-8 text-muted-foreground/40" />
            <p className="text-xs text-muted-foreground">
              The Supervisor Agent is ready.<br />
              Describe what you'd like to investigate.
            </p>
          </div>
        )}
        {messages.map((m) => {
          if (m.role === 'tool') {
            return (
              <div
                key={m.id}
                className="flex items-start gap-2 text-xs font-mono text-muted-foreground"
              >
                <Wrench className="mt-0.5 h-3 w-3 flex-shrink-0 text-amber-500" />
                <span>
                  <span className="font-semibold text-amber-600">{m.toolName}</span>
                  {m.content ? <span className="ml-1 opacity-60">{m.content.slice(0, 80)}</span> : null}
                </span>
              </div>
            );
          }
          const isUser = m.role === 'user';
          return (
            <div
              key={m.id}
              className={`flex items-start gap-2 ${isUser ? 'flex-row-reverse' : ''}`}
            >
              <div className={`flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full ${isUser ? 'bg-[#FF3621]' : 'bg-[#0B2026]'}`}>
                {isUser
                  ? <User className="h-3 w-3 text-white" />
                  : <Bot className="h-3 w-3 text-white" />
                }
              </div>
              <div
                className={`max-w-[85%] rounded-lg px-3 py-2 text-sm ${
                  isUser
                    ? 'bg-[#FF3621]/10 text-[#0B2026]'
                    : 'bg-[#EEEDE9] text-[#0B2026]'
                }`}
              >
                <div className="whitespace-pre-wrap leading-relaxed">
                  {m.content || (isStreaming && m.id === pendingAssistantId ? (
                    <span className="flex items-center gap-1 text-muted-foreground">
                      <Loader2 className="h-3 w-3 animate-spin" /> Thinking…
                    </span>
                  ) : '')}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* Error */}
      {error && (
        <div className="mx-4 mb-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
          {error}
        </div>
      )}

      {/* Input */}
      <form onSubmit={handleSubmit} className="flex gap-2 border-t border-border p-3">
        <Input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={placeholder ?? (activeAgent ? `Message ${activeAgent}…` : 'No agents registered')}
          disabled={!activeAgent || isStreaming}
          className="flex-1 text-sm"
        />
        <button
          type="submit"
          disabled={!input.trim() || !activeAgent || isStreaming}
          className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-md bg-[#FF3621] text-white hover:bg-[#e02e1a] disabled:opacity-40"
        >
          {isStreaming ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Send className="h-4 w-4" />
          )}
        </button>
      </form>
    </div>
  );
}
