import { openExtensionDb } from './idb-schema';
import type { IdbDatabase } from './idb';
import {
  HistoryRepository,
  HISTORY_DEFAULT_PAGE_SIZE,
  type HistoryQuery,
  type HistoryQueryResult,
  type RecordEventInput,
} from './history-repository';
import { CorrectionStore } from './correction-store';
import { ClassificationCacheRepository } from './classification-cache-repo';
import { QuarantineStore } from './quarantine-store';
import { migrateLegacyStorage, type LegacyMigrationResult } from './idb-migrations';
import { BrowserKVStore } from './db';
import { STORAGE_KEYS } from './keys';
import { StatsStore } from './stats-store';
import { validateReviewRecords } from '@/domain/review';
import type { Classification } from '@/domain/classification';
import {
  videoKey,
  type CorrectionRecord,
  type ReviewEvent,
  type ReviewSummary,
  type QuarantineItem,
} from '@/domain/history';
import type { FingerprintInput } from './fingerprint';
import { logger } from '@/shared/logger';

/**
 * StorageService (R10): the single facade over extension-origin IndexedDB.
 *
 * - One lazy connection per context; repositories wrap that connection.
 * - The legacy storage.local → IDB migration runs lazily before first use,
 *   at most once per session; its failure never breaks filtering.
 * - Transient IDB failures get one bounded retry.
 * - When IndexedDB is genuinely unavailable the service degrades to no-ops
 *   (fail open): filtering continues without history/corrections.
 */

/** One bounded retry for transient IDB failures (connection hiccups). */
async function withRetry<T>(fn: () => Promise<T>, attempts = 2): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)));
    }
  }
  throw lastError;
}

interface Repos {
  db: IdbDatabase;
  history: HistoryRepository;
  corrections: CorrectionStore;
  cache: ClassificationCacheRepository;
  quarantine: QuarantineStore;
}

export class StorageService {
  /** Stats live in storage.local (not IDB); owned here for DATA-08 reset. */
  private readonly statsStore = new StatsStore(new BrowserKVStore());
  private reposPromise: Promise<Repos> | null = null;
  private migrationPromise: Promise<LegacyMigrationResult | null> | null = null;
  private unavailable = false;

  private async repos(): Promise<Repos | null> {
    if (this.unavailable) return null;
    try {
      this.reposPromise ??= (async () => {
        const db = await openExtensionDb();
        return {
          db,
          history: new HistoryRepository(db),
          corrections: new CorrectionStore(db),
          cache: new ClassificationCacheRepository(db),
          quarantine: new QuarantineStore(db),
        };
      })();
      return await this.reposPromise;
    } catch (error) {
      this.unavailable = true;
      logger.error('IndexedDB unavailable; running without durable storage', error);
      return null;
    }
  }

  /**
   * Legacy migration: lazy, once per session, idempotent (04 §6). Safe to
   * call from background startup and from content-script first use.
   */
  async ensureMigration(): Promise<LegacyMigrationResult | null> {
    this.migrationPromise ??= (async () => {
      const repos = await this.repos();
      if (repos === null) return null;
      try {
        return await migrateLegacyStorage({
          kv: new BrowserKVStore(),
          db: repos.db,
          history: repos.history,
          corrections: repos.corrections,
          quarantine: repos.quarantine,
        });
      } catch (error) {
        logger.error('legacy storage migration failed; retrying next session', error);
        return null;
      }
    })();
    return this.migrationPromise;
  }

  // ---- history ----

  async recordHidden(input: Omit<RecordEventInput, 'key'> & { sessionKey: string }): Promise<void> {
    await this.ensureMigration();
    const repos = await this.repos();
    if (repos === null) return;
    const { sessionKey, ...rest } = input;
    const key = videoKey(rest.videoId, sessionKey);
    await withRetry(() => repos.history.recordHidden({ ...rest, key })).catch((error) => {
      logger.error('recordHidden failed', error);
    });
  }

