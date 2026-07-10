import { FormEvent, type ReactElement, useEffect, useMemo, useState } from 'react';
import {
  Bot,
  ChevronDown,
  Compass,
  FileText,
  LayoutDashboard,
  Loader2,
  PanelLeft,
  Plus,
  Send,
  Settings,
  Sparkles,
  UserRound,
  Wrench,
} from 'lucide-react';

interface ChatSession {
  id: string;
  title: string;
  updated_at: number;
}

interface ChatMessage {
  id: number;
  role: 'user' | 'assistant' | 'tool';
  content: string;
  created_at: number;
}

interface StreamEvent {
  id?: string;
  name?: string;
  input?: unknown;
  envelope?: { success: boolean; data?: unknown; error?: { message: string } };
  text?: string;
}

interface ToolEvent {
  id: string;
  name: string;
  status: 'running' | 'completed' | 'failed';
  input?: unknown;
  result?: unknown;
}

export function App(): ReactElement {
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [toolEvents, setToolEvents] = useState<ToolEvent[]>([]);
  const [draft, setDraft] = useState('');
  const [streamingText, setStreamingText] = useState('');
  const [isSending, setIsSending] = useState(false);
  const activeSession = useMemo(
    () => sessions.find((s) => s.id === activeSessionId) ?? null,
    [activeSessionId, sessions],
  );

  useEffect(() => {
    void bootstrap();
  }, []);

  useEffect(() => {
    if (!activeSessionId) return;
    void loadMessages(activeSessionId);
  }, [activeSessionId]);

  async function bootstrap(): Promise<void> {
    const loaded = await fetchJson<{ sessions: ChatSession[] }>('/api/chat/sessions');
    if (loaded.sessions.length > 0) {
      setSessions(loaded.sessions);
      setActiveSessionId(loaded.sessions[0]!.id);
      return;
    }
    const created = await createSession('New Chat');
    setSessions([created]);
    setActiveSessionId(created.id);
  }

  async function createSession(title: string): Promise<ChatSession> {
    const res = await fetchJson<{ session: ChatSession }>('/api/chat/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title }),
    });
    return res.session;
  }

  async function loadMessages(sessionId: string): Promise<void> {
    const res = await fetchJson<{ messages: ChatMessage[] }>(
      `/api/chat/sessions/${sessionId}/messages`,
    );
    setMessages(res.messages);
    setToolEvents([]);
    setStreamingText('');
  }

  async function startNewChat(): Promise<void> {
    const session = await createSession('New Chat');
    setSessions((prev) => [session, ...prev]);
    setActiveSessionId(session.id);
    setMessages([]);
    setToolEvents([]);
    setStreamingText('');
  }

  async function submit(e: FormEvent): Promise<void> {
    e.preventDefault();
    const content = draft.trim();
    if (!content || !activeSessionId || isSending) return;
    setDraft('');
    setIsSending(true);
    setStreamingText('');
    setToolEvents([]);
    setMessages((prev) => [
      ...prev,
      { id: Date.now(), role: 'user', content, created_at: Date.now() },
    ]);

    try {
      await streamChat(activeSessionId, content, handleStreamEvent);
      const refreshed = await fetchJson<{ sessions: ChatSession[] }>('/api/chat/sessions');
      setSessions(refreshed.sessions);
    } finally {
      setIsSending(false);
      setStreamingText('');
    }
  }

  function handleStreamEvent(event: string, data: StreamEvent | ChatMessage): void {
    if (event === 'text_delta' && 'text' in data) {
      setStreamingText((prev) => prev + (data.text ?? ''));
      return;
    }
    if (event === 'tool_start') {
      const payload = data as StreamEvent;
      if (typeof payload.id !== 'string' || typeof payload.name !== 'string') return;
      const id = payload.id;
      const name = payload.name;
      setToolEvents((prev) => [
        ...prev,
        { id, name, status: 'running', input: payload.input },
      ]);
      return;
    }
    if (event === 'tool_result') {
      const payload = data as StreamEvent;
      if (typeof payload.id !== 'string') return;
      const success = payload.envelope?.success ?? false;
      setToolEvents((prev) =>
        prev.map((tool) =>
          tool.id === payload.id
            ? {
                ...tool,
                status: success ? 'completed' : 'failed',
                result: payload.envelope,
              }
            : tool,
        ),
      );
      return;
    }
    if (event === 'message' && 'role' in data) {
      setMessages((prev) => [...prev, data as ChatMessage]);
    }
  }

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand-row">
          <div className="brand-mark">OA</div>
          <div className="brand-copy">
            <strong>OpenAlva</strong>
            <span>Local finance agent</span>
          </div>
          <button className="icon-button dark" aria-label="Collapse sidebar">
            <PanelLeft size={18} />
          </button>
        </div>

        <button className="new-chat" onClick={() => void startNewChat()}>
          <Plus size={18} />
          New Chat
        </button>

        <nav className="nav-list" aria-label="Primary">
          <a className="nav-item active" href="#chat">
            <Sparkles size={18} />
            Chat
          </a>
          <a className="nav-item" href="#explore">
            <Compass size={18} />
            Explore
          </a>
          <a className="nav-item" href="#portfolio">
            <LayoutDashboard size={18} />
            Portfolio
          </a>
          <a className="nav-item" href="#skills">
            <FileText size={18} />
            Skills
          </a>
        </nav>

        <section className="sidebar-section">
          <div className="section-label">Chats</div>
          <div className="session-list">
            {sessions.map((session) => (
              <button
                key={session.id}
                className={`session-item ${session.id === activeSessionId ? 'selected' : ''}`}
                onClick={() => setActiveSessionId(session.id)}
              >
                <Bot size={15} />
                <span>{session.title}</span>
              </button>
            ))}
          </div>
        </section>

        <div className="account-row">
          <div className="avatar">
            <UserRound size={17} />
          </div>
          <div>
            <strong>George</strong>
            <span>Single-player</span>
          </div>
          <Settings size={17} />
        </div>
      </aside>

      <main className="main">
        <header className="topbar">
          <button className="title-button">
            {activeSession?.title ?? 'New Chat'}
            <ChevronDown size={16} />
          </button>
          <button className="secondary-button">
            <FileText size={16} />
            Export
          </button>
        </header>

        <section className="conversation" aria-live="polite">
          {messages.length === 0 ? (
            <div className="empty-state">
              <Sparkles size={28} />
              <h1>Ask OpenAlva anything.</h1>
              <p>Market facts go through tools. Playbook builds ask for confirmation first.</p>
            </div>
          ) : (
            messages.map((message) => <MessageBubble key={message.id} message={message} />)
          )}

          {streamingText ? (
            <div className="message assistant">
              <div className="message-avatar">
                <Bot size={16} />
              </div>
              <div className="message-body">{streamingText}</div>
            </div>
          ) : null}

          {toolEvents.length > 0 ? (
            <div className="tool-stack">
              {toolEvents.map((tool) => (
                <ToolCard key={tool.id} tool={tool} />
              ))}
            </div>
          ) : null}
        </section>

        <form className="composer" onSubmit={(e) => void submit(e)}>
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Ask OpenAlva anything. @ for context, / for skills"
            rows={2}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void submit(e);
              }
            }}
          />
          <div className="composer-actions">
            <button className="icon-button" type="button" aria-label="Attach context">
              <Plus size={18} />
            </button>
            <button className="skill-button" type="button">
              <Wrench size={16} />
              Skills
            </button>
            <div className="spacer" />
            <button className="model-button" type="button">
              claude-fable-5
              <ChevronDown size={15} />
            </button>
            <button className="send-button" type="submit" disabled={isSending || !draft.trim()}>
              {isSending ? <Loader2 className="spin" size={18} /> : <Send size={18} />}
            </button>
          </div>
        </form>
      </main>
    </div>
  );
}

