import { FormEvent, type ReactElement, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
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
  tool_name: string | null;
  tool_call_id: string | null;
  created_at: number;
}

interface StreamEvent {
  id?: string;
  name?: string;
  input?: unknown;
  envelope?: { success: boolean; data?: unknown; error?: { message: string } };
  text?: string;
  message?: string;
}

interface ToolEvent {
  id: string;
  name: string;
  status: 'running' | 'completed' | 'failed';
  input?: unknown;
  result?: unknown;
}

interface ModelInfo {
  id: string;
  provider: string;
  default: boolean;
}

interface ExplorePlaybook {
  name: string;
  display_name: string;
  description: string;
  latest_release: string;
  live_url: string;
  updated_at: number;
}

export function App(): ReactElement {
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [toolEvents, setToolEvents] = useState<ToolEvent[]>([]);
  const [draft, setDraft] = useState('');
  const [streamingText, setStreamingText] = useState('');
  const [isSending, setIsSending] = useState(false);
  const [errorText, setErrorText] = useState<string | null>(null);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [selectedModel, setSelectedModel] = useState<string>('');
  const [view, setView] = useState<'chat' | 'explore'>('chat');
  const conversationRef = useRef<HTMLElement | null>(null);
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

  useEffect(() => {
    const el = conversationRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, streamingText, toolEvents]);

  async function bootstrap(): Promise<void> {
    void fetchJson<{ models: ModelInfo[] }>('/api/models')
      .then((res) => {
        setModels(res.models);
        const fallback = res.models.find((m) => m.default) ?? res.models[0];
        if (fallback) setSelectedModel(fallback.id);
      })
      .catch(() => undefined);
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
    setErrorText(null);
  }

  async function submit(e: FormEvent): Promise<void> {
    e.preventDefault();
    const content = draft.trim();
    if (!content || !activeSessionId || isSending) return;
    const sessionId = activeSessionId;
    setDraft('');
    setIsSending(true);
    setStreamingText('');
    setToolEvents([]);
    setErrorText(null);
    setMessages((prev) => [
      ...prev,
      {
        id: Date.now(),
        role: 'user',
        content,
        tool_name: null,
        tool_call_id: null,
        created_at: Date.now(),
      },
    ]);

    try {
      await streamChat(sessionId, content, selectedModel, handleStreamEvent);
      const refreshed = await fetchJson<{ sessions: ChatSession[] }>('/api/chat/sessions');
      setSessions(refreshed.sessions);
    } catch (err) {
      setErrorText(err instanceof Error ? err.message : String(err));
    } finally {
      setIsSending(false);
      setStreamingText('');
      // 以服务端为准刷新历史（工具卡从落库的 role=tool 消息恢复）
      await loadMessages(sessionId).catch(() => undefined);
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
      return;
    }
    if (event === 'error') {
      const payload = data as StreamEvent;
      setErrorText(payload.message ?? '本轮处理失败');
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

        <button className="new-chat" onClick={() => void startNewChat()} disabled={isSending}>
          <Plus size={18} />
          New Chat
        </button>

        <nav className="nav-list" aria-label="Primary">
          <button
            className={`nav-item ${view === 'chat' ? 'active' : ''}`}
            onClick={() => setView('chat')}
          >
            <Sparkles size={18} />
            Chat
          </button>
          <button
            className={`nav-item ${view === 'explore' ? 'active' : ''}`}
            onClick={() => setView('explore')}
          >
            <Compass size={18} />
            Explore
          </button>
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
                disabled={isSending}
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
        {view === 'explore' ? (
          <ExploreView />
        ) : (
          <>
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

        <section className="conversation" aria-live="polite" ref={conversationRef}>
          {messages.length === 0 ? (
            <div className="empty-state">
              <Sparkles size={28} />
              <h1>Ask OpenAlva anything.</h1>
              <p>Market facts go through tools. Playbook builds ask for confirmation first.</p>
            </div>
          ) : (
            messages.map((message) => {
              if (message.role === 'tool') {
                const tool = toolEventFromMessage(message);
                return tool ? <ToolCard key={`m-${message.id}`} tool={tool} /> : null;
              }
              return <MessageBubble key={message.id} message={message} />;
            })
          )}

          {toolEvents.length > 0 ? (
            <div className="tool-stack">
              {toolEvents.map((tool) => (
                <ToolCard key={tool.id} tool={tool} />
              ))}
            </div>
          ) : null}

          {streamingText ? (
            <div className="message assistant">
              <div className="message-avatar">
                <Bot size={16} />
              </div>
              <div className="message-body">{streamingText}</div>
            </div>
          ) : null}

          {errorText ? (
            <div className="error-banner" role="alert">
              <AlertTriangle size={16} />
              <span>{errorText}</span>
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
            <select
              className="model-select"
              aria-label="Model"
              value={selectedModel}
              onChange={(e) => setSelectedModel(e.target.value)}
              disabled={isSending || models.length === 0}
            >
              {models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.id}
                  {m.provider === 'local' ? '（本地 fallback）' : ''}
                </option>
              ))}
            </select>
            <button className="send-button" type="submit" disabled={isSending || !draft.trim()}>
              {isSending ? <Loader2 className="spin" size={18} /> : <Send size={18} />}
            </button>
          </div>
        </form>
          </>
        )}
      </main>
    </div>
  );
}

