import type { FilterDecision } from './decision';
import type { Classification } from './classification';
import type { UserSettings } from './settings';
import type { NormalizedVideoCandidate, Surface } from './video';

/**
 * V7-07: local miss-review queue — WHY did the automatic filter not hide a
 * video the user considers AI/slop?
 *
 * Hard contract: a manual "this is AI" mark is a DIAGNOSTIC, never training
 * data. It does not change detection weights, does not promote a channel, and
 * never touches the network. The queue is local, bounded, deduplicated per
 * video, and exported ONLY on explicit user action.
 */

export const MISS_REASONS = [
  'no-evidence',
  'below-threshold',
  'category-warn',
  'explicit-allow',
  'unsupported-surface',
  'unresolved-identity',
  'error',
] as const;

export type MissReason = (typeof MISS_REASONS)[number];

/** Hard cap on distinct videos kept locally (bounded retention). */
export const MAX_MISS_REVIEW_ENTRIES = 400;

/** Bound on recorded distinct surfaces per entry. */
const MAX_SURFACES_PER_ENTRY = 10;

export interface MissReviewEntry {
  /** Stable id: the videoId, or a content hash when identity was unresolved. */
  id: string;
  videoId: string | undefined;
  title: string;
  /** Display channel name (never used as identity). */
  channelName?: string | undefined;
  surface: string;
  /** All distinct surfaces this video was seen on (bounded). */
  surfaces?: string[] | undefined;
  reason: MissReason;
  firstSeenAt: number;
  lastSeenAt: number;
  sightingCount: number;
  /** Short bound excerpt of why the filter passed the video (≤160 chars). */
  note?: string | undefined;
}

/**
 * Pure upsert: dedupe by id (videoId or content hash), bump counters, refresh
 * reason to the LATEST sighting, and evict least-recently-seen beyond the cap.
 */
export function upsertMissEntry(
  entries: readonly MissReviewEntry[],
  input: {
    videoId: string | undefined;
    title: string;
    channelName?: string | undefined;
    surface: string;
    reason: MissReason;
    seenAt: number;
    note?: string | undefined;
  },
): MissReviewEntry[] {
  const id = input.videoId ?? `sig:${input.title}\u0000${input.surface}`;
  const existingIndex = entries.findIndex((e) => e.id === id);
  const surfaces = new Set(existingIndex >= 0 ? (entries[existingIndex]!.surfaces ?? []) : []);
  surfaces.add(input.surface);
  const boundedSurfaces = [...surfaces].slice(0, MAX_SURFACES_PER_ENTRY);

  const next: MissReviewEntry =
    existingIndex >= 0
      ? {
          ...entries[existingIndex]!,
          title: input.title || entries[existingIndex]!.title,
          channelName: input.channelName ?? entries[existingIndex]!.channelName,
          surface: input.surface,
          surfaces: boundedSurfaces,
          reason: input.reason,
          lastSeenAt: input.seenAt,
          sightingCount: entries[existingIndex]!.sightingCount + 1,
          note: input.note ?? entries[existingIndex]!.note,
        }
      : {
          id,
          videoId: input.videoId,
          title: input.title,
          ...(input.channelName !== undefined ? { channelName: input.channelName } : {}),
          surface: input.surface,
          surfaces: boundedSurfaces,
          reason: input.reason,
          firstSeenAt: input.seenAt,
          lastSeenAt: input.seenAt,
          sightingCount: 1,
          ...(input.note !== undefined ? { note: input.note } : {}),
        };

  const withoutExisting =
    existingIndex >= 0 ? entries.filter((_, i) => i !== existingIndex) : [...entries];
  withoutExisting.unshift(next);

  if (withoutExisting.length > MAX_MISS_REVIEW_ENTRIES) {
    // Evict least-recently seen; the just-touched entry is newest.
    withoutExisting.sort((a, b) => b.lastSeenAt - a.lastSeenAt);
    return withoutExisting.slice(0, MAX_MISS_REVIEW_ENTRIES);
  }
  return withoutExisting;
}

