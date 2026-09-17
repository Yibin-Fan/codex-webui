import { StrictMode, useEffect, useMemo, useRef, useState } from 'react';
import { emptyToolProjection, projectToolEvent, type ProjectedItem, type ToolProjection } from './tool-projection.js';
import { createRoot } from 'react-dom/client';
import './style.css';

type EventRecord = {
  type: string;
  kind: string;
  payload: unknown;
  threadId?: string;
  seq: number;
  epoch?: string;
};

type EventCursor = { epoch: string; seq: number };

type SnapshotPayload = {
  connection?: string;
  activeTurns?: Record<string, string>;
  pendingInteractions?: Interaction[];
  resync?: boolean;
  events?: EventRecord[];
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
  const [historyByThread, setHistory] = useState<Record<string, EventRecord[]>>({});
  const [activeTurns, setActiveTurns] = useState<Record<string, string>>({});
  const [toolProjection, setToolProjection] = useState<ToolProjection>(emptyToolProjection);
  const [draft, setDraft] = useState('');
  const [events, setEvents] = useState<EventRecord[]>([]);
  const [interactions, setInteractions] = useState<Interaction[]>([]);
  const [error, setError] = useState<string>();
  const cursorRef = useRef<EventCursor | undefined>(undefined);

  const activeEvents = useMemo(() => [
    ...(activeThread ? historyByThread[activeThread] ?? [] : []),
    ...events.filter((event) => !activeThread || event.threadId === activeThread)
  ], [events, activeThread, historyByThread]);
  const activeTurnId = activeThread ? activeTurns[activeThread] : undefined;
  const activeItems = useMemo(() => Object.values(toolProjection.items).filter((item) => item.threadId === activeThread), [toolProjection.items, activeThread]);
  const activeDiff = activeTurnId && activeThread ? toolProjection.diffs[`${activeThread}:${activeTurnId}`] : undefined;

  async function loadThreads() {
    const result = await request<{ data?: Thread[]; threads?: Thread[] }>('/api/threads');
    const next = result.data ?? result.threads ?? [];
    setThreads(next);
    const threadId = next[0]?.id;
    if (threadId) await loadThread(threadId);
  }

  async function loadThread(threadId: string) {
    setActiveThread(threadId);
    setError(undefined);
    try {
      const result = await request<Record<string, unknown>>(`/api/threads/${encodeURIComponent(threadId)}`);
      const entries = historyEvents(result, threadId);
      setHistory((current) => ({ ...current, [threadId]: entries }));
      setToolProjection((current) => ({
        items: Object.fromEntries(Object.entries(current.items).filter(([, item]) => item.threadId !== threadId)),
        diffs: Object.fromEntries(Object.entries(current.diffs).filter(([key]) => !key.startsWith(`${threadId}:`)))
      }));
      const runningTurn = runningTurnId(result);
      setActiveTurns((current) => runningTurn ? { ...current, [threadId]: runningTurn } : withoutKey(current, threadId));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '无法读取会话历史。');
    }
  }

  useEffect(() => {
    const token = new URLSearchParams(location.hash.slice(1)).get('bootstrap');
    const initialize = async () => {
      try {
        if (token) {
          await fetch('/api/auth/bootstrap', { method: 'POST', headers: { 'X-Bootstrap-Token': token }, credentials: 'same-origin' });
          history.replaceState(null, '', `${location.pathname}${location.search}`);
        }
        const current = await request<{ connection: string; workspace: string; activeTurns?: Record<string, string> }>('/api/status');
        setStatus(`${current.connection === 'ready' ? '已连接' : 'Codex 未连接'} · ${current.workspace}`);
        setActiveTurns(current.activeTurns ?? {});
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
    let socket: WebSocket | undefined;
    let reconnectTimer: number | undefined;
    let stopped = false;
    let delay = 500;

    const applyEvent = (event: EventRecord) => {
      if (event.epoch) {
        const cursor = cursorRef.current;
        if (cursor?.epoch === event.epoch && event.seq <= cursor.seq) return;
        if (cursor && cursor.epoch !== event.epoch) {
          setEvents([]);
          setToolProjection(emptyToolProjection());
          setInteractions([]);
          setActiveTurns({});
        }
        cursorRef.current = { epoch: event.epoch, seq: event.seq };
      }
      if (event.kind === 'interaction.requested') {
        const interaction = event.payload as Interaction;
        setInteractions((current) => current.some((item) => item.id === interaction.id) ? current : [...current, interaction]);
      }
      if (event.kind === 'interaction.submitted') {
        const id = (event.payload as { id: string }).id;
        setInteractions((current) => current.filter((interaction) => interaction.id !== id));
      }
      if (event.kind === 'codex.unavailable') {
        setInteractions([]);
        setActiveTurns({});
      }
      if (event.kind === 'codex.turn/started' && event.threadId) {
        const turnId = (event.payload as { turn?: { id?: unknown } }).turn?.id;
        if (typeof turnId === 'string') setActiveTurns((current) => ({ ...current, [event.threadId!]: turnId }));
      }
      if (event.kind === 'codex.turn/completed' && event.threadId) setActiveTurns((current) => withoutKey(current, event.threadId!));
      setToolProjection((current) => projectToolEvent(current, event));
      setEvents((current) => [...current.slice(-499), event]);
    };

    const connect = () => {
      const cursor = cursorRef.current;
      const query = cursor ? `?epoch=${encodeURIComponent(cursor.epoch)}&seq=${cursor.seq}` : '';
      socket = new WebSocket(`${protocol}//${location.host}/api/events${query}`);
      socket.onopen = () => { delay = 500; };
      socket.onmessage = (message) => {
        const event = JSON.parse(message.data) as EventRecord;
        if (event.type !== 'snapshot') {
          applyEvent(event);
          return;
        }
        const payload = event.payload as SnapshotPayload;
        const replay = Array.isArray(payload.events) ? payload.events : [];
        if (payload.resync) {
          cursorRef.current = undefined;
          setEvents([]);
          setToolProjection(emptyToolProjection());
        }
        setInteractions(payload.pendingInteractions ?? []);
        setActiveTurns(payload.activeTurns ?? {});
        replay.forEach(applyEvent);
        if (event.epoch) cursorRef.current = { epoch: event.epoch, seq: event.seq };
        if (payload.connection === 'ready') setStatus((current) => current.replace(' · 实时连接暂时断开，正在重连…', ''));
      };
      socket.onclose = () => {
        if (stopped) return;
        setStatus((current) => current.includes('实时连接暂时断开') ? current : `${current} · 实时连接暂时断开，正在重连…`);
        reconnectTimer = window.setTimeout(connect, delay);
        delay = Math.min(delay * 2, 10_000);
      };
    };

    connect();
    return () => {
      stopped = true;
      if (reconnectTimer !== undefined) window.clearTimeout(reconnectTimer);
      socket?.close();
    };
  }, [ready]);

  async function createThread() {
    setError(undefined);
    try {
      const result = await request<{ thread?: Thread }>('/api/threads', { method: 'POST', body: '{}' });
      if (result.thread) {
        setThreads((current) => [result.thread!, ...current]);
        await loadThread(result.thread.id);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '无法创建会话。');
    }
  }

  async function submit() {
    if (!activeThread || !draft.trim() || activeTurnId) return;
    const text = draft.trim();
    setDraft('');
    setError(undefined);
    try {
      const result = await request<{ turn?: { id?: string } }>(`/api/threads/${encodeURIComponent(activeThread)}/turns`, {
        method: 'POST',
        body: JSON.stringify({ text, clientRequestId: crypto.randomUUID() })
      });
      if (result.turn?.id) setActiveTurns((current) => ({ ...current, [activeThread]: result.turn!.id! }));
      setEvents((current) => [...current, { type: 'event', kind: 'ui.user_message', payload: { text }, threadId: activeThread, seq: Number.MAX_SAFE_INTEGER }]);
    } catch (cause) {
      setDraft(text);
      setError(cause instanceof Error ? cause.message : '发送失败。');
    }
  }

  async function interrupt() {
    if (!activeThread || !activeTurnId) return;
    try {
      await request(`/api/threads/${encodeURIComponent(activeThread)}/interrupt`, { method: 'POST', body: JSON.stringify({ turnId: activeTurnId }) });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '无法停止回合。');
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
        {threads.map((thread) => <button key={thread.id} className={thread.id === activeThread ? 'thread active' : 'thread'} onClick={() => void loadThread(thread.id)}>{thread.name || thread.id}</button>)}
      </nav>
    </aside>
    <section className="conversation">
      <header>{status}</header>
      {error && <div className="error" role="alert">{error}</div>}
      <div className="timeline">
        {activeEvents.map((event, index) => <EventCard key={`${event.seq}-${index}`} event={event} />)}
        {activeItems.map((item) => <LiveItemCard key={item.id} item={item} />)}
        {activeEvents.length === 0 && <p className="empty">选择或新建会话后开始工作。</p>}
      </div>
      <div className="composer">
        <textarea value={draft} disabled={Boolean(activeTurnId)} onChange={(event) => setDraft(event.target.value)} placeholder={activeTurnId ? 'Codex 正在执行任务…' : '描述你希望 Codex 完成的工作…'} onKeyDown={(event) => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); void submit(); } }} />
        {activeTurnId ? <button onClick={() => void interrupt()}>停止</button> : <button className="primary" onClick={() => void submit()} disabled={!activeThread || !draft.trim()}>发送</button>}
      </div>
    </section>
    <aside className="interactions">
      <h2>本轮变更</h2>
      {activeDiff ? <details className="diff" open><summary>查看统一 diff</summary><pre>{activeDiff}</pre></details> : <p className="empty">本回合尚未产生文件变更。</p>}
      <h2>待处理</h2>
      {interactions.length === 0 && <p className="empty">没有待处理的审批或问题。</p>}
      {interactions.map((interaction) => <InteractionCard key={interaction.id} interaction={interaction} resolve={resolveInteraction} />)}
    </aside>
  </main>;
}

