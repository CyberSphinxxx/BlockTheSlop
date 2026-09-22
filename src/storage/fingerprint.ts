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
