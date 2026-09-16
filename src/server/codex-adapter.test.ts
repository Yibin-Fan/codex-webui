import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { CodexAdapter } from './codex-adapter.js';

test('initializes over a child-process JSONL transport and routes both directions', async () => {
  const fixture = fileURLToPath(new URL('./fixtures/fake-app-server.mjs', import.meta.url));
  const adapter = new CodexAdapter({ command: process.execPath, commandArgs: [fixture], requestTimeoutMs: 2_000 });
  try {
    const approval = once(adapter, 'serverRequest') as Promise<[ { id: number; method: string } ]>;
    await adapter.start();
    const list = await adapter.request('thread/list', { cwd: '/workspace' });
    assert.deepEqual(list, { data: [] });
    const [request] = await approval;
    assert.equal(request.id, 90);
    assert.equal(request.method, 'item/commandExecution/requestApproval');

    const received = once(adapter, 'notification') as Promise<[ { method: string } ]>;
    adapter.respond(90, { decision: 'decline' });
    const [notification] = await received;
    assert.equal(notification.method, 'test/approvalReceived');
  } finally {
    await adapter.stop();
  }
});
