import {
  STATS_MAX_DAYS,
  dayBucketFor,
  dedupeKeyFor,
  defaultDailyStats,
  mergeDelta,
  pruneDays,
  rollForwardDay,
  serializeDailyStats,
  type DailyStatsState,
} from '@/domain/stats-daily';
import type { KVStore } from './db';
import { STORAGE_KEYS } from './keys';

export type DailyOutcome = 'hide' | 'warn' | 'restore' | 'manual-block';

/**
 * Durable day-bucketed statistics (V6-11), stored under its OWN key so a
 * reset can never touch filtering rules or review data, and history can
 * never be mistaken for stats. All writes go through one read-modify-write
 * on shared storage, so concurrent tabs/restarts aggregate without losing
 * or double-counting sightings (dedup is by identity per local day).
 */ export class DailyStatsStore {
  constructor(private readonly kv: KVStore) {}

  /**
   * Audit A2: serializes read-modify-write cycles. The single background
   * worker owns ONE store instance; concurrent record() calls (two tabs, a
   * tab + rescan) queue here so a later save can never overwrite an earlier
   * one's delta (which silently DROPPED counts).
   */
  private writeQueue: Promise<unknown> = Promise.resolve();

  private enqueue<T>(job: () => Promise<T>): Promise<T> {
    const next = this.writeQueue.then(job, job);
    this.writeQueue = next.catch(() => undefined); // keep the chain alive
    return next;
  }

  async load(): Promise<DailyStatsState> {
    const raw = await this.kv.get<unknown>(STORAGE_KEYS.statsDaily);
    const parsed = rollForwardDay(raw) ?? defaultDailyStats(dayBucketFor(Date.now()));
    return pruneDays(parsed, STATS_MAX_DAYS);
  }

  private async save(state: DailyStatsState): Promise<void> {
    await this.kv.set(STORAGE_KEYS.statsDaily, serializeDailyStats(state));
  }

  /**
   * Record one observed outcome at `observedAt` (epoch ms). Dedup and
   * bucketing are decided HERE against the persisted state so two tabs (or a
   * tab and a rescan) hitting the same video on the same local day count once.
   * Audit H1: timestamps outside [now − retention, now + 1 day] are clamped
   * to now so a buggy/hostile content script cannot create future buckets
   * that evict every real day from the retention window.
   */
  async record(
    outcome: DailyOutcome,
    dedupeKey: string | undefined,
    signature: string,
    observedAt: number,
  ): Promise<void> {
    await this.enqueue(async () => {
      const now = Date.now();
      const earliest = now - STATS_MAX_DAYS * 86_400_000;
      const latest = now + 86_400_000;
      const safeAt =
        Number.isFinite(observedAt) && observedAt >= earliest && observedAt <= latest
          ? observedAt
          : now;
      const state = await this.load();
      const day = dayBucketFor(safeAt);
      const identity = dedupeKey ?? dedupeKeyFor(undefined, signature);
      mergeDelta(state, day, identity, outcome, safeAt, {});
      await this.save(pruneDays(state, STATS_MAX_DAYS));
    });
  }

  /** Bounded day buckets, current day included (for popup/stats UI). */
  async summary(): Promise<DailyStatsState> {
    return this.load();
  }

  /** Clear daily stats ONLY — rules, review data and corrections survive. */
  async reset(): Promise<void> {
    await this.save(defaultDailyStats(dayBucketFor(Date.now())));
  }
}
