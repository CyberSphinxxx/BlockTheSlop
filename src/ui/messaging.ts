import type { UserSettings } from '@/domain/settings';
import { defaultSettings, migrateSettings, SETTINGS_SCHEMA_VERSION } from '@/domain/settings';
import type { UserRules } from '@/domain/rules';
import type { ReviewRecord } from '@/domain/review';
import type { ReviewSummary, ReviewEvent, QuarantineItem } from '@/domain/history';
import type { LocalStats } from '@/domain/stats';
import type { HistoryQuery, HistoryQueryResult } from '@/storage/history-repository';

/**
 * Popup/options pages talk to the background worker, which owns IndexedDB
 * (content scripts and UI pages must not touch IDB directly: UI pages share
 * the extension origin, but background ownership keeps one connection and one
 * migration path). In tests a fake Backend with the same interface is used.
 */

async function send<T>(type: string, payload?: unknown): Promise<T> {
  const response = (await browser.runtime.sendMessage({ type, payload })) as unknown;
  if (typeof response === 'object' && response !== null && 'error' in response) {
    throw new Error(String((response as { error: unknown }).error));
  }
  return response as T;
}

/** Project a durable summary into the legacy record shape the UI renders. */
export function summaryToRecord(summary: ReviewSummary): ReviewRecord {
  return {
    id: summary.key,
    videoId: summary.videoId,
    title: summary.title,
    channelId: summary.channelId,
    channelName: summary.channelName,
    surface: summary.surfaces[0] ?? 'unknown',
    decision: summary.latestDecision,
    createdAt: summary.firstSeen,
    ...(summary.resolution === 'restored' ? { restoredAt: summary.lastSeen } : {}),
  };
}

export interface Backend {
  getSettings(): Promise<UserSettings>;
  /**
   * Field-level PATCH (CFG-03): only the provided top-level fields change;
   * other fields keep their CURRENT stored values, so concurrent edits from
   * options + popup never clobber each other.
   */
  saveSettings(patch: Partial<UserSettings>): Promise<void>;
  getRules(): Promise<UserRules>;
  /** Review history: durable summaries + any not-yet-migrated legacy records. */
  getReview(): Promise<ReviewRecord[]>;
  /** Durable summaries directly (query-based history UI, R19). */
  getReviewSummaries(): Promise<ReviewSummary[]>;
  getStats(): Promise<LocalStats>;
  /** Paged/filtered history query with exact totals (R19/R20). */
  queryHistory(query: HistoryQuery): Promise<HistoryQueryResult>;
  /** Bounded event log for one summary (evidence detail, R24). */
  getHistoryEvents(key: string, limit?: number): Promise<ReviewEvent[]>;
  /** Durable review actions — routed to background-owned IndexedDB. */
  restoreSummary(key: string): Promise<boolean>;
  setCorrection(videoId: string, dimension: 'notAi' | 'notSlop', value: boolean): Promise<void>;
  /** Bulk delete with per-key outcomes (HIS-15). */
  deleteSummaries(keys: readonly string[]): Promise<{ deleted: string[]; missing: string[] }>;
  /** Fetch summaries verbatim (undo payload) and re-insert them (HIS-16). */
  getSummaries(keys: readonly string[]): Promise<ReviewSummary[]>;
  putSummaries(summaries: readonly ReviewSummary[]): Promise<void>;
  /** Clear review history; corrections survive (R11). */
  clearHistory(): Promise<void>;
  getQuarantine(): Promise<QuarantineItem[]>;
  /** DATA-08: separate data-class controls. */
  clearCache(): Promise<void>;
  clearCorrections(): Promise<void>;
  resetStats(): Promise<void>;
}

export class RuntimeBackend implements Backend {
  async getSettings(): Promise<UserSettings> {
    return send<UserSettings>('settings:get');
  }

  async saveSettings(patch: Partial<UserSettings>): Promise<void> {
    // CFG-03: merge the PATCH against FRESH storage so concurrent edits from
    // options + popup both survive — neither writer owns the whole blob.
    const stored = (await browser.storage.local.get('local:settings'))['local:settings'];
    const current = migrateSettings(stored, SETTINGS_SCHEMA_VERSION) ?? defaultSettings();
    await browser.storage.local.set({ 'local:settings': { ...current, ...patch } });
  }

  async getRules(): Promise<UserRules> {
    return send<UserRules>('rules:get');
  }

  async getReviewSummaries(): Promise<ReviewSummary[]> {
    const { summaries } = await send<{ summaries: ReviewSummary[]; legacy: ReviewRecord[] }>(
      'review:list',
    );
    return summaries;
  }

  async getReview(): Promise<ReviewRecord[]> {
    // ONLY genuinely-legacy records (pre-IDB rows awaiting migration) belong
    // here; durable summaries flow exclusively through the paginated query
    // (R19/R20) so each record is rendered exactly once.
    const { legacy } = await send<{ summaries: ReviewSummary[]; legacy: ReviewRecord[] }>(
      'review:list',
    );
    return legacy;
  }

  async getStats(): Promise<LocalStats> {
    return send<LocalStats>('stats:get');
  }

  async queryHistory(query: HistoryQuery): Promise<HistoryQueryResult> {
    return send<HistoryQueryResult>('history:query', query);
  }

  async getHistoryEvents(key: string, limit?: number): Promise<ReviewEvent[]> {
    return send<ReviewEvent[]>('history:events', { key, limit });
  }

  async deleteSummaries(
    keys: readonly string[],
  ): Promise<{ deleted: string[]; missing: string[] }> {
    return send<{ deleted: string[]; missing: string[] }>('history:delete', { keys });
  }

  async getSummaries(keys: readonly string[]): Promise<ReviewSummary[]> {
    return send<ReviewSummary[]>('history:getMany', { keys });
  }

  async putSummaries(summaries: readonly ReviewSummary[]): Promise<void> {
    await send('history:putMany', { summaries });
  }

  async restoreSummary(key: string): Promise<boolean> {
    return send<boolean>('history:restore', { key });
  }

  async setCorrection(
    videoId: string,
    dimension: 'notAi' | 'notSlop',
    value: boolean,
  ): Promise<void> {
    await send('correction:set', { videoId, dimension, value });
  }

  async clearHistory(): Promise<void> {
    await send('history:clear');
  }

  async getQuarantine(): Promise<QuarantineItem[]> {
    return send<QuarantineItem[]>('diagnostics:quarantine');
  }

  async clearCache(): Promise<void> {
    await send('data:clear-cache');
  }

  async clearCorrections(): Promise<void> {
    await send('data:clear-corrections');
  }

  async resetStats(): Promise<void> {
    await send('data:reset-stats');
  }
}
