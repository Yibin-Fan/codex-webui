import assert from 'node:assert/strict';
import test from 'node:test';
import { EventBuffer } from './event-buffer.js';
import type { WebEvent } from './types.js';

function event(epoch: string, seq: number): WebEvent {
  return { protocolVersion: 1, type: 'event', epoch, seq, kind: 'codex.item/started', payload: {} };
}

test('replays only events after a continuous cursor', () => {
  const buffer = new EventBuffer(3);
  buffer.append(event('epoch-a', 1));
  buffer.append(event('epoch-a', 2));
  buffer.append(event('epoch-a', 3));

  assert.deepEqual(buffer.replay({ epoch: 'epoch-a', seq: 1 }), {
    resync: false,
    events: [event('epoch-a', 2), event('epoch-a', 3)]
  });
});

test('requires a full rebuild for missing, stale, or trimmed cursors', () => {
  const buffer = new EventBuffer(2);
  buffer.append(event('epoch-a', 1));
  buffer.append(event('epoch-a', 2));
  buffer.append(event('epoch-a', 3));

  assert.equal(buffer.replay().resync, true);
  assert.equal(buffer.replay({ epoch: 'epoch-b', seq: 2 }).resync, true);
  assert.deepEqual(buffer.replay({ epoch: 'epoch-a', seq: 0 }), {
    resync: true,
    events: [event('epoch-a', 2), event('epoch-a', 3)]
  });
});