  async listRecentSummaries(limit: number): Promise<ReviewSummary[]> {
    await this.ensureMigration();
    const repos = await this.repos();
    if (repos === null) return [];
    return withRetry(() => repos.history.listSummaries(limit));
  }

  async countSummaries(): Promise<number> {
    const repos = await this.repos();
    if (repos === null) return 0;
    return withRetry(() => repos.history.countSummaries());
  }

  /** Paged/filtered history query with exact counts (R19/R20). */
  async queryHistory(query: HistoryQuery): Promise<HistoryQueryResult> {
    await this.ensureMigration();
    const repos = await this.repos();
    if (repos === null) {
      return { items: [], total: 0, page: 1, pageSize: HISTORY_DEFAULT_PAGE_SIZE };
    }
    return withRetry(() => repos.history.querySummaries(query));
  }

  /** Bounded event log for one summary (evidence detail, R24). */
  async eventsFor(key: string, limit: number): Promise<ReviewEvent[]> {
    await this.ensureMigration();
    const repos = await this.repos();
    if (repos === null) return [];
    return withRetry(() => repos.history.eventsFor(key, limit));
  }

  /** Clear review history ONLY — corrections survive (R11). Legacy rows too. */
  async clearHistory(): Promise<void> {
    await this.ensureMigration();
    const repos = await this.repos();
    if (repos === null) return;
    await withRetry(() => repos.history.clearHistory());
    // Legacy pre-migration rows are part of "review history" for the user;
    // a completed migration (and any straggler rows) must not resurrect them.
    await new BrowserKVStore().remove(STORAGE_KEYS.reviewRecords);
  }

  async markRestored(key: string): Promise<boolean> {
    await this.ensureMigration();
    const repos = await this.repos();
    if (repos === null) return false;
    const restored = await withRetry(async () => {
      const summary = await repos.history.getSummary(key);
      if (summary === undefined) return false;
      return repos.history.markRestored(
        key,
        summary.latestDecision,
        Date.now(),
        `restore:${key}:${Date.now()}`,
      );
    });
    if (restored) return true;
    // Legacy fallback (HIS-10): the key may be a not-yet-migrated legacy
    // record id. Restoring it now promotes that row through migration so the
    // click takes effect instead of silently no-oping.
    const kv = new BrowserKVStore();
    const raw = await kv.get<unknown>(STORAGE_KEYS.reviewRecords);
    const legacy = validateReviewRecords(raw) ?? [];
    const target = legacy.find((r) => r.id === key);
    if (target === undefined) return false;
    const result = await migrateLegacyStorage({
      kv,
      db: repos.db,
      history: repos.history,
      corrections: repos.corrections,
      quarantine: repos.quarantine,
    });
    return result !== null && result.summaries > 0;
  }

  async enforceHistoryRetention(retentionDays?: number): Promise<number> {
    const repos = await this.repos();
    if (repos === null) return 0;
    let removed = await withRetry(() => repos.history.enforceSummariesRetention());
    if (retentionDays !== undefined) {
      removed += await withRetry(() => repos.history.enforceAgeRetention(retentionDays));
    }
    return removed;
  }

  // ---- corrections (independent of history) ----

  async getCorrectionSignals(
    videoId: string | undefined,
  ): Promise<{ notAi: boolean; notSlop: boolean }> {
    if (videoId === undefined) return { notAi: false, notSlop: false };
    await this.ensureMigration();
    const repos = await this.repos();
    if (repos === null) return { notAi: false, notSlop: false };
    try {
      const record = await withRetry(() => repos.corrections.get(videoId));
      return { notAi: record?.notAi ?? false, notSlop: record?.notSlop ?? false };
    } catch (error) {
      logger.error('getCorrectionSignals failed', error);
      return { notAi: false, notSlop: false };
    }
  }

