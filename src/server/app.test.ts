import assert from 'node:assert/strict';
import test from 'node:test';
import { CodexAdapter } from './codex-adapter.js';
import { createWebUi } from './app.js';
import type { JsonObject } from './types.js';

class FakeAdapter extends CodexAdapter {
  responses: Array<{ id: string | number; result: JsonObject }> = [];
  calls: string[] = [];

  override async request(method: string): Promise<JsonObject> {
    this.calls.push(method);
    if (method === 'thread/list') return { data: [{ id: 'thr_1', cwd: '/workspace' }] };
    if (method === 'turn/start') return { turn: { id: 'turn_1' } };
    return {};
  }

  override respond(id: string | number, result: JsonObject): void {
    this.responses.push({ id, result });
  }
}

const localHeaders = { host: '127.0.0.1:4317', origin: 'http://127.0.0.1:4317' };

async function bootstrapSession(webUi: Awaited<ReturnType<typeof createWebUi>>): Promise<{ cookie: string; csrfToken: string }> {
  const bootstrap = await webUi.app.inject({ method: 'POST', url: '/api/auth/bootstrap', headers: { ...localHeaders, 'x-bootstrap-token': 'test-bootstrap-token' } });
  assert.equal(bootstrap.statusCode, 200);
  const cookies = (Array.isArray(bootstrap.headers['set-cookie']) ? bootstrap.headers['set-cookie'] : [bootstrap.headers['set-cookie']]).filter((cookie): cookie is string => typeof cookie === 'string');
  const session = cookies.find((cookie) => cookie.startsWith('codex_webui_session='))?.split(';')[0];
  const csrf = cookies.find((cookie) => cookie.startsWith('codex_webui_csrf='))?.split(';')[0];
  assert.ok(session);
  assert.ok(csrf);
  return { cookie: `${session}; ${csrf}`, csrfToken: csrf.slice('codex_webui_csrf='.length) };
}

function mutationHeaders(session: { cookie: string; csrfToken: string }) {
  return { ...localHeaders, cookie: session.cookie, 'x-csrf-token': session.csrfToken };
}

test('requires bootstrap authentication, a same-origin CSRF token, and a matching command approval response', async () => {
  const adapter = new FakeAdapter();
  const events: Array<{ kind: string; payload: unknown }> = [];
  const webUi = await createWebUi({ workspace: '/workspace', bootstrapToken: 'test-bootstrap-token', adapter, onEvent: (event) => events.push(event) });
  try {
    const unauthorized = await webUi.app.inject({ method: 'GET', url: '/api/status' });
    assert.equal(unauthorized.statusCode, 401);

    const rejectedBootstrap = await webUi.app.inject({ method: 'POST', url: '/api/auth/bootstrap', headers: { host: '127.0.0.1:4317', origin: 'http://example.test', 'x-bootstrap-token': 'test-bootstrap-token' } });
    assert.equal(rejectedBootstrap.statusCode, 401);
    const session = await bootstrapSession(webUi);
    const repeatedBootstrap = await webUi.app.inject({ method: 'POST', url: '/api/auth/bootstrap', headers: { ...localHeaders, 'x-bootstrap-token': 'test-bootstrap-token' } });
    assert.equal(repeatedBootstrap.statusCode, 401);

    adapter.emit('serverRequest', {
      id: 7,
      method: 'item/commandExecution/requestApproval',
      params: { threadId: 'thr_1', turnId: 'turn_1', command: 'pwd' }
    });
    const interaction = events.find((event) => event.kind === 'interaction.requested')?.payload as { id: string } | undefined;
    assert.ok(interaction?.id);
    const missingCsrf = await webUi.app.inject({ method: 'POST', url: `/api/interactions/${interaction.id}/resolve`, headers: { ...localHeaders, cookie: session.cookie }, payload: { result: { decision: 'accept' } } });
    assert.equal(missingCsrf.statusCode, 403);
    const stale = await webUi.app.inject({ method: 'POST', url: '/api/interactions/not-an-id/resolve', headers: mutationHeaders(session), payload: { result: { decision: 'accept' } } });
    assert.equal(stale.statusCode, 409);
    assert.equal(adapter.responses.length, 0);

    const invalid = await webUi.app.inject({ method: 'POST', url: `/api/interactions/${interaction.id}/resolve`, headers: mutationHeaders(session), payload: { result: { permissions: {}, scope: 'turn' } } });
    assert.equal(invalid.statusCode, 400);

    const resolved = await webUi.app.inject({ method: 'POST', url: `/api/interactions/${interaction.id}/resolve`, headers: mutationHeaders(session), payload: { result: { decision: 'decline' } } });
    assert.equal(resolved.statusCode, 202);
    assert.deepEqual(adapter.responses, [{ id: 7, result: { decision: 'decline' } }]);
  } finally {
    await webUi.close();
  }
});

test('requires history threads to be resumed before turns and de-duplicates a completed submission', async () => {
  const adapter = new FakeAdapter();
  const webUi = await createWebUi({ workspace: '/workspace', bootstrapToken: 'test-bootstrap-token', adapter });
  try {
    const session = await bootstrapSession(webUi);

    const unknown = await webUi.app.inject({ method: 'GET', url: '/api/threads/other-thread', headers: { ...localHeaders, cookie: session.cookie } });
    assert.equal(unknown.statusCode, 404);
    assert.equal(adapter.calls.length, 0);

    const listed = await webUi.app.inject({ method: 'GET', url: '/api/threads', headers: { ...localHeaders, cookie: session.cookie } });
    assert.equal(listed.statusCode, 200);

    const payload = { text: 'Summarize this repository', clientRequestId: 'client-request-1' };
    const notResumed = await webUi.app.inject({ method: 'POST', url: '/api/threads/thr_1/turns', headers: mutationHeaders(session), payload });
    assert.equal(notResumed.statusCode, 409);
    assert.equal(adapter.calls.filter((method) => method === 'turn/start').length, 0);

    const resumed = await webUi.app.inject({ method: 'POST', url: '/api/threads/thr_1/resume', headers: mutationHeaders(session), payload: {} });
    assert.equal(resumed.statusCode, 200);
    assert.ok(adapter.calls.includes('thread/resume'));

    const rejectedOrigin = await webUi.app.inject({ method: 'POST', url: '/api/threads/thr_1/turns', headers: { ...mutationHeaders(session), origin: 'http://example.test' }, payload });
    assert.equal(rejectedOrigin.statusCode, 403);
    const first = await webUi.app.inject({ method: 'POST', url: '/api/threads/thr_1/turns', headers: mutationHeaders(session), payload });
    assert.equal(first.statusCode, 202);
    const repeated = await webUi.app.inject({ method: 'POST', url: '/api/threads/thr_1/turns', headers: mutationHeaders(session), payload });
    assert.equal(repeated.statusCode, 202);
    assert.equal(adapter.calls.filter((method) => method === 'turn/start').length, 1);

    const changed = await webUi.app.inject({ method: 'POST', url: '/api/threads/thr_1/turns', headers: mutationHeaders(session), payload: { ...payload, text: 'Different text' } });
    assert.equal(changed.statusCode, 409);
  } finally {
    await webUi.close();
  }
});