/** Remove entries not seen since `cutoffMs` (bounded retention helper). */
export function pruneMissEntries(
  entries: readonly MissReviewEntry[],
  now: number,
  maxAgeMs: number,
): MissReviewEntry[] {
  const cutoff = now - maxAgeMs;
  return entries.filter((e) => e.lastSeenAt >= cutoff);
}

/**
 * Classify WHY the pipeline did not hide this candidate. Order mirrors the
 * documented decision precedence: disabled surface and explicit user intent
 * outrank automatic-evidence explanations; unknown identity is its own bucket.
 */
export function classifyMiss(input: {
  candidate: NormalizedVideoCandidate;
  decision: FilterDecision;
  classification: Classification | undefined;
  settings: UserSettings;
  surface: Surface;
}): MissReason {
  const { candidate, decision, classification, settings, surface } = input;

  if (candidate.videoId === undefined) return 'unresolved-identity';
  if (surface !== 'unknown' && settings.surfaces[surface] === false) {
    return 'unsupported-surface';
  }
  if (
    decision.reason === 'user-rule' ||
    decision.reason === 'channel-rule' ||
    decision.reason === 'correction'
  ) {
    return 'explicit-allow';
  }
  if (decision.action === 'warn') return 'category-warn';
  if (classification === undefined) return 'no-evidence';
  return 'below-threshold';
}

/** Wire-safe snapshot (plain JSON; the store keeps no Sets/Maps). */
export function serializeMissEntries(entries: readonly MissReviewEntry[]): MissReviewEntry[] {
  return entries.map((e) => ({ ...e }));
}

const MAX_ENTRY_TEXT = 512;
const MAX_ENTRY_NOTE = 160;

/**
 * Structural validation of loaded/exported payloads. Corrupt shapes repair
 * to an empty queue — a garbage blob never crashes listing or recording.
 */
export function validateMissEntries(raw: unknown): MissReviewEntry[] {
  if (!Array.isArray(raw)) return [];
  const out: MissReviewEntry[] = [];
  for (const item of raw.slice(0, MAX_MISS_REVIEW_ENTRIES)) {
    if (typeof item !== 'object' || item === null) continue;
    const e = item as Record<string, unknown>;
    const id = typeof e['id'] === 'string' ? e['id'].slice(0, 256) : '';
    if (id.length === 0) continue;
    const reason = (MISS_REASONS as readonly string[]).includes(e['reason'] as string)
      ? (e['reason'] as MissReason)
      : 'error';
    const count =
      typeof e['sightingCount'] === 'number' && Number.isFinite(e['sightingCount'])
        ? Math.max(1, Math.round(e['sightingCount']))
        : 1;
    const entry: MissReviewEntry = {
      id,
      videoId: typeof e['videoId'] === 'string' ? e['videoId'].slice(0, 64) : undefined,
      title: typeof e['title'] === 'string' ? e['title'].slice(0, MAX_ENTRY_TEXT) : '',
      ...(typeof e['channelName'] === 'string'
        ? { channelName: e['channelName'].slice(0, 256) }
        : {}),
      surface: typeof e['surface'] === 'string' ? e['surface'].slice(0, 32) : 'unknown',
      ...(Array.isArray(e['surfaces'])
        ? {
            surfaces: e['surfaces'].filter((s): s is string => typeof s === 'string').slice(0, 10),
          }
        : {}),
      reason,
      firstSeenAt:
        typeof e['firstSeenAt'] === 'number' && Number.isFinite(e['firstSeenAt'])
          ? e['firstSeenAt']
          : 0,
      lastSeenAt:
        typeof e['lastSeenAt'] === 'number' && Number.isFinite(e['lastSeenAt'])
          ? e['lastSeenAt']
          : 0,
      sightingCount: count,
      ...(typeof e['note'] === 'string' ? { note: e['note'].slice(0, MAX_ENTRY_NOTE) } : {}),
    };
    out.push(entry);
  }
  return out;
}
