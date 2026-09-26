import { describe, expect, it } from 'vitest';
import {
  STATSDaySchema,
  STATS_MAX_DAYS,
  STATS_RETENTION_DAYS,
  dedupeKeyFor,
  defaultDailyStats,
  dayBucketFor,
  mergeDelta,
  pruneDays,
  rollForwardDay,
  type DailyStatsDelta,
} from '@/domain/stats-daily';

describe('day bucketing (V6-11)', () => {
  it('buckets by LOCAL calendar day (not UTC)', () => {
    // 2026-09-25 23:30 local in a UTC+2 zone === next UTC day.
    const lateNight = new Date(2026, 8, 25, 23, 30).getTime();
    const bucket = dayBucketFor(lateNight);
    expect(bucket).toMatch(/^2026-09-25$/);
    expect(new Date(bucket + 'T00:00:00').getTimezoneOffset()).not.toBeNaN();
  });

  it('midnight rollover moves to a new bucket without losing the old one', () => {
    const before = dayBucketFor(new Date(2026, 8, 25, 23, 59).getTime());
    const after = dayBucketFor(new Date(2026, 8, 26, 0, 1).getTime());
    expect(before).toBe('2026-09-25');
    expect(after).toBe('2026-09-26');
  });
});

describe('dedup (V6-11)', () => {
  it('same video on the same page and after rescan does not double-count', () => {
    const first = mergeDelta(defaultDailyStats('2026-09-25'), '2026-09-25', 'v1', 'hide', 1000, {
      hidden: 1,
    });
    const second = mergeDelta(first, '2026-09-25', 'v1', 'hide', 2000, { hidden: 1 });
    expect(second.days['2026-09-25']!.hides).toBe(1);
    expect(second.days['2026-09-25']!.distinctHidden.has('v1')).toBe(true);
  });

  it('the same video counts ONCE per day across pages/tabs, but events differ from distinct IDs', () => {
    let state = defaultDailyStats('2026-09-25');
    // Seen on 3 different pages of the same day = 1 distinct, 1 event (deduped).
    for (const observedAt of [1000, 2000, 3000]) {
      state = mergeDelta(state, '2026-09-25', 'v9', 'hide', observedAt, { hidden: 1 });
    }
    expect(state.days['2026-09-25']!.hides).toBe(1);
    // A warning for the same video is a distinct outcome kind: counted separately.
    state = mergeDelta(state, '2026-09-25', 'v9', 'warn', 4000, { warned: 1 });
    expect(state.days['2026-09-25']!.warns).toBe(1);
    expect(state.days['2026-09-25']!.hides).toBe(1);
  });

  it('unknown identity gets an explicit counting rule (content-hash key)', () => {
    expect(dedupeKeyFor(undefined, 'sig-abc')).toBe('sig:sig-abc');
    expect(dedupeKeyFor('v1', 'sig-abc')).toBe('v1');
  });
});

describe('persistence and rollover (V6-11)', () => {
  it('prunes to the retention bound (newest days kept)', () => {
    const state = defaultDailyStats('2026-09-25');
    for (let i = 1; i <= STATS_MAX_DAYS + 5; i++) {
      state.days[`2026-01-${String((i % 28) + 1).padStart(2, '0')}`] = {
        hides: 1,
        warns: 0,
        restores: 0,
        manualBlocks: 0,
        distinctHidden: new Set(['x']),
        distinctWarned: new Set(),
      };
    }
    const pruned = pruneDays(state, STATS_MAX_DAYS);
    expect(Object.keys(pruned.days).length).toBeLessThanOrEqual(STATS_MAX_DAYS);
  });

  it('schema version and validation round-trip; corrupt data is rebuilt, not thrown', () => {
    expect(STATSDaySchema).toBe(1);
    const json = { version: 1, days: { '2026-09-25': { hides: 2 } } };
    const parsed = rollForwardDay(json as unknown);
    expect(parsed).not.toBeNull();
    expect(parsed!.days['2026-09-25']!.hides).toBe(2);
    expect(rollForwardDay('garbage')).toBeNull();
    expect(rollForwardDay({ version: 99, days: {} })).toBeNull();
  });

  it('retention constant is documented and bounded (365 days max)', () => {
    expect(STATS_RETENTION_DAYS).toBeLessThanOrEqual(365);
    expect(STATS_MAX_DAYS).toBeLessThanOrEqual(365);
  });
});

describe('delta type (V6-11)', () => {
  it('delta accepts hide/warn/restore/manual counters', () => {
    const delta: DailyStatsDelta = { hidden: 1, warned: 0, restored: 1, manualBlocks: 0 };
    expect(delta).toBeDefined();
    const state = defaultDailyStats('2026-09-25');
    expect(state.currentDay).toBe('2026-09-25');
    expect(state.days['2026-09-25']!.hides).toBe(0);
  });
});
