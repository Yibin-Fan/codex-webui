import assert from 'node:assert/strict';
import test from 'node:test';
import { emptyToolProjection, projectToolEvent } from './tool-projection.js';

test('combines command item lifecycle output and preserves its final item state', () => {
  let state = emptyToolProjection();
  state = projectToolEvent(state, { kind: 'codex.item/started', payload: { threadId: 'thr_1', turnId: 'turn_1', item: { id: 'item_1', type: 'commandExecution', command: 'npm test', cwd: '/repo', status: 'inProgress', aggregatedOutput: null } } });
  state = projectToolEvent(state, { kind: 'codex.item/commandExecution/outputDelta', payload: { threadId: 'thr_1', turnId: 'turn_1', itemId: 'item_1', delta: 'pass\n' } });
  state = projectToolEvent(state, { kind: 'codex.item/completed', payload: { threadId: 'thr_1', turnId: 'turn_1', item: { id: 'item_1', type: 'commandExecution', command: 'npm test', cwd: '/repo', status: 'completed', aggregatedOutput: 'pass\n', exitCode: 0 } } });
  assert.deepEqual(state.items.item_1, { id: 'item_1', type: 'commandExecution', threadId: 'thr_1', turnId: 'turn_1', command: 'npm test', cwd: '/repo', status: 'completed', aggregatedOutput: 'pass\n', exitCode: 0, output: 'pass\n' });
});

test('keeps the latest turn diff and associates file patch updates with an item', () => {
  let state = emptyToolProjection();
  state = projectToolEvent(state, { kind: 'codex.item/fileChange/patchUpdated', payload: { threadId: 'thr_1', turnId: 'turn_1', itemId: 'item_2', changes: [{ path: 'src/app.ts', kind: 'update' }] } });
  state = projectToolEvent(state, { kind: 'codex.turn/diff/updated', payload: { threadId: 'thr_1', turnId: 'turn_1', diff: 'diff --git a/src/app.ts b/src/app.ts' } });
  assert.equal(state.items.item_2.type, 'fileChange');
  assert.equal(state.items.item_2.changes?.length, 1);
  assert.equal(state.diffs['thr_1:turn_1'], 'diff --git a/src/app.ts b/src/app.ts');
});
