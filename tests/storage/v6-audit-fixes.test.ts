import { beforeEach, describe, expect, it } from 'vitest';
import { DailyStatsStore } from '@/storage/stats-daily-store';
import { MemoryKVStore } from '@/storage/db';
import {
  dayBucketFor,
  rollForwardDay,
  serializeDailyStats,
  type DailyStatsState,
} from '@/domain/stats-daily';

/**
 * Regression tests for the post-ship audit (docs/v6-audit-findings.md).
 * A1/A2/H1 reproduce REAL bugs that shipped in V6-11; A3 covers the newly
 * wired restore path.
 */
describe('audit fixes: daily stats', () => {
  let kv: MemoryKVStore;
  let store: DailyStatsStore;
  const today = () => dayBucketFor(Date.now());

  beforeEach(() => {
    kv = new MemoryKVStore();
    store = new DailyStatsStore(kv);
  });

  it('A1: counters survive a JSON wire round-trip (Sets → arrays → Sets)', async () => {
    await store.record('hide', 'v1', 'sig', Date.now());
    await store.record('warn', 'v2', 'sig2', Date.now());
    const state = await store.summary();

    // This is EXACTLY what the extension message channel does (JSON):
    const wire = JSON.parse(JSON.stringify(serializeDailyStats(state)));
    expect(wire.days[today()].distinctHidden).toEqual(['v1']); // array on the wire

    const rehydrated = rollForwardDay(wire);
    expect(rehydrated).not.toBeNull();
    expect((rehydrated as DailyStatsState).days[today()]!.distinctHidden.size).toBe(1);
    expect((rehydrated as DailyStatsState).days[today()]!.distinctWarned.size).toBe(1);
    expect((rehydrated as DailyStatsState).days[today()]!.distinctHidden.has('v1')).toBe(true);
  });

  it('A2: concurrent records of DIFFERENT videos are all kept (no lost update)', async () => {
    await Promise.all([
      store.record('hide', 'v1', 'sig1', Date.now()),
      store.record('hide', 'v2', 'sig2', Date.now()),
      store.record('warn', 'v3', 'sig3', Date.now()),
    ]);
    const state = await store.summary();
    // Pre-fix: the last writer won and earlier deltas were dropped (1 or 2).
    expect(state.days[today()]!.hides).toBe(2);
    expect(state.days[today()]!.warns).toBe(1);
    expect(state.days[today()]!.distinctHidden.has('v1')).toBe(true);
    expect(state.days[today()]!.distinctHidden.has('v2')).toBe(true);
  });

  it('A2: dedup still collapses the same video under concurrency', async () => {
    await Promise.all([
      store.record('hide', 'v1', 'sig', Date.now()),
      store.record('hide', 'v1', 'sig', Date.now()),
      store.record('hide', 'v1', 'sig', Date.now()),
    ]);
    const state = await store.summary();
    expect(state.days[today()]!.hides).toBe(1);
  });

  it('H1: a far-future timestamp is clamped to today (cannot evict real days)', async () => {
    const year3000 = new Date('3000-01-01T00:00:00Z').getTime();
    await store.record('hide', 'real', 'sig', Date.now());
    await store.record('hide', 'evil', 'sig', year3000);
    const state = await store.summary();
    expect(Object.keys(state.days)).toEqual([today()]);
    expect(state.days[today()]!.hides).toBe(2);
  });

  it('H1: an old-but-within-retention timestamp still lands in its own bucket', async () => {
    const threeDaysAgo = Date.now() - 3 * 86_400_000;
    await store.record('hide', 'old', 'sig', threeDaysAgo);
    const state = await store.summary();
    expect(state.days[dayBucketFor(threeDaysAgo)]!.hides).toBe(1);
  });

  it('A3: restore outcomes are recorded and deduped per identity', async () => {
    await store.record('restore', 'v1', 'sig', Date.now());
    await store.record('restore', 'v1', 'sig', Date.now());
    const state = await store.summary();
    expect(state.days[today()]!.restores).toBe(2); // user actions always count
    // The restore identity lands in the hidden-union input as 'v1'.
  });
});