  async setCorrection(
    videoId: string,
    dimension: 'notAi' | 'notSlop',
    value: boolean,
  ): Promise<CorrectionRecord | null> {
    await this.ensureMigration();
    const repos = await this.repos();
    if (repos === null) return null;
    return withRetry(() => repos.corrections.setDimension(videoId, dimension, value));
  }

  /** Bulk delete with per-key outcomes (HIS-15). */
  async deleteSummaries(
    keys: readonly string[],
  ): Promise<{ deleted: string[]; missing: string[] }> {
    await this.ensureMigration();
    const repos = await this.repos();
    if (repos === null) return { deleted: [], missing: [...keys] };
    const deleted: string[] = [];
    const missing: string[] = [];
    for (const key of keys) {
      if (await withRetry(() => repos.history.getSummary(key))) {
        await withRetry(() => repos.history.deleteSummaryCascade(key));
        deleted.push(key);
      } else {
        missing.push(key);
      }
    }
    return { deleted, missing };
  }

  /** Bounded undo payload for bulk delete (HIS-16). */
  async getSummaries(keys: readonly string[]): Promise<ReviewSummary[]> {
    const repos = await this.repos();
    if (repos === null) return [];
    const out: ReviewSummary[] = [];
    for (const key of keys) {
      const summary = await withRetry(() => repos.history.getSummary(key));
      if (summary !== undefined) out.push(summary);
    }
    return out;
  }

  async putSummaries(summaries: readonly ReviewSummary[]): Promise<void> {
    const repos = await this.repos();
    if (repos === null) return;
    await withRetry(() => repos.history.putSummaries(summaries));
  }

  async countCorrections(): Promise<number> {
    const repos = await this.repos();
    if (repos === null) return 0;
    return withRetry(() => repos.corrections.count());
  }

  // ---- classification cache (fingerprint-keyed) ----

  async getCachedClassification(
    input: FingerprintInput,
    rulesVersion: string,
  ): Promise<Classification | undefined> {
    await this.ensureMigration();
    const repos = await this.repos();
    if (repos === null) return undefined;
    return withRetry(() => repos.cache.get(input, rulesVersion));
  }

  async putCachedClassification(
    input: FingerprintInput,
    classification: Classification,
    rulesVersion: string,
  ): Promise<void> {
    const repos = await this.repos();
    if (repos === null) return;
    await withRetry(() => repos.cache.put(input, classification, rulesVersion)).catch((error) => {
      logger.error('putCachedClassification failed', error);
    });
  }

  async enforceCacheRetention(): Promise<number> {
    const repos = await this.repos();
    if (repos === null) return 0;
    return withRetry(() => repos.cache.enforceRetention());
  }

  // ---- quarantine + maintenance ----

  async listQuarantine(limit?: number): Promise<QuarantineItem[]> {
    const repos = await this.repos();
    if (repos === null) return [];
    return withRetry(() => repos.quarantine.list(limit));
  }

  async countQuarantine(): Promise<number> {
    const repos = await this.repos();
    if (repos === null) return 0;
    const items = await this.listQuarantine();
    return items.length;
  }

  /** Run all bounded-retention passes (call on startup, with settings). */
  async enforceRetention(retentionDays?: number): Promise<void> {
    await this.enforceHistoryRetention(retentionDays);
    await this.enforceCacheRetention();
  }

  // ---- DATA-08: separate data-class controls ----

  /** Clear ONLY the classification cache. */
  async clearCache(): Promise<void> {
    await this.ensureMigration();
    const repos = await this.repos();
    if (repos === null) return;
    await withRetry(() => repos.cache.clear());
  }

  /** Clear ONLY user corrections — irreversible, requires explicit confirm. */
  async clearCorrections(): Promise<void> {
    await this.ensureMigration();
    const repos = await this.repos();
    if (repos === null) return;
    await withRetry(() => repos.corrections.clearAll());
  }

  /** Reset ONLY local statistics. */
  async resetStats(): Promise<void> {
    await this.statsStore.reset();
  }
}
