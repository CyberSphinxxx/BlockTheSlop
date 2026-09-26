/**
 * DATA-15 + N07: the background is a security boundary. Every message is
 * validated BEFORE dispatch:
 *
 * 1. Structural pre-check (any sender): request shape, bounded type string,
 *    serializable payload under a hard size cap.
 * 2. Per-type payload validation against a bounded schema table.
 * 3. Sender-role separation: content scripts may only invoke a small,
 *    content-safe subset; options/popup (extension pages) may invoke
 *    everything. Validation is synchronous and allocation-bounded.
 *
 * A rejected message returns `{ error }` — never a silent success.
 */

export const MAX_MESSAGE_JSON = 512_000;

/** Maximum entries accepted in a list payload (bulk delete, import merge). */
export const MAX_LIST_LENGTH = 1_000;

export interface MessageRequestShape {
  type?: unknown;
  payload?: undefined | Record<string, unknown> | null;
}

export type MessageRole = 'content' | 'page';

/** Message types a content script may invoke (content-safe subset). */
export const CONTENT_ALLOWED_TYPES: ReadonlySet<string> = new Set([
  'history:record',
  'correction:get',
  // N08: batched classification cache (raw inputs only; background derives keys).
  'classification:getMany',
  'classification:putMany',
  'tabs:rescanAll',
  // V6-11: day-bucketed observations (content scripts report outcomes).
  'stats:dailyRecord',
  // V7-07: local miss-review diagnostics (content scripts report pipeline outcomes).
  'miss-review:record',
]);

const MAX_ID = 128;
const MAX_TITLE = 512;
const MAX_SURFACE_LENGTH = 32;

/** V6-03: optional local-only discovery-source answers (onboarding). */
const DISCOVERY_SOURCES: ReadonlySet<string> = new Set([
  'facebook',
  'tiktok',
  'friend',
  'reddit',
  'chrome-web-store',
  'other',
  'prefer-not-to-say',
]);

/** N08: batched classification-cache round-trip size (content → background). */
const MAX_CACHE_BATCH = 100;
const MAX_CACHE_DESCRIPTION = 2048;
const MAX_CACHE_LIST_ITEM = 256;
const MAX_CACHE_LIST = 12;
const MAX_CACHE_LOCALE = 32;

/**
 * N08: one raw evidence input for the batched classification cache. Raw
 * inputs only — the background derives fingerprints (key derivation never
 * comes from the content side).
 */
function validRawCacheInput(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (!optString(value['videoId'], 64)) return false;
  if (!reqString(value['title'], MAX_TITLE)) return false;
  if (!optString(value['description'], MAX_CACHE_DESCRIPTION)) return false;
  for (const field of ['badges', 'ariaLabels', 'metadataText'] as const) {
    const list = value[field];
    if (!Array.isArray(list) || list.length > MAX_CACHE_LIST) return false;
    if (!list.every((item) => typeof item === 'string' && item.length <= MAX_CACHE_LIST_ITEM)) {
      return false;
    }
  }
  if (typeof value['officialDisclosurePresent'] !== 'boolean') return false;
  if (typeof value['isShort'] !== 'boolean') return false;
  // Locale may be legitimately empty/unknown (missing <html lang> on a
  // hostile or minimal page) — it is part of the fingerprint either way.
  if (!optString(value['locale'], MAX_CACHE_LOCALE)) return false;
  return true;
}

function validCacheBatch(value: unknown): boolean {
  return Array.isArray(value) && value.length > 0 && value.length <= MAX_CACHE_BATCH;
}

