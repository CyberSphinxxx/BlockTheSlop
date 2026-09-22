/**
 * DATA-15: structural pre-dispatch validation for background messages.
 * Extracted from the service worker so it is unit-testable without the
 * `browser` global (which only exists in real extension contexts).
 */

export const MAX_MESSAGE_JSON = 512_000;

export interface MessageRequestShape {
  type?: unknown;
  payload?: unknown;
}

/** Structural pre-dispatch validation (reject-before-handle). */
export function validateMessageRequest(request: unknown): {
  ok: boolean;
  reason?: string;
} {
  const message = request as MessageRequestShape;
  if (typeof message !== 'object' || message === null || typeof message.type !== 'string') {
    return { ok: false, reason: 'malformed message' };
  }
  if (message.type.length > 64 || message.type.includes('\u0000')) {
    return { ok: false, reason: 'malformed message type' };
  }
  if (message.payload !== undefined) {
    try {
      const size = JSON.stringify(message.payload).length;
      if (size > MAX_MESSAGE_JSON) {
        return { ok: false, reason: 'payload too large' };
      }
    } catch {
      return { ok: false, reason: 'payload not serializable' };
    }
  }
  return { ok: true };
}