function EventCard({ event }: { event: EventRecord }) {
  if (event.kind === 'ui.user_message') return <article className="message user">{(event.payload as { text: string }).text}</article>;
  if (event.kind.startsWith('codex.item/') && event.kind !== 'codex.item/agentMessage') return null;
  const payload = event.payload as Record<string, unknown>;
  const text = typeof payload.delta === 'string' ? payload.delta : typeof payload.text === 'string' ? payload.text : undefined;
  return <article className="message"><code>{event.kind}</code>{text ? <p>{text}</p> : <pre>{JSON.stringify(payload, null, 2)}</pre>}</article>;
}

function LiveItemCard({ item }: { item: ProjectedItem }) {
  if (item.type === 'agentMessage') return <article className="message"><p>{item.text ?? ''}</p></article>;
  if (item.type === 'commandExecution') return <article className="tool-card"><div className="tool-heading"><strong>命令</strong><span>{item.status ?? '运行中'}</span></div><code>{item.command ?? '命令执行中'}</code>{item.cwd && <p className="metadata">{item.cwd}</p>}{item.output && <pre>{item.output}</pre>}</article>;
  if (item.type === 'fileChange') return <article className="tool-card"><div className="tool-heading"><strong>文件变更</strong><span>{item.status ?? '准备中'}</span></div><ul>{(item.changes ?? []).map((change, index) => <li key={index}>{changeLabel(change)}</li>)}</ul></article>;
  if (item.type === 'mcpToolCall') return <article className="tool-card"><div className="tool-heading"><strong>MCP 工具</strong><span>{item.status ?? '运行中'}</span></div><code>{item.server ?? 'server'} / {item.tool ?? 'tool'}</code><pre>{JSON.stringify(item.arguments ?? item.result ?? item.error, null, 2)}</pre></article>;
  if (item.type === 'reasoning' || item.type === 'plan') return <article className="tool-card"><div className="tool-heading"><strong>{item.type === 'plan' ? '计划' : '推理摘要'}</strong></div><pre>{JSON.stringify(item, null, 2)}</pre></article>;
  return <article className="tool-card"><div className="tool-heading"><strong>{item.type}</strong><span>{item.status ?? '完成'}</span></div></article>;
}