function ExploreView(): ReactElement {
  const [playbooks, setPlaybooks] = useState<ExplorePlaybook[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    void fetchJson<{ playbooks: ExplorePlaybook[] }>('/api/explore')
      .then((res) => setPlaybooks(res.playbooks))
      .catch(() => undefined)
      .finally(() => setLoaded(true));
  }, []);

  return (
    <section className="explore">
      <header className="explore-header">
        <h1>Explore</h1>
        <p>本机已发布的 playbook。</p>
      </header>
      {loaded && playbooks.length === 0 ? (
        <div className="empty-state">
          <Compass size={28} />
          <h1>还没有已发布的 playbook。</h1>
          <p>在 Chat 里让 agent 构建并 release 一个，它就会出现在这里。</p>
        </div>
      ) : (
        <div className="explore-grid">
          {playbooks.map((pb) => (
            <a
              key={pb.name}
              className="explore-card"
              href={pb.live_url}
              target="_blank"
              rel="noreferrer"
            >
              <strong>{pb.display_name}</strong>
              <span className="explore-desc">{pb.description || '（暂无描述）'}</span>
              <span className="explore-meta">
                {pb.latest_release} · {new Date(pb.updated_at).toLocaleDateString()}
              </span>
            </a>
          ))}
        </div>
      )}
    </section>
  );
}

/** 把落库的 role=tool 消息（content = {input, envelope} JSON）还原成工具卡。 */
function toolEventFromMessage(message: ChatMessage): ToolEvent | null {
  try {
    const parsed = JSON.parse(message.content) as {
      input?: unknown;
      envelope?: { success?: boolean };
    };
    return {
      id: message.tool_call_id ?? `tool-${message.id}`,
      name: message.tool_name ?? 'tool',
      status: parsed.envelope?.success ? 'completed' : 'failed',
      input: parsed.input,
      result: parsed.envelope,
    };
  } catch {
    return null;
  }
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
  // artifact.publish 成功后直接内嵌渲染，不折叠
  if (tool.name === 'artifact.publish' && tool.status === 'completed') {
    const data = (tool.result as { data?: { url?: string; title?: string } } | undefined)?.data;
    if (data?.url) {
      return (
        <div className="artifact-card">
          <div className="artifact-title">
            <Sparkles size={15} />
            <span>{data.title ?? 'Artifact'}</span>
            <a href={data.url} target="_blank" rel="noreferrer">
              打开
            </a>
          </div>
          {/* 不给 allow-same-origin：artifact 是模型生成的 HTML，
              同源会让其脚本可直调无鉴权的 /api/tools/* 工具面 */}
          <iframe src={data.url} title={data.title ?? 'artifact'} sandbox="allow-scripts" />
        </div>
      );
    }
  }
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
  model: string,
  onEvent: (event: string, data: StreamEvent | ChatMessage) => void,
): Promise<void> {
  const resp = await fetch(`/api/chat/sessions/${sessionId}/stream`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message, ...(model ? { model } : {}) }),
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
