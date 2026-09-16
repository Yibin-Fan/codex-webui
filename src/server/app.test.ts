import assert from 'node:assert/strict';
import test from 'node:test';
import { CodexAdapter } from './codex-adapter.js';
import { createWebUi } from './app.js';
import type { JsonObject } from './types.js';

class FakeAdapter extends CodexAdapter {
  responses: Array<{ id: string | number; result: JsonObject }> = [];

  override async request(method: string): Promise<JsonObject> {
    if (method === 'thread/list') return { data: [] };
    return {};
  }

  override respond(id: string | number, result: JsonObject): void {
    this.responses.push({ id, result });
  }
}

test('requires bootstrap authentication and only accepts a matching command approval response', async () => {
  const adapter = new FakeAdapter();
  const events: Array<{ kind: string; payload: unknown }> = [];
  const webUi = await createWebUi({ workspace: '/workspace', bootstrapToken: 'test-bootstrap-token', adapter, onEvent: (event) => events.push(event) });
  try {
    const unauthorized = await webUi.app.inject({ method: 'GET', url: '/api/status' });
    assert.equal(unauthorized.statusCode, 401);

    const bootstrap = await webUi.app.inject({ method: 'POST', url: '/api/auth/bootstrap', headers: { 'x-bootstrap-token': 'test-bootstrap-token' } });
    assert.equal(bootstrap.statusCode, 200);
    const setCookie = bootstrap.headers['set-cookie'];
    const cookie = (Array.isArray(setCookie) ? setCookie[0] : setCookie)?.split(';')[0];
    assert.ok(cookie);

    adapter.emit('serverRequest', {
      id: 7,
      method: 'item/commandExecution/requestApproval',
      params: { threadId: 'thr_1', turnId: 'turn_1', command: 'pwd' }
    });
    const interaction = events.find((event) => event.kind === 'interaction.requested')?.payload as { id: string } | undefined;
    assert.ok(interaction?.id);
    const stale = await webUi.app.inject({ method: 'POST', url: '/api/interactions/not-an-id/resolve', headers: { cookie }, payload: { result: { decision: 'accept' } } });
    assert.equal(stale.statusCode, 409);
    assert.equal(adapter.responses.length, 0);

    const invalid = await webUi.app.inject({ method: 'POST', url: `/api/interactions/${interaction.id}/resolve`, headers: { cookie }, payload: { result: { permissions: {}, scope: 'turn' } } });
    assert.equal(invalid.statusCode, 400);

    const resolved = await webUi.app.inject({ method: 'POST', url: `/api/interactions/${interaction.id}/resolve`, headers: { cookie }, payload: { result: { decision: 'decline' } } });
    assert.equal(resolved.statusCode, 202);
    assert.deepEqual(adapter.responses, [{ id: 7, result: { decision: 'decline' } }]);
  } finally {
    await webUi.close();
  }
});