function changeLabel(change: unknown): string {
  const record = object(change);
  if (!record) return '未知文件变更';
  const path = typeof record.path === 'string' ? record.path : typeof record.filePath === 'string' ? record.filePath : '未知路径';
  const kind = typeof record.kind === 'string' ? record.kind : object(record.kind)?.type;
  return typeof kind === 'string' ? `${kind}: ${path}` : path;
}

function historyEvents(result: Record<string, unknown>, threadId: string): EventRecord[] {
  const thread = object(result.thread);
  const turns = Array.isArray(thread?.turns) ? thread.turns : [];
  const records: EventRecord[] = [];
  for (const turn of turns) {
    const turnObject = object(turn);
    const items = Array.isArray(turnObject?.items) ? turnObject.items : [];
    for (const item of items) {
      const record = object(item);
      if (!record || typeof record.type !== 'string') continue;
      const seq = records.length + 1;
      if (record.type === 'userMessage') {
        const content = Array.isArray(record.content) ? record.content : [];
        const text = content.map((part) => { const element = object(part); return typeof element?.text === 'string' ? element.text : typeof element?.path === 'string' ? `@${element.path}` : '[附件]'; }).join('\n');
        records.push({ type: 'history', kind: 'ui.user_message', threadId, seq, payload: { text } });
      } else if (record.type === 'agentMessage' && typeof record.text === 'string') {
        records.push({ type: 'history', kind: 'codex.item/agentMessage', threadId, seq, payload: { text: record.text } });
      } else {
        records.push({ type: 'history', kind: `codex.item/${record.type}`, threadId, seq, payload: record });
      }
    }
  }
  return records;
}

function runningTurnId(result: Record<string, unknown>): string | undefined {
  const thread = object(result.thread);
  const turns = Array.isArray(thread?.turns) ? thread.turns : [];
  for (const turn of turns) {
    const record = object(turn);
    if (record?.status === 'inProgress' && typeof record.id === 'string') return record.id;
  }
  return undefined;
}

function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function withoutKey<T>(source: Record<string, T>, key: string): Record<string, T> {
  const { [key]: _, ...remaining } = source;
  return remaining;
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
