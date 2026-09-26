/**
 * Bounded evidence fingerprint for the classification cache (R12/04 §4).
 *
 * The cache key is `fingerprint + rule/classifier versions`, NOT videoId:
 * the same video whose title/badges/description hydrate differently must
 * re-run detectors, and a videoId-only key would serve stale evidence.
 * Policy settings are deliberately excluded — changing display mode or
 * thresholds re-evaluates policy without re-running classification.
 */
const FP_VERSION = 'fp1';

/** FNV-1a 32-bit over a bounded string, rendered 8-hex. */
function fnv1a(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/** Bound a string's contribution (evidence must stay bounded, 04 §8). */
function bound(value: string, max = 512): string {
  return value.length <= max ? value : `${value.slice(0, max)}~${value.length}`;
}

export interface FingerprintInput {
  videoId?: string | undefined;
  title: string;
  description?: string | undefined;
  badges: readonly string[];
  ariaLabels: readonly string[];
  metadataText: readonly string[];
  officialDisclosurePresent: boolean;
  isShort: boolean;
  locale: string;
}

/** Canonical sorted-joined projection, then FNV-1a. */
/** Short deterministic hash for identity strings (idempotency keys). */
export function shortHash(input: string): string {
  return fnv1a(input);
}

export function classificationFingerprint(input: FingerprintInput): string {
  const parts = [
    FP_VERSION,
    input.videoId ?? '',
    bound(input.title),
    bound(input.description ?? ''),
    [...input.badges].sort().join('\u0001'),
    [...input.ariaLabels].sort().join('\u0001'),
    [...input.metadataText].sort().join('\u0001'),
    input.officialDisclosurePresent ? '1' : '0',
    input.isShort ? '1' : '0',
    input.locale,
  ];
  return fnv1a(parts.join('\u0000'));
}

// ---- N08 raw-input boundary ----
//
// Content scripts send ONLY raw, bounded evidence inputs; the background
// derives the cache key from them. Key derivation therefore cannot be
// spoofed from the page side, and the wire payload is transparently
// inspectable raw metadata (no derived internals).

/** Maximum entries accepted in one batched cache round-trip. */
export const MAX_BATCH_INPUTS = 100;

/** Bounds mirror classificationFingerprint's bounded projection. */
const MAX_RAW_TITLE = 512;
const MAX_RAW_DESCRIPTION = 2048;
const MAX_RAW_LIST_ITEM = 256;
const MAX_RAW_LIST = 12;
const MAX_RAW_LOCALE = 32;

/** A single raw evidence input for the batched classification cache. */
export interface RawCacheInput {
  videoId?: string | undefined;
  title: string;
  description?: string | undefined;
  badges: readonly string[];
  ariaLabels: readonly string[];
  metadataText: readonly string[];
  officialDisclosurePresent: boolean;
  isShort: boolean;
  locale: string;
}

/** Convert a raw input to the hashable fingerprint projection. */
export function toFingerprintInput(raw: RawCacheInput): FingerprintInput {
  return {
    videoId: raw.videoId,
    title: raw.title,
    description: raw.description,
    badges: raw.badges,
    ariaLabels: raw.ariaLabels,
    metadataText: raw.metadataText,
    officialDisclosurePresent: raw.officialDisclosurePresent,
    isShort: raw.isShort,
    locale: raw.locale,
  };
}

/**
 * N08 hardening: per-input coercion that PRESERVES BATCH ALIGNMENT. A
 * structurally invalid entry maps to undefined in its own slot — filtering
 * it out before the lookup would shift the remaining results and misalign
 * the whole batch on the content side.
 */
export function toFingerprintInputOrNull(value: unknown): FingerprintInput | undefined {
  return isRawCacheInput(value) ? toFingerprintInput(value) : undefined;
}

/** Structural check for one raw input (bounded; mirroring the projection). */
export function isRawCacheInput(value: unknown): value is RawCacheInput {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const raw = value as Record<string, unknown>;
  const videoId = raw['videoId'];
  if (videoId !== undefined && (typeof videoId !== 'string' || videoId.length > 64)) return false;
  if (typeof raw['title'] !== 'string' || raw['title'].length > MAX_RAW_TITLE) return false;
  const description = raw['description'];
  if (
    description !== undefined &&
    (typeof description !== 'string' || description.length > MAX_RAW_DESCRIPTION)
  ) {
    return false;
  }
  const lists = ['badges', 'ariaLabels', 'metadataText'] as const;
  for (const field of lists) {
    const list = raw[field];
    if (!Array.isArray(list) || list.length > MAX_RAW_LIST) return false;
    if (!list.every((item) => typeof item === 'string' && item.length <= MAX_RAW_LIST_ITEM)) {
      return false;
    }
  }
  if (typeof raw['officialDisclosurePresent'] !== 'boolean') return false;
  if (typeof raw['isShort'] !== 'boolean') return false;
  if (typeof raw['locale'] !== 'string' || raw['locale'].length > MAX_RAW_LOCALE) return false;
  return true;
}