const SURFACES: ReadonlySet<string> = new Set([
  'home',
  'search',
  'subscriptions',
  'watch-sidebar',
  'channel',
  'playlist',
  'history',
  'watch-later',
  'shorts-shelf',
  'shorts-feed',
  'unknown',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function optString(value: unknown, max: number): boolean {
  return value === undefined || (typeof value === 'string' && value.length <= max);
}

function reqString(value: unknown, max: number): boolean {
  return typeof value === 'string' && value.length > 0 && value.length <= max;
}

/** Per-type payload schemas. Every payload is a record (or absent). */
const PAYLOAD_VALIDATORS: Readonly<Record<string, (payload: unknown) => boolean>> = {
  'settings:get': absent,
  'rules:get': absent,
  'stats:get': absent,
  'history:count': absent,
  'diagnostics:quarantine': absent,
  'history:clear': absent,
  'data:clear-cache': absent,
  'data:clear-corrections': absent,
  'data:reset-stats': absent,

  'review:list': absent,

  'history:query': (p) => {
    if (!isRecord(p)) return false;
    if (typeof p['page'] !== 'number' || !Number.isInteger(p['page']) || p['page'] < 1)
      return false;
    if (p['page'] > 1_000_000) return false;
    if (typeof p['pageSize'] !== 'number' || ![10, 25, 50, 100].includes(p['pageSize'] as number)) {
      return false;
    }
    if (!optString(p['search'], 256)) return false;
    const status = p['status'];
    if (
      status !== undefined &&
      status !== 'all' &&
      !['pending', 'restored', 'corrected', 'allowed'].includes(status as string)
    ) {
      return false;
    }
    if (
      p['surface'] !== undefined &&
      p['surface'] !== 'all' &&
      !SURFACES.has(p['surface'] as string)
    ) {
      return false;
    }
    if (
      !optNumber(p['from']) ||
      !optNumber(p['to']) ||
      (typeof p['from'] === 'number' && typeof p['to'] === 'number' && p['from'] > p['to'])
    ) {
      return false;
    }
    const sort = p['sort'];
    if (
      sort !== undefined &&
      !['lastSeen-desc', 'lastSeen-asc', 'title-asc', 'count-desc'].includes(sort as string)
    ) {
      return false;
    }
    return true;
  },

  'history:restore': boundedRecord({ key: (v) => reqString(v, MAX_ID) }),
  'history:events': (p) => {
    if (!isRecord(p)) return false;
    if (!reqString(p['key'], MAX_ID)) return false;
    if (
      p['limit'] !== undefined &&
      (typeof p['limit'] !== 'number' || p['limit'] < 1 || p['limit'] > 100)
    ) {
      return false;
    }
    return true;
  },
  'history:delete': (p) => {
    if (!isRecord(p)) return false;
    const keys = p['keys'];
    if (!Array.isArray(keys) || keys.length === 0 || keys.length > MAX_LIST_LENGTH) return false;
    return keys.every((k) => reqString(k, MAX_ID));
  },
  'history:getMany': (p) => {
    if (!isRecord(p)) return false;
    const keys = p['keys'];
    if (!Array.isArray(keys) || keys.length === 0 || keys.length > MAX_LIST_LENGTH) return false;
    return keys.every((k) => reqString(k, MAX_ID));
  },
  'history:putMany': (p) => {
    if (!isRecord(p)) return false;
    const summaries = p['summaries'];
    if (!Array.isArray(summaries) || summaries.length === 0 || summaries.length > MAX_LIST_LENGTH) {
      return false;
    }
    // Structural depth is bounded here; full row validation (validateSummary)
    // happens in the repository, which skips invalid rows.
    return summaries.every((row) => isRecord(row) && reqString(row['key'], 256));
  },
  'history:record': (p) => {
    if (!isRecord(p)) return false;
    if (!optString(p['videoId'], 64)) return false;
    if (!reqString(p['title'], MAX_TITLE)) return false;
    if (!optString(p['channelId'], 64)) return false;
    if (!optString(p['channelName'], 256)) return false;
    if (!optString(p['handle'], 128)) return false;
    if (!reqString(p['surface'], MAX_SURFACE_LENGTH) || !SURFACES.has(p['surface'] as string)) {
      return false;
    }
    if (typeof p['occurredAt'] !== 'number' || !Number.isFinite(p['occurredAt'])) return false;
    if (!reqString(p['operationId'], 256)) return false;
    if (!reqString(p['sessionKey'], 256)) return false;
    const decision = p['decision'];
    if (!isRecord(decision)) return false;
    if (!['allow', 'warn', 'hide'].includes(decision['action'] as string)) return false;
    if (typeof decision['reason'] !== 'string' || (decision['reason'] as string).length > 32) {
      return false;
    }
    if (decision['explanation'] !== undefined) {
      const explanation = decision['explanation'];
      if (!Array.isArray(explanation) || explanation.length > 12) return false;
      if (!explanation.every((line) => typeof line === 'string' && line.length <= MAX_TITLE)) {
        return false;
      }
    }
    return true;
  },
  'classification:getMany': (p) => {
    if (!isRecord(p)) return false;
    const inputs = p['inputs'];
    if (!validCacheBatch(inputs)) return false;
    return (inputs as unknown[]).every(validRawCacheInput);
  },
  'classification:putMany': (p) => {
    if (!isRecord(p)) return false;
    const inputs = p['inputs'];
    if (!validCacheBatch(inputs)) return false;
    if (!validCacheBatch(p['classifications'])) return false;
    if ((inputs as unknown[]).length !== (p['classifications'] as unknown[]).length) return false;
    // Structural bounding only; semantic validation happens at the service.
    return (p['classifications'] as unknown[]).every(
      (c) => isRecord(c) && typeof c['aiLikelihood'] === 'number',
    );
  },
  'correction:get': boundedRecord({ videoId: (v) => reqString(v, 64) }),
  'correction:set': (p) => {
    if (!isRecord(p)) return false;
    if (!reqString(p['videoId'], 64)) return false;
    if (!['notAi', 'notSlop'].includes(p['dimension'] as string)) return false;
    if (typeof p['value'] !== 'boolean') return false;
    return true;
  },
  'tabs:rescanAll': (p) => absent(p) || isRecord(p),

  // V6-02/03/07: onboarding completion is recorded by the background so the
  // durable state lives in exactly one place. The optional discovery answer
  // is LOCAL-ONLY metadata; it is stored, never transmitted anywhere.
  'onboarding:complete': (p) => {
    if (absent(p)) return true;
    if (!isRecord(p)) return false;
    if (p['discoverySource'] === undefined) return true;
    return (
      typeof p['discoverySource'] === 'string' &&
      DISCOVERY_SOURCES.has(p['discoverySource'] as string)
    );
  },
  'onboarding:get': absent,

  // V6-11: day-bucketed stats observations from content scripts (bounded).
  'stats:dailyRecord': (p) => {
    if (!isRecord(p)) return false;
    // Audit A3: content scripts may report restore outcomes too.
    if (!['hide', 'warn', 'restore'].includes(p['outcome'] as string)) return false;
    if (!optString(p['videoId'], 64)) return false;
    if (!reqString(p['signature'], 128)) return false;
    if (typeof p['observedAt'] !== 'number' || !Number.isFinite(p['observedAt'])) return false;
    return true;
  },
  'stats:dailyGet': absent,
  'stats:dailyReset': absent,
  // V7-07: local miss-review diagnostics. Bounded text fields; the reason
  // code set is enforced here so junk can never enter the durable queue.
  'miss-review:record': (p) => {
    if (!isRecord(p)) return false;
    if (!optString(p['videoId'], 64)) return false;
    if (!reqString(p['title'], 512)) return false;
    if (!optString(p['channelName'], 256)) return false;
    if (!reqString(p['surface'], 32)) return false;
    if (
      ![
        'no-evidence',
        'below-threshold',
        'category-warn',
        'explicit-allow',
        'unsupported-surface',
        'unresolved-identity',
        'error',
      ].includes(p['reason'] as string)
    ) {
      return false;
    }
    if (typeof p['seenAt'] !== 'number' || !Number.isFinite(p['seenAt'])) return false;
    if (!optString(p['note'], 160)) return false;
    return true;
  },
};

function absent(payload: unknown): boolean {
  return payload === undefined || payload === null;
}

function boundedRecord(
  fields: Readonly<Record<string, (value: unknown) => boolean>>,
): (payload: unknown) => boolean {
  return (payload) => {
    if (!isRecord(payload)) return false;
    const keys = Object.keys(payload);
    if (keys.length > 16) return false;
    for (const [field, check] of Object.entries(fields)) {
      if (!check(payload[field])) return false;
    }
    return true;
  };
}

function optNumber(value: unknown): boolean {
  return value === undefined || (typeof value === 'number' && Number.isFinite(value));
}

export interface ValidationResult {
  ok: boolean;
  reason?: string;
}

/** Pass 2: per-type payload validation (role-independent). */
export function validatePayload(type: string, payload: unknown): ValidationResult {
  const validator = PAYLOAD_VALIDATORS[type];
  if (validator === undefined) {
    // Unknown types have no schema; the structural check already passed but
    // dispatch must not run arbitrary code paths on unschematized payloads.
    return { ok: false, reason: 'unknown message type' };
  }
  return validator(payload) ? { ok: true } : { ok: false, reason: `invalid payload for ${type}` };
}

/** Pass 1 + 2 combined: structural check, then per-type schema. */
export function validateMessageRequest(request: unknown): ValidationResult {
  const message = request as MessageRequestShape;
  if (typeof message !== 'object' || message === null || typeof message.type !== 'string') {
    return { ok: false, reason: 'malformed message' };
  }
  if (message.type.length > 64 || message.type.includes('\u0000')) {
    return { ok: false, reason: 'malformed message type' };
  }
  if (
    message.payload !== undefined &&
    message.payload !== null &&
    (!isRecord(message.payload) || Array.isArray(message.payload))
  ) {
    return { ok: false, reason: 'payload must be an object' };
  }
  if (message.payload !== undefined && message.payload !== null) {
    try {
      const size = JSON.stringify(message.payload).length;
      if (size > MAX_MESSAGE_JSON) {
        return { ok: false, reason: 'payload too large' };
      }
    } catch {
      return { ok: false, reason: 'payload not serializable' };
    }
  }
  const typed = message.type;
  const payload = message.payload as unknown;
  return validatePayload(typed, payload);
}

/** Pass 3: sender-role separation (checked in the background listener). */
export function roleMayInvoke(role: MessageRole, type: string): boolean {
  return role === 'page' || CONTENT_ALLOWED_TYPES.has(type);
}
