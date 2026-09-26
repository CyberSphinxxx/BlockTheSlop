import { describe, expect, it } from 'vitest';
import {
  CONTENT_ALLOWED_TYPES,
  MAX_MESSAGE_JSON,
  roleMayInvoke,
  validateMessageRequest,
  validatePayload,
} from '@/background/message-validation';

/**
 * N07 — Message boundary.
 *
 * Every message type is validated against a bounded schema; unknown types are
 * rejected; content-script capabilities are separated from options/popup
 * capabilities; malformed/malicious/oversized payloads never reach a handler;
 * rejections always return a visible `{ error }` (no silent success).
 */

const VALID_RECORD_PAYLOAD = {
  videoId: 'abc123',
  title: 'Some title',
  channelId: 'UC0000000000000000000001',
  channelName: 'Channel',
  surface: 'home',
  occurredAt: 1_700_000_000_000,
  operationId: 'op:1',
  sessionKey: 'sess-1',
  decision: { action: 'hide', reason: 'automatic', explanation: ['matched'] },
};

function ok(type: string, payload?: unknown): void {
  expect(validateMessageRequest({ type, payload })).toEqual({ ok: true });
}

function rejected(type: string, payload?: unknown): void {
  const result = validateMessageRequest({ type, payload });
  expect(result.ok, `${type} should reject payload ${JSON.stringify(payload)}`).toBe(false);
}

describe('N07 per-type schema: zero-arg types reject payloads', () => {
  const zeroArg = [
    'settings:get',
    'rules:get',
    'stats:get',
    'history:count',
    'history:clear',
    'diagnostics:quarantine',
    'data:clear-cache',
    'data:clear-corrections',
    'data:reset-stats',
    'review:list',
  ];
  for (const type of zeroArg) {
    it(`${type} accepts absent payload`, () => ok(type));
    it(`${type} rejects any payload`, () => rejected(type, { sneaky: true }));
    it(`${type} is content-restricted`, () => {
      expect(CONTENT_ALLOWED_TYPES.has(type)).toBe(false);
    });
  }
});

describe('N07 history:record schema', () => {
  it('accepts the full valid payload', () => ok('history:record', VALID_RECORD_PAYLOAD));
  it('accepts optional fields absent', () => {
    ok('history:record', {
      title: 't',
      surface: 'home',
      occurredAt: 1,
      operationId: 'op',
      sessionKey: 's',
      decision: { action: 'hide', reason: 'automatic' },
    });
  });
  it('rejects missing/oversized/empty title', () => {
    rejected('history:record', { ...VALID_RECORD_PAYLOAD, title: undefined });
    rejected('history:record', { ...VALID_RECORD_PAYLOAD, title: '' });
    rejected('history:record', { ...VALID_RECORD_PAYLOAD, title: 'x'.repeat(513) });
  });
  it('rejects unknown surface values', () => {
    rejected('history:record', { ...VALID_RECORD_PAYLOAD, surface: 'not-a-surface' });
  });
  it('rejects bad decision shapes', () => {
    rejected('history:record', { ...VALID_RECORD_PAYLOAD, decision: 'hide' });
    rejected('history:record', {
      ...VALID_RECORD_PAYLOAD,
      decision: { action: 'nuke', reason: 'automatic' },
    });
    rejected('history:record', {
      ...VALID_RECORD_PAYLOAD,
      decision: { action: 'hide', reason: 'automatic', explanation: [1, 2, 3] },
    });
    rejected('history:record', {
      ...VALID_RECORD_PAYLOAD,
      decision: { action: 'hide', reason: 'automatic', explanation: new Array(13).fill('x') },
    });
  });
  it('rejects non-finite timestamps and long operation ids', () => {
    rejected('history:record', { ...VALID_RECORD_PAYLOAD, occurredAt: Number.NaN });
    rejected('history:record', { ...VALID_RECORD_PAYLOAD, operationId: 'x'.repeat(257) });
    rejected('history:record', { ...VALID_RECORD_PAYLOAD, sessionKey: '' });
  });
});

describe('N07 history:query schema', () => {
  it('accepts a valid paged query', () =>
    ok('history:query', { page: 2, pageSize: 50, search: 'slop', status: 'pending' }));
  it('rejects bad page/pageSize', () => {
    rejected('history:query', { page: 0, pageSize: 25 });
    rejected('history:query', { page: 1.5, pageSize: 25 });
    rejected('history:query', { page: 1, pageSize: 33 });
    rejected('history:query', { page: 2_000_000, pageSize: 25 });
  });
  it('rejects unknown sort/status/surface enums', () => {
    rejected('history:query', { page: 1, pageSize: 25, sort: 'random' });
    rejected('history:query', { page: 1, pageSize: 25, status: 'expired' });
    rejected('history:query', { page: 1, pageSize: 25, surface: 'browser' });
  });
  it('rejects inverted date ranges', () => {
    rejected('history:query', { page: 1, pageSize: 25, from: 10, to: 5 });
  });
  it('rejects oversized search text', () => {
    rejected('history:query', { page: 1, pageSize: 25, search: 'x'.repeat(257) });
  });
});

