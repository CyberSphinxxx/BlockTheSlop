import type { FilterDecision } from './decision';
import type { Surface } from './video';

/** A record of content the extension hid automatically — the recovery path. */
export interface ReviewRecord {
  id: string;
  videoId?: string | undefined;
  title: string;
  channelId?: string | undefined;
  channelName?: string | undefined;
  surface: Surface;
  decision: FilterDecision;
  createdAt: number;
  restoredAt?: number | undefined;
  /** User marked this record as a false positive (Not AI / Not slop). */
  correction?: ('not-ai' | 'not-slop')[] | undefined;
}

export const REVIEW_SCHEMA_VERSION = 1 as const;

/** Retention: keep the most recent records, bounded to avoid unbounded growth. */
export const REVIEW_MAX_RECORDS = 500;

const MAX_TITLE_LENGTH = 512;
const MAX_ID_LENGTH = 256;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function truncateString(value: unknown, max: number): string | undefined {
  return typeof value === 'string' ? value.slice(0, max) : undefined;
}

/** Structural validation of persisted/imported review records. */
export function validateReviewRecords(raw: unknown): ReviewRecord[] | null {
  if (!Array.isArray(raw)) return null;
  const out: ReviewRecord[] = [];
  const seen = new Set<string>();
  for (const item of raw.slice(0, REVIEW_MAX_RECORDS)) {
    if (!isRecord(item)) continue;
    const id = truncateString(item['id'], 128);
    const decisionRaw = item['decision'];
    if (id === undefined || !isRecord(decisionRaw)) continue;
    const action = decisionRaw['action'];
    const reason = decisionRaw['reason'];
    if (action !== 'allow' && action !== 'warn' && action !== 'hide') continue;
    if (typeof reason !== 'string' || reason.length > 32) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    const explanation = Array.isArray(decisionRaw['explanation'])
      ? decisionRaw['explanation']
          .filter((line): line is string => typeof line === 'string')
          .slice(0, 12)
          .map((line) => line.slice(0, 512))
      : [];
    const createdAt =
      typeof item['createdAt'] === 'number' && Number.isFinite(item['createdAt'])
        ? item['createdAt']
        : Date.now();
    const restoredAt =
      typeof item['restoredAt'] === 'number' && Number.isFinite(item['restoredAt'])
        ? item['restoredAt']
        : undefined;
    const correction = Array.isArray(item['correction'])
      ? item['correction'].filter(
          (c): c is 'not-ai' | 'not-slop' => c === 'not-ai' || c === 'not-slop',
        )
      : undefined;
    out.push({
      id,
      videoId: truncateString(item['videoId'], MAX_ID_LENGTH),
      title: truncateString(item['title'], MAX_TITLE_LENGTH) ?? '(untitled)',
      channelId: truncateString(item['channelId'], MAX_ID_LENGTH),
      channelName: truncateString(item['channelName'], 256),
      surface:
        typeof item['surface'] === 'string'
          ? (item['surface'] as ReviewRecord['surface'])
          : 'unknown',
      decision: {
        action,
        reason: reason as FilterDecision['reason'],
        explanation,
      },
      createdAt,
      restoredAt,
      correction,
    });
  }
  return out;
}

/** Deterministic record id for a hidden card at a point in time. */
export function reviewRecordId(videoId: string | undefined, observedAt: number): string {
  const base = videoId ?? 'unknown';
  return `rv-${base}-${observedAt.toString(36)}`;
}