function MessageBubble({ message }: { message: ChatMessage }): ReactElement {
  const isUser = message.role === 'user';
  return (
    <div className={`message ${isUser ? 'user' : 'assistant'}`}>
      <div className="message-avatar">{isUser ? <UserRound size={16} /> : <Bot size={16} />}</div>
      <div className="message-body">{message.content}</div>
    </div>
  );
}

function ToolCard({ tool }: { tool: ToolEvent }): ReactElement {
  return (
    <details className={`tool-card ${tool.status}`} open={tool.status === 'running'}>
      <summary>
        <span className="tool-status">
          {tool.status === 'running' ? <Loader2 className="spin" size={15} /> : <Wrench size={15} />}
          {tool.status === 'running' ? 'Running' : tool.status === 'failed' ? 'Failed' : 'Ran'}
        </span>
        <code>{tool.name}</code>
      </summary>
      <pre>{JSON.stringify(tool.result ?? tool.input, null, 2)}</pre>
    </details>
  );
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const resp = await fetch(url, init);
  if (!resp.ok) throw new Error(`${url} failed: ${resp.status}`);
  return (await resp.json()) as T;
}

async function streamChat(
  sessionId: string,
  message: string,
  onEvent: (event: string, data: StreamEvent | ChatMessage) => void,
): Promise<void> {
  const resp = await fetch(`/api/chat/sessions/${sessionId}/stream`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message }),
  });
  if (!resp.ok || !resp.body) throw new Error(`chat stream failed: ${resp.status}`);

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split('\n\n');
    buffer = parts.pop() ?? '';
    for (const part of parts) {
      const event = parseSse(part);
      if (event) onEvent(event.name, event.data);
    }
  }
  if (buffer.trim()) {
    const event = parseSse(buffer);
    if (event) onEvent(event.name, event.data);
  }
}

function parseSse(raw: string): { name: string; data: StreamEvent | ChatMessage } | null {
  const name = raw
    .split('\n')
    .find((line) => line.startsWith('event: '))
    ?.slice('event: '.length);
  const data = raw
    .split('\n')
    .find((line) => line.startsWith('data: '))
    ?.slice('data: '.length);
  if (!name || !data) return null;
  return { name, data: JSON.parse(data) as StreamEvent | ChatMessage };
}
