import { beforeEach, describe, expect, it } from 'vitest';
import { DailyStatsStore } from '@/storage/stats-daily-store';
import { MemoryKVStore } from '@/storage/db';
import { STATS_MAX_DAYS, dayBucketFor, serializeDailyStats } from '@/domain/stats-daily';

describe('daily stats store (V6-11)', () => {
  let kv: MemoryKVStore;
  let store: DailyStatsStore;

  beforeEach(() => {
    kv = new MemoryKVStore();
    store = new DailyStatsStore(kv);
  });

  it('records and persists outcomes; survives worker restart (new store, same kv)', async () => {
    await store.record('hide', 'v1', 'sig', Date.now());
    const reborn = new DailyStatsStore(kv);
    const today = dayBucketFor(Date.now());
    const state = await reborn.load();
    expect(state.days[today]!.hides).toBe(1);
    expect(state.days[today]!.distinctHidden.has('v1')).toBe(true);
    void serializeDailyStats;
  });

  it('dedups across concurrent tabs and repeat sightings within a day', async () => {
    const tabA = new DailyStatsStore(kv);
    const tabB = new DailyStatsStore(kv);
    await Promise.all([
      tabA.record('hide', 'v1', 'sig', Date.now()),
      tabB.record('hide', 'v1', 'sig', Date.now()),
      tabA.record('hide', 'v1', 'sig', Date.now()),
    ]);
    const state = await store.load();
    const today = dayBucketFor(Date.now());
    expect(state.days[today]!.hides).toBe(1); // three sightings, ONE distinct video today
  });

  it('a cross-midnight open tab lands events in the correct local-day buckets', async () => {
    const beforeMidnight = new Date(2026, 8, 25, 23, 59).getTime();
    const afterMidnight = new Date(2026, 8, 26, 0, 1).getTime();
    await store.record('hide', 'v1', 'sig', beforeMidnight);
    await store.record('hide', 'v2', 'sig2', afterMidnight);
    const state = await store.load();
    expect(state.days['2026-09-25']!.hides).toBe(1);
    expect(state.days['2026-09-26']!.hides).toBe(1);
    expect(state.currentDay).toBe('2026-09-26');
  });

  it('prunes to the retention bound as days accumulate', async () => {
    // Simulate old days directly in storage.
    const fake = {
      version: 1,
      days: {} as Record<string, unknown>,
      currentDay: dayBucketFor(Date.now()),
    };
    for (let i = 0; i < STATS_MAX_DAYS + 3; i++) {
      const day = new Date(Date.now() - i * 86_400_000);
      const key = dayBucketFor(day.getTime());
      fake.days[key] = {
        hides: 1,
        warns: 0,
        restores: 0,
        manualBlocks: 0,
        distinctHidden: ['v'],
        distinctWarned: [],
      };
    }
    await kv.set('local:statsDaily', fake);
    const state = await store.load();
    expect(Object.keys(state.days).length).toBeLessThanOrEqual(STATS_MAX_DAYS);
  });

  it('corrupt stored records are rebuilt, never throw', async () => {
    await kv.set('local:statsDaily', 'not-a-record');
    const state = await store.load();
    expect(state.version).toBe(1);
    await kv.set('local:statsDaily', { version: 42 } as unknown as Record<string, never>);
    const state2 = await store.load();
    expect(state2.version).toBe(1);
  });

  it('reset clears ONLY daily stats (rules and review keys untouched)', async () => {
    await kv.set('local:rules', { allowedVideoIds: ['keep-me'] });
    await kv.set('local:reviewRecords', [{ id: 'keep' }]);
    await store.record('hide', 'v1', 'sig', Date.now());
    await store.reset();
    const state = await store.load();
    expect(state.days[dayBucketFor(Date.now())]!.hides).toBe(0);
    expect((await kv.get('local:rules')) as unknown).toEqual({ allowedVideoIds: ['keep-me'] });
    expect((await kv.get('local:reviewRecords')) as unknown).toEqual([{ id: 'keep' }]);
  });
});
