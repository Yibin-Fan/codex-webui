import assert from 'node:assert/strict';
import test from 'node:test';
import { JsonLineDecoder } from './line-decoder.js';

test('decodes JSONL split across arbitrary stream chunks', () => {
  const decoder = new JsonLineDecoder<{ id: number }>();
  assert.deepEqual(decoder.push('{"id":1}\n{"'), [{ id: 1 }]);
  assert.deepEqual(decoder.push('id":2}\r\n'), [{ id: 2 }]);
  assert.deepEqual(decoder.finish(), []);
});

test('returns an unterminated final JSON message during finish', () => {
  const decoder = new JsonLineDecoder<{ ok: boolean }>();
  decoder.push('{"ok"');
  decoder.push(':true}');
  assert.deepEqual(decoder.finish(), [{ ok: true }]);
});
