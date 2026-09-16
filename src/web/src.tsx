import { StrictMode, useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './style.css';

type EventRecord = {
  type: string;
  kind: string;
  payload: unknown;
  threadId?: string;
  seq: number;
};

type Interaction = {
  id: string;
  method: string;
  payload: Record<string, unknown>;
  threadId?: string;
};

type Thread = { id: string; name?: string | null; cwd?: string | null };

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { credentials: 'same-origin', ...init, headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) } });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(typeof body.message === 'string' ? body.message : `Request failed (${response.status}).`);
  return body as T;
}

function App() {
  const [ready, setReady] = useState(false);
  const [status, setStatus] = useState('正在连接本地服务…');
  const [threads, setThreads] = useState<Thread[]>([]);
  const [activeThread, setActiveThread] = useState<string>();
  const [draft, setDraft] = useState('');
  const [events, setEvents] = useState<EventRecord[]>([]);
  const [interactions, setInteractions] = useState<Interaction[]>([]);
  const [error, setError] = useState<string>();

  const activeEvents = useMemo(() => events.filter((event) => !activeThread || event.threadId === activeThread), [events, activeThread]);

  async function loadThreads() {
    const result = await request<{ data?: Thread[]; threads?: Thread[] }>('/api/threads');
    const next = result.data ?? result.threads ?? [];
    setThreads(next);
    setActiveThread((current) => current ?? next[0]?.id);
  }

  useEffect(() => {
    const token = new URLSearchParams(location.hash.slice(1)).get('bootstrap');
    const initialize = async () => {
      try {
        if (token) {
          await fetch('/api/auth/bootstrap', { method: 'POST', headers: { 'X-Bootstrap-Token': token }, credentials: 'same-origin' });
          history.replaceState(null, '', `${location.pathname}${location.search}`);
        }
        const current = await request<{ connection: string; workspace: string }>('/api/status');
        setStatus(`${current.connection === 'ready' ? '已连接' : 'Codex 未连接'} · ${current.workspace}`);
        setReady(true);
        await loadThreads();
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : '无法连接本地服务。');
      }
    };
    void initialize();
  }, []);

  useEffect(() => {
    if (!ready) return;
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const socket = new WebSocket(`${protocol}//${location.host}/api/events`);
    socket.onmessage = (message) => {
      const event = JSON.parse(message.data) as EventRecord;
      if (event.type === 'snapshot') {
        const pending = (event.payload as { pendingInteractions?: Interaction[] }).pendingInteractions ?? [];
        setInteractions(pending);
        return;
      }
      if (event.kind === 'interaction.requested') setInteractions((current) => [...current, event.payload as Interaction]);
      if (event.kind === 'interaction.submitted') {
        const id = (event.payload as { id: string }).id;
        setInteractions((current) => current.filter((interaction) => interaction.id !== id));
      }
      setEvents((current) => [...current.slice(-499), event]);
    };
    socket.onclose = () => setStatus((current) => `${current} · 实时连接已断开`);
    return () => socket.close();
  }, [ready]);

  async function createThread() {
    setError(undefined);
    try {
      const result = await request<{ thread?: Thread }>('/api/threads', { method: 'POST', body: '{}' });
      if (result.thread) {
        setThreads((current) => [result.thread!, ...current]);
        setActiveThread(result.thread.id);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '无法创建会话。');
    }
  }

  async function submit() {
    if (!activeThread || !draft.trim()) return;
    const text = draft.trim();
    setDraft('');
    setError(undefined);
    try {
      await request(`/api/threads/${encodeURIComponent(activeThread)}/turns`, {
        method: 'POST',
        body: JSON.stringify({ text, clientRequestId: crypto.randomUUID() })
      });
      setEvents((current) => [...current, { type: 'event', kind: 'ui.user_message', payload: { text }, threadId: activeThread, seq: Number.MAX_SAFE_INTEGER }]);
    } catch (cause) {
      setDraft(text);
      setError(cause instanceof Error ? cause.message : '发送失败。');
    }
  }

  async function resolveInteraction(interaction: Interaction, result: Record<string, unknown>) {
    try {
      await request(`/api/interactions/${encodeURIComponent(interaction.id)}/resolve`, {
        method: 'POST',
        body: JSON.stringify({ result })
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '无法提交审批。');
    }
  }

  return <main>
    <aside>
      <div className="brand">Codex WebUI</div>
      <button className="primary" onClick={() => void createThread()} disabled={!ready}>新建会话</button>
      <nav aria-label="会话列表">
        {threads.map((thread) => <button key={thread.id} className={thread.id === activeThread ? 'thread active' : 'thread'} onClick={() => setActiveThread(thread.id)}>{thread.name || thread.id}</button>)}
      </nav>
    </aside>
    <section className="conversation">
      <header>{status}</header>
      {error && <div className="error" role="alert">{error}</div>}
      <div className="timeline">
        {activeEvents.map((event, index) => <EventCard key={`${event.seq}-${index}`} event={event} />)}
        {activeEvents.length === 0 && <p className="empty">选择或新建会话后开始工作。</p>}
      </div>
      <div className="composer">
        <textarea value={draft} onChange={(event) => setDraft(event.target.value)} placeholder="描述你希望 Codex 完成的工作…" onKeyDown={(event) => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); void submit(); } }} />
        <button className="primary" onClick={() => void submit()} disabled={!activeThread || !draft.trim()}>发送</button>
      </div>
    </section>
    <aside className="interactions">
      <h2>待处理</h2>
      {interactions.length === 0 && <p className="empty">没有待处理的审批或问题。</p>}
      {interactions.map((interaction) => <InteractionCard key={interaction.id} interaction={interaction} resolve={resolveInteraction} />)}
    </aside>
  </main>;
}

