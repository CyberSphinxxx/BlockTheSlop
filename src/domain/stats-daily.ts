/**
 * V6-11: durable, bounded, day-bucketed local statistics.
 *
 * Contract:
 * - `today` = the LOCAL calendar day's observed outcomes — never the lifetime
 *   `LocalStats` counters (those remain diagnostics-only, never labeled
 *   "Today").
 * - Distinct video identities vs events are different numbers: the same video
 *   re-sighted on the same page, after a rescan, on another surface, or in
 *   another tab on the same local day is counted ONCE per day per outcome
 *   kind. Hide and warn of the same video are distinct outcome kinds.
 * - Unknown identity (no videoId) is counted under an explicit content-hash
 *   key, never silently dropped or conflated with a known ID.
 * - Buckets are bounded (STATS_MAX_DAYS) — storage cannot grow forever.
 * - Statistics never cause or authorize a hide; they are write-behind
 *   observations only.
 */

/** Schema version of the daily-stats record. */
export const STATSDaySchema = 1 as const;

/** Retention bound in days (bounded storage; also used by the settings copy). */
export const STATS_MAX_DAYS = 90;

/** Alias kept for requirement wording ("bounded daily stats"); same bound. */
export const STATS_RETENTION_DAYS = STATS_MAX_DAYS;

/** The counters of ONE local day. Distinct sets are the dedup memory. */
export interface DayBucket {
  /** Hide events counted today (deduplicated per distinct identity). */
  hides: number;
  /** Warn events counted today (deduplicated per distinct identity). */
  warns: number;
  /** Restore actions observed today (not identity-deduplicated). */
  restores: number;
  /** Manual blocks observed today (not identity-deduplicated). */
  manualBlocks: number;
  /** Distinct video identities hidden today (dedup memory). */
  distinctHidden: Set<string>;
  /** Distinct video identities warned today (dedup memory). */
  distinctWarned: Set<string>;
}

/** The persisted record: schema version + day buckets keyed 'YYYY-MM-DD'. */
export interface DailyStatsState {
  version: number;
  days: Record<string, DayBucket>;
  /** The local day the record was last written for (rollover detection). */
  currentDay: string;
}

export type DailyStatsDelta = {
  hidden?: number;
  warned?: number;
  restored?: number;
  manualBlocks?: number;
};

/** Local calendar day key 'YYYY-MM-DD' for an epoch-ms timestamp. */
export function dayBucketFor(epochMs: number): string {
  const d = new Date(epochMs);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** The dedup identity for a stat event: videoId, else an explicit content-hash key. */
export function dedupeKeyFor(videoId: string | undefined, signature: string): string {
  return videoId ?? `sig:${signature}`;
}

function emptyBucket(): DayBucket {
  return {
    hides: 0,
    warns: 0,
    restores: 0,
    manualBlocks: 0,
    distinctHidden: new Set<string>(),
    distinctWarned: new Set<string>(),
  };
}

export function defaultDailyStats(currentDay: string): DailyStatsState {
  return { version: STATSDaySchema, days: { [currentDay]: emptyBucket() }, currentDay };
}

/**
 * Record one observed outcome. Returns the SAME state object (mutated) — the
 * caller owns persistence. Dedup rules:
 * - hide/warn dedup by identity per day (a repeat sighting of the same video
 *   on the same day does not inflate counters),
 * - restore/manualBlocks are user actions and always count.
 */
export function mergeDelta(
  state: DailyStatsState,
  day: string,
  dedupeKey: string,
  outcome: 'hide' | 'warn' | 'restore' | 'manual-block',
  _observedAt: number,
  _delta: DailyStatsDelta,
): DailyStatsState {
  void _observedAt;
  void _delta;
  let bucket = state.days[day];
  if (bucket === undefined) {
    bucket = emptyBucket();
    state.days[day] = bucket;
  }
  state.currentDay = day;

  if (outcome === 'hide') {
    if (!bucket.distinctHidden.has(dedupeKey)) {
      bucket.distinctHidden.add(dedupeKey);
      bucket.hides += 1;
    }
  } else if (outcome === 'warn') {
    if (!bucket.distinctWarned.has(dedupeKey)) {
      bucket.distinctWarned.add(dedupeKey);
      bucket.warns += 1;
    }
  } else if (outcome === 'restore') {
    bucket.restores += 1;
  } else {
    bucket.manualBlocks += 1;
  }
  return state;
}

/** Drop the oldest days beyond `keep` — bounded storage, deterministic. */
export function pruneDays(state: DailyStatsState, keep: number): DailyStatsState {
  const keys = Object.keys(state.days).sort();
  const excess = keys.length - keep;
  if (excess <= 0) return state;
  for (const key of keys.slice(0, excess)) {
    delete state.days[key];
  }
  return state;
}

/**
 * Parse a persisted record. Corrupt shapes are REBUILT (null → caller writes
 * a fresh record); unknown versions are rejected rather than guessed.
 * Sets are rehydrated from arrays; counters are clamped to safe integers.
 */
export function rollForwardDay(raw: unknown): DailyStatsState | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  if (record['version'] !== STATSDaySchema) return null;
  if (
    typeof record['days'] !== 'object' ||
    record['days'] === null ||
    Array.isArray(record['days'])
  ) {
    return null;
  }
  const days: Record<string, DayBucket> = {};
  for (const [key, value] of Object.entries(record['days'] as Record<string, unknown>)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) return null;
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
    const bucketRaw = value as Record<string, unknown>;
    const bucket = emptyBucket();
    for (const field of ['hides', 'warns', 'restores', 'manualBlocks'] as const) {
      const n = bucketRaw[field];
      if (typeof n === 'number' && Number.isFinite(n) && n >= 0) {
        bucket[field] = Math.min(Math.round(n), Number.MAX_SAFE_INTEGER);
      }
    }
    for (const field of ['distinctHidden', 'distinctWarned'] as const) {
      // Audit A1 defense: tolerate BOTH wire arrays and in-memory Sets so a
      // rehydrated fake or a future in-process caller round-trips safely.
      const list = bucketRaw[field];
      const items = Array.isArray(list) ? list : list instanceof Set ? [...list] : [];
      for (const item of items.slice(0, 10_000)) {
        if (typeof item === 'string' && item.length <= 128) {
          bucket[field].add(item);
        }
      }
    }
    days[key] = bucket;
  }
  const currentDay =
    typeof record['currentDay'] === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(record['currentDay'])
      ? record['currentDay']
      : (Object.keys(days).sort().at(-1) ?? dayBucketFor(Date.now()));
  return { version: STATSDaySchema, days, currentDay };
}

/** Serialize a state for persistence (sets → arrays). */
export function serializeDailyStats(state: DailyStatsState): Record<string, unknown> {
  const days: Record<string, unknown> = {};
  for (const [key, bucket] of Object.entries(state.days)) {
    days[key] = {
      hides: bucket.hides,
      warns: bucket.warns,
      restores: bucket.restores,
      manualBlocks: bucket.manualBlocks,
      distinctHidden: [...bucket.distinctHidden],
      distinctWarned: [...bucket.distinctWarned],
    };
  }
  return { version: state.version, days, currentDay: state.currentDay };
}
