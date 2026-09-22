import type { FilterDecision } from './decision';
import type { Surface } from './video';

/**
 * History domain (R10/R11, 04 §4): summaries + events + corrections.
 *
 * Corrections are a SEPARATE store with independent retention: clearing
 * review history must never destroy user corrections (the R11 defect).
 */

/** One logical video (or session-local unknown card) in review history. */
export interface ReviewSummary {
  /** Stable video key: `v:<videoId>` or `u:<sessionKey>` for unknown videos. */
  key: string;
  videoId?: string | undefined;
  title: string;
  channelId?: string | undefined;
  channelName?: string | undefined;
  handle?: string | undefined;
  surfaces: Surface[];
  latestDecision: FilterDecision;
  /** User-visible resolution state (review queue semantics). */
  resolution: 'pending' | 'restored' | 'corrected' | 'allowed';
  firstSeen: number;
  lastSeen: number;
  /** Times this video was (re)hidden across sessions. */
  count: number;
  /** Compact last-evidence note; full evidence lives in events. */
  evidenceSummary: string;
  revision: number;
}

export const SUMMARY_SCHEMA_VERSION = 1 as const;

/** Bounded event log per summary (default cap; 04 §4). */
export const MAX_EVENTS_PER_SUMMARY = 20;

export type ReviewEventKind = 'hidden' | 'reshown' | 'restored' | 'correction' | 'allowed';

/** Append-only fact: "on <occurredAt>, X happened to <summaryKey>". */
export interface ReviewEvent {
  eventId: string;
  summaryKey: string;
  occurredAt: number;
  kind: ReviewEventKind;
  decisionSnapshot: FilterDecision;
  /** Idempotency: duplicates with the same operationId must not reapply. */
  operationId?: string | undefined;
}

/** User's per-video correction; survives history clears. */
export interface CorrectionRecord {
  videoId: string;
  notAi: boolean;
  notSlop: boolean;
  updatedAt: number;
  revision: number;
  /** Where this correction came from. */
  source: 'user' | 'migrated';
}

export function correctionKey(videoId: string): string {
  return videoId;
}

export function videoKey(videoId: string | undefined, sessionKey: string): string {
  return videoId !== undefined ? `v:${videoId}` : `u:${sessionKey}`;
}

/** Item rejected during migration/import; kept bounded + exportable. */
export interface QuarantineItem {
  id: string;
  reason: string;
  source: 'migration' | 'import';
  /** Redacted preview of the rejected record (no raw browsing content). */
  preview: string;
  occurredAt: number;
}

export const QUARANTINE_MAX_ITEMS = 200;

const MAX_TEXT = 512;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown, max: number): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value.slice(0, max) : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** Structural validation for summaries loaded from IDB (import path). */
export function validateSummary(raw: unknown): ReviewSummary | null {
  if (!isRecord(raw)) return null;
  const key = str(raw['key'], 256);
  const title = str(raw['title'], MAX_TEXT);
  const decision = raw['latestDecision'];
  if (key === undefined || title === undefined || !isRecord(decision)) return null;
  const action = decision['action'];
  if (action !== 'allow' && action !== 'warn' && action !== 'hide') return null;
  const reason = str(decision['reason'], 32);
  if (reason === undefined) return null;
  const firstSeen = num(raw['firstSeen']) ?? Date.now();
  const lastSeen = num(raw['lastSeen']) ?? firstSeen;
  const surfaces = Array.isArray(raw['surfaces'])
    ? (raw['surfaces'].filter((s): s is Surface => typeof s === 'string') as Surface[])
    : (['unknown'] as Surface[]);
  const resolutionRaw = str(raw['resolution'], 16);
  const resolution: ReviewSummary['resolution'] =
    resolutionRaw === 'restored' || resolutionRaw === 'corrected' || resolutionRaw === 'allowed'
      ? resolutionRaw
      : 'pending';
  return {
    key,
    videoId: str(raw['videoId'], 64),
    title,
    channelId: str(raw['channelId'], 64),
    channelName: str(raw['channelName'], 256),
    handle: str(raw['handle'], 128),
    surfaces: surfaces.length > 0 ? surfaces : ['unknown'],
    latestDecision: {
      action,
      reason: reason as FilterDecision['reason'],
      explanation: Array.isArray(decision['explanation'])
        ? decision['explanation']
            .filter((line): line is string => typeof line === 'string')
            .slice(0, 12)
            .map((line) => line.slice(0, MAX_TEXT))
        : [],
    },
    resolution,
    firstSeen,
    lastSeen: Math.max(firstSeen, lastSeen),
    count: num(raw['count']) ?? 1,
    evidenceSummary: str(raw['evidenceSummary'], 256) ?? '',
    revision: num(raw['revision']) ?? 1,
  };
}