function EventCard({ event }: { event: EventRecord }) {
  if (event.kind === 'ui.user_message') return <article className="message user">{(event.payload as { text: string }).text}</article>;
  const payload = event.payload as Record<string, unknown>;
  const text = typeof payload.delta === 'string' ? payload.delta : typeof payload.text === 'string' ? payload.text : undefined;
  return <article className="message"><code>{event.kind}</code>{text ? <p>{text}</p> : <pre>{JSON.stringify(payload, null, 2)}</pre>}</article>;
}

function InteractionCard({ interaction, resolve }: { interaction: Interaction; resolve(interaction: Interaction, result: Record<string, unknown>): Promise<void> }) {
  const approval = interaction.method === 'item/commandExecution/requestApproval' || interaction.method === 'item/fileChange/requestApproval';
  const permissions = interaction.method === 'item/permissions/requestApproval';
  const question = interaction.method === 'item/tool/requestUserInput';
  const mcp = interaction.method === 'mcpServer/elicitation/request';
  return <article className="interaction">
    <code>{interaction.method}</code>
    <pre>{JSON.stringify(interaction.payload, null, 2)}</pre>
    {approval && <div><button onClick={() => void resolve(interaction, { decision: 'accept' })}>允许一次</button><button onClick={() => void resolve(interaction, { decision: 'decline' })}>拒绝</button><button onClick={() => void resolve(interaction, { decision: 'cancel' })}>取消</button></div>}
    {permissions && <div><button onClick={() => void resolve(interaction, { permissions: {}, scope: 'turn' })}>拒绝权限请求</button></div>}
    {question && <QuestionForm interaction={interaction} resolve={resolve} />}
    {mcp && <div><button onClick={() => void resolve(interaction, { action: 'cancel', content: null })}>取消请求</button></div>}
    {!approval && !permissions && !question && !mcp && <p className="empty">此交互类型尚不支持在网页中处理。</p>}
  </article>;
}

function QuestionForm({ interaction, resolve }: { interaction: Interaction; resolve(interaction: Interaction, result: Record<string, unknown>): Promise<void> }) {
  const questions = Array.isArray(interaction.payload.questions) ? interaction.payload.questions as Array<{ id?: unknown; question?: unknown; options?: unknown }> : [];
  const [answers, setAnswers] = useState<Record<string, string>>({});
  if (questions.length === 0) return <p className="empty">此问题没有可展示的选项。</p>;
  return <form onSubmit={(event) => { event.preventDefault(); const result: Record<string, unknown> = {}; for (const item of questions) { if (typeof item.id === 'string' && answers[item.id]) result[item.id] = { answers: [answers[item.id]] }; } void resolve(interaction, { answers: result }); }}>
    {questions.map((item) => {
      const questionId = item.id;
      if (typeof questionId !== 'string') return null;
      const options = Array.isArray(item.options) ? item.options as Array<{ label?: unknown; value?: unknown }> : [];
      return <label className="question" key={questionId}>{typeof item.question === 'string' ? item.question : questionId}<select value={answers[questionId] ?? ''} onChange={(event) => setAnswers((current) => ({ ...current, [questionId]: event.target.value }))}><option value="">请选择</option>{options.map((option, index) => { const value = typeof option.value === 'string' ? option.value : typeof option.label === 'string' ? option.label : String(index); return <option key={value} value={value}>{typeof option.label === 'string' ? option.label : value}</option>; })}</select></label>;
    })}
    <button type="submit">提交回答</button>
  </form>;
}

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
