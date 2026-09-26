import { describe, expect, it } from 'vitest';
import { validateMessageRequest } from '@/background/message-validation';

/**
 * DATA-15: the background rejects fake senders' payloads structurally —
 * destructive commands, oversized messages, and non-serializable payloads
 * never reach a handler.
 */
describe('DATA-15 background message boundary', () => {
  it('accepts a well-formed request', () => {
    expect(validateMessageRequest({ type: 'settings:get' })).toEqual({ ok: true });
    // history:record must satisfy its full per-type schema (N07).
    expect(
      validateMessageRequest({
        type: 'history:record',
        payload: {
          videoId: 'abc123',
          title: 'Some title',
          surface: 'home',
          occurredAt: 1_700_000_000_000,
          operationId: 'op:1',
          sessionKey: 'sess-1',
          decision: { action: 'hide', reason: 'automatic', explanation: ['matched'] },
        },
      }),
    ).toEqual({ ok: true });
  });

  it('rejects malformed requests', () => {
    expect(validateMessageRequest(null).ok).toBe(false);
    expect(validateMessageRequest('settings:get').ok).toBe(false);
    expect(validateMessageRequest({}).ok).toBe(false);
    expect(validateMessageRequest({ type: 42 }).ok).toBe(false);
  });

  it('rejects oversized payloads', () => {
    const big = { type: 'history:query', payload: { blob: 'x'.repeat(600_000) } };
    const result = validateMessageRequest(big);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('payload too large');
  });

  it('rejects non-serializable payloads (circular structures)', () => {
    const payload: Record<string, unknown> = { ok: true };
    payload['self'] = payload;
    const result = validateMessageRequest({ type: 'history:query', payload });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('payload not serializable');
  });

  it('rejects absurdly long or NUL-containing types', () => {
    expect(validateMessageRequest({ type: 'x'.repeat(100) }).ok).toBe(false);
    expect(validateMessageRequest({ type: 'a\u0000b' }).ok).toBe(false);
  });
});