describe('N07 list payloads are bounded', () => {
  const key = 'v:abc';
  it('history:delete accepts bounded keys', () => ok('history:delete', { keys: [key, 'v:def'] }));
  it('history:delete rejects empty/oversized/non-string lists', () => {
    rejected('history:delete', { keys: [] });
    rejected('history:delete', { keys: new Array(1_001).fill(key) });
    rejected('history:delete', { keys: [42] });
    rejected('history:delete', { keys: 'v:abc' });
  });
  it('history:getMany mirrors delete bounds', () => {
    ok('history:getMany', { keys: [key] });
    rejected('history:getMany', { keys: [] });
    rejected('history:getMany', { keys: new Array(1_001).fill(key) });
  });
  it('history:putMany rejects rows without keys and oversized batches', () => {
    ok('history:putMany', { summaries: [{ key: 'v:a' }] });
    rejected('history:putMany', { summaries: [{ title: 'no key' }] });
    rejected('history:putMany', { summaries: new Array(1_001).fill({ key: 'v:a' }) });
    rejected('history:putMany', { summaries: 'rows' });
  });
  it('history:events bounds limit and requires key', () => {
    ok('history:events', { key, limit: 20 });
    ok('history:events', { key });
    rejected('history:events', { key, limit: 0 });
    rejected('history:events', { key, limit: 101 });
    rejected('history:events', { limit: 10 });
  });
});

describe('N07 corrections', () => {
  it('correction:get requires a videoId', () => {
    ok('correction:get', { videoId: 'abc' });
    rejected('correction:get', {});
    rejected('correction:get', { videoId: '' });
  });
  it('correction:set validates dimension + boolean value', () => {
    ok('correction:set', { videoId: 'abc', dimension: 'notAi', value: true });
    rejected('correction:set', { videoId: 'abc', dimension: 'probablyAi', value: true });
    rejected('correction:set', { videoId: 'abc', dimension: 'notAi', value: 'yes' });
  });
});

describe('N07 unknown types and malformed requests', () => {
  it('rejects unknown types even with valid-looking payloads', () => {
    rejected('admin:deleteEverything', {});
    rejected('history:exec', { code: 'return 1' });
    rejected('settings:reload', undefined);
  });
  it('rejects malformed envelopes', () => {
    expect(validateMessageRequest(null).ok).toBe(false);
    expect(validateMessageRequest('settings:get').ok).toBe(false);
    expect(validateMessageRequest({}).ok).toBe(false);
    expect(validateMessageRequest({ type: 42 }).ok).toBe(false);
    expect(validateMessageRequest({ type: 'x'.repeat(65) }).ok).toBe(false);
    expect(validateMessageRequest({ type: 'a\u0000b' }).ok).toBe(false);
  });
  it('rejects non-object payloads', () => {
    expect(validateMessageRequest({ type: 'history:query', payload: [1, 2] }).ok).toBe(false);
    expect(validateMessageRequest({ type: 'history:query', payload: 'x' }).ok).toBe(false);
  });
  it('rejects oversized payloads', () => {
    const big = { type: 'history:record', payload: { ...VALID_RECORD_PAYLOAD, title: 'x' } };
    (big.payload as Record<string, unknown>).title = 'x'.repeat(MAX_MESSAGE_JSON);
    expect(validateMessageRequest(big).ok).toBe(false);
  });
  it('rejects circular (non-serializable) payloads', () => {
    const a: Record<string, unknown> = { type: 'history:record' };
    const payload: Record<string, unknown> = {};
    payload['self'] = payload;
    a['payload'] = payload;
    expect(validateMessageRequest(a).ok).toBe(false);
  });
});

describe('N07 sender-role separation', () => {
  it('content scripts may only invoke the content-safe subset', () => {
    for (const type of CONTENT_ALLOWED_TYPES) {
      expect(roleMayInvoke('content', type)).toBe(true);
    }
    expect(roleMayInvoke('content', 'history:clear')).toBe(false);
    expect(roleMayInvoke('content', 'history:delete')).toBe(false);
    expect(roleMayInvoke('content', 'data:reset-stats')).toBe(false);
    expect(roleMayInvoke('content', 'history:putMany')).toBe(false);
    expect(roleMayInvoke('content', 'settings:get')).toBe(false);
  });
  it('extension pages may invoke everything', () => {
    for (const type of [
      'history:clear',
      'history:delete',
      'history:putMany',
      'data:reset-stats',
      'settings:get',
      'history:record',
    ]) {
      expect(roleMayInvoke('page', type)).toBe(true);
    }
  });
  it('content-allowed set matches the content script call sites', () => {
    // The content script sends exactly these types (call-site audit):
    // durable hides, correction reads, N08 batched cache round-trips, V5-06
    // tab rescans, V6-11 day-bucketed stat observations, and V7-07 local
    // miss-review diagnostics.
    expect([...CONTENT_ALLOWED_TYPES].sort()).toEqual([
      'classification:getMany',
      'classification:putMany',
      'correction:get',
      'history:record',
      'miss-review:record',
      'stats:dailyRecord',
      'tabs:rescanAll',
    ]);
  });
});

describe('N07 validatePayload direct', () => {
  it('mirrors envelope validation for known types', () => {
    expect(validatePayload('correction:get', { videoId: 'x' }).ok).toBe(true);
    expect(validatePayload('correction:get', {}).ok).toBe(false);
  });
});
