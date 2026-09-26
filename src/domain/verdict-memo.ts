import type { DecisionReason, FilterDecision } from './decision';
import type { UserSettings } from './settings';
import { CLASSIFIER_VERSION, RULES_VERSION } from './versions';
import { shortHash } from '@/storage/fingerprint';

/**
 * V5-03: Three-tier remembered-video model (Tier 2).
 * Bounded automatic verdict memo: caches the automatic verdict for a video
 * to fast-path repeat sightings without turning them into permanent blocks.
 */
export interface VerdictMemoEntry {
  videoId: string;
  action: FilterDecision['action'];
  reason: DecisionReason;
  explanation?: string[] | undefined;
  evidenceFingerprint: string;
  classifierVersion: string;
  rulesVersion: string;
  settingsDigest: string;
  createdAt: number;
  expiresAt: number;
}

export const VERDICT_MEMO_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
export const VERDICT_MEMO_MAX_ENTRIES = 5000;

/**
 * Computes a deterministic digest of policy-relevant settings.
 * If mode, categoryActions, or rule packs change,
 * this digest changes, automatically invalidating stale memos.
 */
export function computeSettingsDigest(settings: UserSettings): string {
  const parts = [
    settings.enabled ? '1' : '0',
    settings.mode,
    Object.entries(settings.categoryActions ?? {})
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}:${v}`)
      .join(';'),
    Object.entries(settings.rulePacks ?? {})
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}:${v}`)
      .join(';'),
  ];
  return shortHash(parts.join('|'));
}

export interface VerdictMemoValidationOptions {
  evidenceFingerprint: string;
  classifierVersion?: string | undefined;
  rulesVersion?: string | undefined;
  settingsDigest: string;
  now?: number | undefined;
  corrections?: { notAi: boolean; notSlop: boolean } | undefined;
}

/**
 * Validates whether a verdict memo entry is eligible to fast-path.
 * Invariants:
 * - Must not be expired (bounded TTL).
 * - Versions must match current classifier and rules versions.
 * - Relevant settings must match (via settingsDigest).
 * - Observed evidence fingerprint must match exactly (hydrated or modified evidence misses).
 * - Corrections invalidate conflicting or hide memos (older false hides must not survive).
 */
export function isVerdictMemoValid(
  entry: VerdictMemoEntry,
  options: VerdictMemoValidationOptions,
): boolean {
  const now = options.now ?? Date.now();
  if (now >= entry.expiresAt) return false;

  const expectedClassifierVersion = options.classifierVersion ?? CLASSIFIER_VERSION;
  if (entry.classifierVersion !== expectedClassifierVersion) return false;

  const expectedRulesVersion = options.rulesVersion ?? RULES_VERSION;
  if (entry.rulesVersion !== expectedRulesVersion) return false;

  if (entry.settingsDigest !== options.settingsDigest) return false;

  // Hydration / evidence sensitivity: if evidence is incomplete or changed, fingerprint differs.
  if (entry.evidenceFingerprint !== options.evidenceFingerprint) return false;

  // Personal corrections supersede: older false hides must not survive a correction!
  if (options.corrections?.notAi || options.corrections?.notSlop) {
    return false;
  }

  return true;
}

/**
 * Construct a new VerdictMemoEntry for a computed decision.
 */
export function createVerdictMemoEntry(params: {
  videoId: string;
  decision: FilterDecision;
  evidenceFingerprint: string;
  settings: UserSettings;
  now?: number | undefined;
  ttlMs?: number | undefined;
}): VerdictMemoEntry {
  const now = params.now ?? Date.now();
  const ttlMs = params.ttlMs ?? VERDICT_MEMO_TTL_MS;
  return {
    videoId: params.videoId,
    action: params.decision.action,
    reason: params.decision.reason,
    explanation: params.decision.explanation,
    evidenceFingerprint: params.evidenceFingerprint,
    classifierVersion: CLASSIFIER_VERSION,
    rulesVersion: RULES_VERSION,
    settingsDigest: computeSettingsDigest(params.settings),
    createdAt: now,
    expiresAt: now + ttlMs,
  };
}
