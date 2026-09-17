import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import cookie from '@fastify/cookie';
import fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import fastifyStatic from '@fastify/static';
import { WebSocketServer, type WebSocket } from 'ws';
import { CodexAdapter, CodexUnavailableError } from './codex-adapter.js';
import { EventBuffer, type EventCursor } from './event-buffer.js';
import type { JsonObject, PendingInteraction, RpcMessage, WebEvent } from './types.js';

const SESSION_COOKIE = 'codex_webui_session';
const API_PREFIX = '/api/';

export interface CreateWebUiOptions {
  workspace: string;
  bootstrapToken?: string;
  adapter?: CodexAdapter;
  publicDir?: string;
  /** Test and observability hook; production callers should subscribe over WebSocket. */
  onEvent?: (event: WebEvent) => void;
}

export interface RunningWebUi {
  app: FastifyInstance;
  bootstrapToken: string;
  close(): Promise<void>;
}

export async function createWebUi(options: CreateWebUiOptions): Promise<RunningWebUi> {
  const app = fastify({ logger: false, bodyLimit: 1_048_576 });
  const adapter = options.adapter ?? new CodexAdapter();
  const bootstrapToken = options.bootstrapToken ?? randomBytes(32).toString('base64url');
  const sessions = new Set<string>();
  const activeTurns = new Map<string, string>();
  const submittedRequests = new Map<string, { threadId: string; payloadHash: string; response?: JsonObject }>();
  const interactions = new Map<string, PendingInteraction>();
  const clients = new Set<WebSocket>();
  const eventBuffer = new EventBuffer();
  let seq = 0;
  let epoch = randomBytes(16).toString('hex');

  await app.register(cookie);

  const emit = (kind: string, payload: unknown, threadId?: string): WebEvent => {
    const event: WebEvent = {
      protocolVersion: 1,
      type: 'event',
      epoch,
      seq: ++seq,
      kind,
      ...(threadId ? { threadId } : {}),
      payload
    };
    const encoded = JSON.stringify(event);
    eventBuffer.append(event);
    options.onEvent?.(event);
    for (const client of clients) {
      if (client.readyState === client.OPEN) client.send(encoded);
    }
    return event;
  };

  adapter.on('notification', (message: RpcMessage) => {
    const params = message.params ?? {};
    const threadId = typeof params.threadId === 'string' ? params.threadId : undefined;
    const turn = isJsonObject(params.turn) ? params.turn : undefined;
    if (message.method === 'turn/started' && threadId && typeof turn?.id === 'string') activeTurns.set(threadId, turn.id);
    if (message.method === 'turn/completed' && threadId) {
      const completedTurnId = typeof turn?.id === 'string' ? turn.id : undefined;
      if (!completedTurnId || activeTurns.get(threadId) === completedTurnId) activeTurns.delete(threadId);
    }
    emit(`codex.${message.method}`, params, threadId);
  });
  adapter.on('serverRequest', (message: RpcMessage) => {
    const payload = message.params ?? {};
    const interaction: PendingInteraction = {
      id: randomBytes(18).toString('base64url'),
      upstreamRequestId: message.id!,
      method: message.method!,
      threadId: typeof payload.threadId === 'string' ? payload.threadId : undefined,
      turnId: typeof payload.turnId === 'string' ? payload.turnId : undefined,
      payload,
      createdAt: Date.now()
    };
    interactions.set(interaction.id, interaction);
    emit('interaction.requested', interaction, interaction.threadId);
  });
  adapter.on('unavailable', (error: Error) => {
    interactions.clear();
    activeTurns.clear();
    epoch = randomBytes(16).toString('hex');
    seq = 0;
    eventBuffer.clear();
    emit('codex.unavailable', { message: error.message });
  });

  function isAuthenticated(request: FastifyRequest): boolean {
    return request.cookies[SESSION_COOKIE] === bootstrapToken;
  }

  function authenticate(request: FastifyRequest, reply: { code(statusCode: number): { send(value: unknown): unknown } }): boolean {
    if (!isAuthenticated(request)) {
      reply.code(401).send({ code: 'unauthorized', message: 'Open the local launch URL to authenticate.' });
      return false;
    }
    return true;
  }

  app.post('/api/auth/bootstrap', async (request, reply) => {
    const candidate = request.headers['x-bootstrap-token'];
    if (typeof candidate !== 'string' || !sameToken(candidate, bootstrapToken)) {
      return reply.code(401).send({ code: 'unauthorized', message: 'The launch link is invalid or has expired.' });
    }
    reply.setCookie(SESSION_COOKIE, bootstrapToken, {
      httpOnly: true,
      sameSite: 'strict',
      path: '/',
      maxAge: 8 * 60 * 60,
      secure: false
    });
    return { ok: true };
  });

  app.get('/api/status', async (request, reply) => {
    if (!authenticate(request, reply)) return;
    return { workspace: options.workspace, connection: adapter.isAvailable ? 'ready' : 'unavailable', activeTurns: Object.fromEntries(activeTurns), epoch, protocolVersion: 1 };
  });

  app.get('/api/threads', async (request, reply) => {
    if (!authenticate(request, reply)) return;
    try {
      const result = await adapter.request('thread/list', { cwd: options.workspace, limit: 50 });
      for (const thread of threadList(result)) sessions.add(thread.id);
      return result;
    } catch (error) {
      return upstreamError(reply, error);
    }
  });

  app.post('/api/threads', async (request, reply) => {
    if (!authenticate(request, reply)) return;
    try {
      const result = await adapter.request('thread/start', { cwd: options.workspace });
      const thread = result.thread as JsonObject | undefined;
      if (typeof thread?.id === 'string') sessions.add(thread.id);
      return reply.code(201).send(result);
    } catch (error) {
      return upstreamError(reply, error);
    }
  });

  app.get('/api/threads/:threadId', async (request, reply) => {
    if (!authenticate(request, reply)) return;
    const { threadId } = request.params as { threadId: string };
    if (!sessions.has(threadId)) return reply.code(404).send({ code: 'not_found', message: 'Thread is not available in this workspace.' });
    try {
      return await adapter.request('thread/read', { threadId, includeTurns: true });
    } catch (error) {
      return upstreamError(reply, error);
    }
  });

  app.post('/api/threads/:threadId/resume', async (request, reply) => {
    if (!authenticate(request, reply)) return;
    const { threadId } = request.params as { threadId: string };
    if (!sessions.has(threadId)) return reply.code(404).send({ code: 'not_found', message: 'Thread is not available in this workspace.' });
    try {
      const result = await adapter.request('thread/resume', { threadId, cwd: options.workspace });
      sessions.add(threadId);
      return result;
    } catch (error) {
      return upstreamError(reply, error);
    }
  });

  app.post('/api/threads/:threadId/turns', async (request, reply) => {
    if (!authenticate(request, reply)) return;
    const { threadId } = request.params as { threadId: string };
    if (!sessions.has(threadId)) return reply.code(404).send({ code: 'not_found', message: 'Thread is not available in this workspace.' });
    const body = request.body as { text?: unknown; clientRequestId?: unknown };
    if (typeof body?.text !== 'string' || body.text.trim() === '') {
      return reply.code(400).send({ code: 'invalid_request', message: 'text is required.' });
    }
    if (body.text.length > 100_000) return reply.code(413).send({ code: 'too_large', message: 'Message exceeds 100,000 characters.' });
    if (typeof body.clientRequestId !== 'string' || body.clientRequestId.length < 1 || body.clientRequestId.length > 128) {
      return reply.code(400).send({ code: 'invalid_request', message: 'clientRequestId is required.' });
    }
    const requestKey = `${threadId}:${body.clientRequestId}`;
    const payloadHash = createHash('sha256').update(body.text).digest('hex');
    const prior = submittedRequests.get(requestKey);
    if (prior) {
      if (prior.payloadHash !== payloadHash) return reply.code(409).send({ code: 'request_conflict', message: 'clientRequestId has already been used with different content.' });
      if (!prior.response) return reply.code(409).send({ code: 'request_in_progress', message: 'The original request is still being submitted.' });
      return reply.code(202).send(prior.response);
    }
    if (activeTurns.has(threadId)) return reply.code(409).send({ code: 'turn_in_progress', message: 'A turn is already running for this thread.', turnId: activeTurns.get(threadId) });
    submittedRequests.set(requestKey, { threadId, payloadHash });
    try {
      const result = await adapter.request('turn/start', {
        threadId,
        clientUserMessageId: body.clientRequestId,
        input: [{ type: 'text', text: body.text }]
      });
      submittedRequests.set(requestKey, { threadId, payloadHash, response: result });
      const turn = result.turn;
      if (isJsonObject(turn) && typeof turn.id === 'string') activeTurns.set(threadId, turn.id);
      return reply.code(202).send(result);
    } catch (error) {
      submittedRequests.delete(requestKey);
      return upstreamError(reply, error);
    }
  });

  app.post('/api/threads/:threadId/interrupt', async (request, reply) => {
    if (!authenticate(request, reply)) return;
    const { threadId } = request.params as { threadId: string };
    if (!sessions.has(threadId)) return reply.code(404).send({ code: 'not_found', message: 'Thread is not available in this workspace.' });
    const body = request.body as { turnId?: unknown };
    if (typeof body?.turnId !== 'string') return reply.code(400).send({ code: 'invalid_request', message: 'turnId is required.' });
    try {
      return await adapter.request('turn/interrupt', { threadId, turnId: body.turnId });
    } catch (error) {
      return upstreamError(reply, error);
    }
  });

  app.post('/api/interactions/:interactionId/resolve', async (request, reply) => {
    if (!authenticate(request, reply)) return;
    const { interactionId } = request.params as { interactionId: string };
    const interaction = interactions.get(interactionId);
    if (!interaction) return reply.code(409).send({ code: 'resolved_or_expired', message: 'This interaction has already been resolved.' });
    const body = request.body as { result?: unknown };
    if (!isJsonObject(body?.result)) return reply.code(400).send({ code: 'invalid_request', message: 'result must be an object.' });
    if (!isValidInteractionResult(interaction.method, body.result)) {
      return reply.code(400).send({ code: 'invalid_request', message: 'The response does not match this interaction type.' });
    }
    try {
      adapter.respond(interaction.upstreamRequestId, body.result);
      interactions.delete(interactionId);
      emit('interaction.submitted', { id: interactionId }, interaction.threadId);
      return reply.code(202).send({ ok: true });
    } catch (error) {
      return upstreamError(reply, error);
    }
  });

  const socketServer = new WebSocketServer({ noServer: true });
  socketServer.on('connection', (socket, request) => {
    const target = new URL(request.url ?? '/', 'http://127.0.0.1');
    const replay = eventBuffer.replay(cursorFrom(target));
    clients.add(socket);
    const snapshot: WebEvent = {
      protocolVersion: 1,
      type: 'snapshot',
      epoch,
      seq,
      kind: 'snapshot',
      payload: {
        connection: adapter.isAvailable ? 'ready' : 'unavailable',
        activeTurns: Object.fromEntries(activeTurns),
        pendingInteractions: [...interactions.values()],
        resync: replay.resync,
        events: replay.events
      }
    };
    socket.send(JSON.stringify(snapshot));
    socket.on('close', () => clients.delete(socket));
  });

  app.server.on('upgrade', (request, socket, head) => {
    const target = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (target.pathname !== '/api/events') return;
    const rawCookie = request.headers.cookie ?? '';
    if (!rawCookie.split(';').some((part) => part.trim() === `${SESSION_COOKIE}=${bootstrapToken}`)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    socketServer.handleUpgrade(request, socket, head, (ws) => socketServer.emit('connection', ws, request));
  });

  const publicDir = options.publicDir ?? fileURLToPath(new URL('../public/', import.meta.url));
  if (existsSync(publicDir)) {
    await app.register(fastifyStatic, { root: publicDir, wildcard: false });
    app.get('/*', async (request, reply) => {
      if (request.url.startsWith(API_PREFIX)) return reply.code(404).send({ code: 'not_found' });
      return reply.sendFile('index.html', { maxAge: 0, immutable: false });
    });
  }

  return {
    app,
    bootstrapToken,
    async close() {
      for (const client of clients) client.close();
      socketServer.close();
      await adapter.stop();
      await app.close();
    }
  };
}

function threadList(result: JsonObject): Array<{ id: string }> {
  const data = Array.isArray(result.data) ? result.data : [];
  return data.filter((thread): thread is { id: string } => isJsonObject(thread) && typeof thread.id === 'string');
}

function cursorFrom(target: URL): EventCursor | undefined {
  const epoch = target.searchParams.get('epoch');
  const rawSeq = target.searchParams.get('seq');
  if (!epoch || rawSeq === null || !/^\d+$/.test(rawSeq)) return undefined;
  const seq = Number(rawSeq);
  return Number.isSafeInteger(seq) ? { epoch, seq } : undefined;
}

function sameToken(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isValidInteractionResult(method: string, result: JsonObject): boolean {
  if (method === 'item/commandExecution/requestApproval' || method === 'item/fileChange/requestApproval') {
    return result.decision === 'accept' || result.decision === 'acceptForSession' || result.decision === 'decline' || result.decision === 'cancel';
  }
  if (method === 'item/permissions/requestApproval') {
    return isJsonObject(result.permissions) && (result.scope === 'turn' || result.scope === 'session');
  }
  if (method === 'item/tool/requestUserInput') {
    return isJsonObject(result.answers) && Object.values(result.answers).every((answer) => isJsonObject(answer) && Array.isArray(answer.answers) && answer.answers.every((item) => typeof item === 'string'));
  }
  if (method === 'mcpServer/elicitation/request') {
    return (result.action === 'accept' || result.action === 'decline' || result.action === 'cancel') && ('content' in result);
  }
  return false;
}

function upstreamError(reply: { code(statusCode: number): { send(value: unknown): unknown } }, error: unknown): unknown {
  const message = error instanceof Error ? error.message : 'Unknown Codex error.';
  return reply.code(error instanceof CodexUnavailableError ? 503 : 502).send({ code: 'codex_unavailable', message });
}
