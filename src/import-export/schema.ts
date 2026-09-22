import { SETTINGS_SCHEMA_VERSION, validateSettings, type UserSettings } from '@/domain/settings';
import { validateRules, type UserRules } from '@/domain/rules';
import { validateReviewRecords, type ReviewRecord } from '@/domain/review';
import { validateStats, type LocalStats } from '@/domain/stats';
import { APP_VERSION } from '@/domain/versions';

/** Top-level export envelope. Imports are treated as untrusted data. */
export interface ExportPayload {
  schemaVersion: number;
  exportedAt: string;
  appVersion: string;
  settings: unknown;
  rules: unknown;
  review?: unknown;
  stats?: unknown;
}

export const EXPORT_SCHEMA_VERSION = 1 as const;

/** Hard limits on imported files to bound memory and abuse. */
export const IMPORT_LIMITS = {
  maxJsonChars: 2_000_000,
  maxReviewRecords: 500,
  /** Structural nesting ceiling for untrusted JSON (04 §10). */
  maxNestingDepth: 32,
} as const;

/** Depth of the deepest array/object literal in a JSON text (cheap scan). */
export function countDepth(jsonText: string): number {
  let depth = 0;
  let max = 0;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < jsonText.length; i++) {
    const ch = jsonText[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{' || ch === '[') {
      depth += 1;
      if (depth > max) max = depth;
    } else if (ch === '}' || ch === ']') depth -= 1;
  }
  return max;
}

export interface ImportOutcome {
  settings: UserSettings;
  rules: UserRules;
  review: ReviewRecord[];
  stats: LocalStats;
  warnings: string[];
  /** True when the payload disabled remote/YouTube-feedback privacy flags. */
  privacyFlagsSanitized: boolean;
  /** SHA-256-like short hash of the exact accepted text (commit key). */
  contentHash: string;
}

export class ImportRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ImportRejectedError';
  }
}

export function buildExport(input: {
  settings: UserSettings;
  rules: UserRules;
  review: ReviewRecord[];
  stats: LocalStats;
}): ExportPayload {
  return {
    schemaVersion: EXPORT_SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    appVersion: APP_VERSION,
    settings: input.settings,
    rules: input.rules,
    review: input.review,
    stats: input.stats,
  };
}

/** FNV-1a over the accepted text — a deterministic commit key, not crypto. */
function shortHash(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

const DANGEROUS_KEYS: readonly string[] = ['__proto__', 'constructor', 'prototype'];

/** Bounded scan: reject prototype-like keys anywhere in the parsed value. */
function containsPrototypeKeys(value: unknown, depth: number = 0): boolean {
  if (depth > IMPORT_LIMITS.maxNestingDepth) return false; // depth check rejects first
  if (Array.isArray(value)) {
    return value.some((item) => containsPrototypeKeys(item, depth + 1));
  }
  if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>;
    for (const key of Object.keys(record)) {
      if (DANGEROUS_KEYS.includes(key)) return true;
      if (containsPrototypeKeys(record[key], depth + 1)) return true;
    }
  }
  return false;
}

/**
 * Validate an imported payload. Every field is checked; unknown fields are
 * ignored; nothing is executed. Throws ImportRejectedError on structural
 * rejection; partial issues (e.g. dropped records) produce warnings.
 *
 * The outcome is a PREPARED import (04 §10): the caller commits it against a
 * contentHash and must not reparse the outcome as an export file.
 */
export function parseImport(jsonText: string): ImportOutcome {
  if (jsonText.length > IMPORT_LIMITS.maxJsonChars) {
    throw new ImportRejectedError(
      `Import too large (limit ${IMPORT_LIMITS.maxJsonChars} characters).`,
    );
  }
  // Nesting bound (04 §10): reject deep payloads before parsing them.
  if (countDepth(jsonText) > IMPORT_LIMITS.maxNestingDepth) {
    throw new ImportRejectedError(
      `Import nesting exceeds ${IMPORT_LIMITS.maxNestingDepth} levels.`,
    );
  }
  let raw: unknown;
  try {
    raw = JSON.parse(jsonText);
  } catch {
    throw new ImportRejectedError('Import is not valid JSON.');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new ImportRejectedError('Import must be a JSON object.');
  }
  if (containsPrototypeKeys(raw)) {
    throw new ImportRejectedError('Import contains forbidden prototype-like keys.');
  }
  const record = raw as Record<string, unknown>;
  const schemaVersion = record['schemaVersion'];
  if (schemaVersion !== EXPORT_SCHEMA_VERSION && schemaVersion !== SETTINGS_SCHEMA_VERSION) {
    throw new ImportRejectedError(`Unsupported import schema version: ${String(schemaVersion)}.`);
  }
  if (typeof record['exportedAt'] !== 'string' || Number.isNaN(Date.parse(record['exportedAt']))) {
    throw new ImportRejectedError('Import is missing a valid exportedAt timestamp.');
  }

  const settings = validateSettings(record['settings']);
  if (settings === null) {
    throw new ImportRejectedError('Import settings section is invalid.');
  }
  const rules = validateRules(record['rules']);
  if (rules === null) {
    throw new ImportRejectedError('Import rules section is invalid.');
  }

  const warnings: string[] = [];
  let review: ReviewRecord[] = [];
  const reviewRaw = record['review'];
  if (reviewRaw !== undefined) {
    const parsed = validateReviewRecords(reviewRaw);
    if (parsed === null) {
      warnings.push('Review history was invalid and was not imported.');
    } else {
      review = parsed.slice(0, IMPORT_LIMITS.maxReviewRecords);
      if (Array.isArray(reviewRaw) && reviewRaw.length > review.length) {
        warnings.push(`Dropped ${reviewRaw.length - review.length} invalid review records.`);
      }
    }
  }

  const stats = validateStats(record['stats'] ?? undefined);

  // DATA-13: a hostile or careless file must not silently re-enable remote
  // traffic or YouTube account actions. The preference TEXT survives in the
  // toggles' stored state; the prepared import ships them disabled.
  let privacyFlagsSanitized = false;
  if (settings.remoteProvider.enabled === true) {
    settings.remoteProvider = { ...settings.remoteProvider, enabled: false };
    privacyFlagsSanitized = true;
  }
  if (settings.youtubeFeedback.enabled === true) {
    settings.youtubeFeedback = { enabled: false };
    privacyFlagsSanitized = true;
  }
  if (privacyFlagsSanitized) {
    warnings.push(
      'Remote provider and “Not interested” feedback were disabled for safety; re-enable them manually if desired.',
    );
  }

  return {
    settings,
    rules,
    review,
    stats,
    warnings,
    privacyFlagsSanitized,
    contentHash: shortHash(jsonText),
  };
}
