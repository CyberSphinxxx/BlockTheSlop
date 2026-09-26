import type { FilterDecision } from '@/domain/decision';
import {
  MAX_EVENTS_PER_SUMMARY,
  type ReviewEvent,
  type ReviewEventKind,
  type ReviewSummary,
  validateSummary,
} from '@/domain/history';
import {
  idbDelete,
  idbGet,
  idbGetAll,
  idbGetByIndex,
  idbPut,
  openIndexCursor,
  continueIndexCursor,
  type IdbDatabase,
} from './idb';
import { STORES } from './idb-schema';

/**
 * Transactional history repository (R10, 04 §4).
 *
 * Summary upsert + bounded event append + operation record commit in ONE
 * transaction. A duplicate delivery with the same operationId must not
 * double-count observations or reapply outcomes (idempotency contract).
 */

export interface RecordEventInput {
  key: string;
  videoId?: string | undefined;
  title: string;
  channelId?: string | undefined;
  channelName?: string | undefined;
  handle?: string | undefined;
  surface: ReviewSummary['surfaces'][number];
  decision: FilterDecision;
  evidenceSummary?: string | undefined;
  occurredAt: number;
  /** Idempotency id generated BEFORE any retry (04 §4). */
  operationId: string;
}

/** Paged query over summaries (R19/R20, HIS-01..05). */
export interface HistoryQuery {
  /** 1-based page; out-of-range pages clamp to the last valid page. */
  page: number;
  /** One of 10/25/50/100; anything else falls back to 25 (HIS-02). */
  pageSize: number;
  /** Substring match over title/channel/video identity. */
  search?: string | undefined;
  status?: 'all' | ReviewSummary['resolution'] | undefined;
  surface?: 'all' | ReviewSummary['surfaces'][number] | undefined;
  /** Inclusive epoch-ms lower bound (local midnight). */
  from?: number | undefined;
  /** Inclusive epoch-ms upper bound (end of local day). */
  to?: number | undefined;
  /** Stable sorts: ties always break by key (HIS-03). */
  sort?: 'lastSeen-desc' | 'lastSeen-asc' | 'title-asc' | 'count-desc' | undefined;
}

export const HISTORY_PAGE_SIZES: readonly number[] = [10, 25, 50, 100];
export const HISTORY_DEFAULT_PAGE_SIZE = 25;

export interface HistoryQueryResult {
  items: ReviewSummary[];
  /** Exact count of ALL matching summaries (not just this page). */
  total: number;
  /** The page actually returned (clamped when out of range, HIS-07). */
  page: number;
  /** The effective page size (validated). */
  pageSize: number;
}

export interface RecordEventResult {
  key: string;
  /** False when a duplicate delivery was suppressed by operation id. */
  applied: boolean;
  summary: ReviewSummary;
}

const SUMMARY_RETENTION_CAP = 5000;

export class HistoryRepository {
  constructor(private readonly db: IdbDatabase) {}

  /** Record an automatic hide (the recovery-path fact). */
  recordHidden(input: RecordEventInput): Promise<RecordEventResult> {
    return this.recordEvent(input, 'hidden');
  }

  /**
   * Record any review fact atomically: upsert summary, append bounded event,
   * commit operation journal entry. Duplicate operationIds are no-ops.
   */
  async recordEvent(input: RecordEventInput, kind: ReviewEventKind): Promise<RecordEventResult> {
    return this.db.withStores(
      [STORES.reviewSummaries, STORES.reviewEvents, STORES.operations] as const,
      'readwrite',
      async (stores) => {
        const [summaryStore, eventStore, operationStore] = stores;

        // Idempotency: a delivered operation must not apply twice.
        const existingOp = await idbGet<{ operationId: string }>(operationStore, input.operationId);
        if (existingOp !== undefined) {
          const summary = await idbGet<ReviewSummary>(summaryStore, input.key);
          if (summary !== undefined) {
            return { key: input.key, applied: false, summary };
          }
        }

        const existing = await idbGet<ReviewSummary>(summaryStore, input.key);
        const now = input.occurredAt;
        const summary: ReviewSummary = existing ?? {
          key: input.key,
          videoId: input.videoId,
          title: input.title,
          channelId: input.channelId,
          channelName: input.channelName,
          handle: input.handle,
          surfaces: [],
          latestDecision: input.decision,
          resolution: 'pending',
          firstSeen: now,
          lastSeen: now,
          count: 0,
          evidenceSummary: input.evidenceSummary ?? '',
          revision: 0,
        };
        if (input.title.length > 0) summary.title = input.title;
        summary.videoId = input.videoId ?? summary.videoId;
        summary.channelId = input.channelId ?? summary.channelId;
        summary.channelName = input.channelName ?? summary.channelName;
        summary.handle = input.handle ?? summary.handle;
        if (!summary.surfaces.includes(input.surface)) summary.surfaces.push(input.surface);
        summary.latestDecision = input.decision;
        summary.lastSeen = now;
        // `count` is documented as "times (re)hidden across sessions": only
        // hide events observe content again; policy transitions do not.
        if (kind === 'hidden') summary.count += 1;
        summary.revision += 1;
        summary.evidenceSummary = input.evidenceSummary ?? summary.evidenceSummary;
        summary.resolution =
          kind === 'hidden'
            ? 'pending'
            : kind === 'restored'
              ? 'restored'
              : kind === 'correction'
                ? 'corrected'
                : 'allowed';
        await idbPut(summaryStore, summary);

        const event: ReviewEvent = {
          eventId: `${input.key}|${now.toString(36)}|${input.operationId}`,
          summaryKey: input.key,
          occurredAt: now,
          kind,
          decisionSnapshot: input.decision,
          operationId: input.operationId,
        };
        await idbPut(eventStore, event);

        // Bound events per summary: drop oldest beyond the cap.
        const keyRange = IDBKeyRange.bound([input.key], [input.key, '\uffff']);
        const all = await idbGetByIndex<ReviewEvent>(eventStore.index('bySummary'), keyRange);
        const ordered = [...all].sort((a, b) => a.occurredAt - b.occurredAt);
        const excess = ordered.length - MAX_EVENTS_PER_SUMMARY;
        if (excess > 0) {
          for (const stale of ordered.slice(0, excess)) {
            await idbDelete(eventStore, stale.eventId);
          }
        }

        await idbPut(operationStore, {
          operationId: input.operationId,
          commandType: kind,
          committedAt: now,
        });

        return { key: input.key, applied: true, summary };
      },
    );
  }

  /**
   * Paged, filtered, sorted summaries with the EXACT total (R19/R20).
   * The store is retention-bounded (5000), so one in-transaction scan with
   * JS filtering is correct and predictable; IDB indexes cannot express the
   * text/status/date intersections this query needs.
   */
  async querySummaries(query: HistoryQuery): Promise<HistoryQueryResult> {
    const pageSize = HISTORY_PAGE_SIZES.includes(query.pageSize)
      ? query.pageSize
      : HISTORY_DEFAULT_PAGE_SIZE;
    return this.db.withStore(STORES.reviewSummaries, 'readonly', async (store) => {
      // N06 (corrupt rows): rows from older builds or interrupted writes must
      // never crash the query or surface as broken UI rows. Invalid rows are
      // skipped (never deleted — deleting unparseable rows could destroy
      // recoverable user data); validateSummary also normalizes valid rows.
      const raw = await idbGetAll<unknown>(store);
      const all = raw.reduce<ReviewSummary[]>((acc, row) => {
        const summary = validateSummary(row);
        if (summary !== null) acc.push(summary);
        return acc;
      }, []);
      const search = (query.search ?? '').trim().toLowerCase();
      const status = query.status ?? 'all';
      const surface = query.surface ?? 'all';

      const filtered = all.filter((summary) => {
        if (status !== 'all' && summary.resolution !== status) return false;
        if (surface !== 'all' && !summary.surfaces.includes(surface)) return false;
        if (query.from !== undefined && summary.lastSeen < query.from) return false;
        if (query.to !== undefined && summary.lastSeen > query.to) return false;
        if (search.length > 0) {
          const haystack = [
            summary.title,
            summary.channelName ?? '',
            summary.channelId ?? '',
            summary.handle ?? '',
            summary.videoId ?? '',
          ]
            .join('\u0000')
            .toLowerCase();
          if (!haystack.includes(search)) return false;
        }
        return true;
      });

      // Stable sorts with an explicit key tie-break (HIS-03): no missing or
      // duplicated rows across pages even when sort values tie.
      const sort = query.sort ?? 'lastSeen-desc';
      const sorted = [...filtered].sort((a, b) => {
        switch (sort) {
          case 'lastSeen-asc':
            return a.lastSeen - b.lastSeen || a.key.localeCompare(b.key);
          case 'title-asc': {
            // Titles sort case-insensitively; empty titles sort last.
            const at = (a.title ?? '').trim().toLowerCase();
            const bt = (b.title ?? '').trim().toLowerCase();
            if (at.length === 0 && bt.length === 0) return a.key.localeCompare(b.key);
            if (at.length === 0) return 1;
            if (bt.length === 0) return -1;
            return at.localeCompare(bt) || a.key.localeCompare(b.key);
          }
          case 'count-desc':
            return b.count - a.count || a.key.localeCompare(b.key);
          case 'lastSeen-desc':
          default:
            return b.lastSeen - a.lastSeen || a.key.localeCompare(b.key);
        }
      });

      const total = sorted.length;
      if (total === 0) {
        return { items: [], total: 0, page: 1, pageSize };
      }
      const maxPage = Math.ceil(total / pageSize);
      const page = Math.min(Math.max(1, Math.floor(query.page)), maxPage);
      const start = (page - 1) * pageSize;
      return {
        items: sorted.slice(start, start + pageSize),
        total,
        page,
        pageSize,
      };
    });
  }

  async getSummary(key: string): Promise<ReviewSummary | undefined> {
    return this.db.withStore(STORES.reviewSummaries, 'readonly', (store) =>
      idbGet<ReviewSummary>(store, key),
    );
  }

  /** Summaries ordered by lastSeen (newest first), bounded. */
  async listSummaries(limit: number): Promise<ReviewSummary[]> {
    return this.db.withStore(STORES.reviewSummaries, 'readonly', async (store) => {
      const request = openIndexCursor(store.index('lastSeen'), undefined, 'prev');
      let cursor = await new Promise<IDBCursorWithValue | null>((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error ?? new Error('cursor failed'));
      });
      const out: ReviewSummary[] = [];
      while (cursor !== null && out.length < limit) {
        out.push(cursor.value as ReviewSummary);
        cursor = await continueIndexCursor(request, cursor);
      }
      return out;
    });
  }

  async countSummaries(): Promise<number> {
    return this.db.withStore(
      STORES.reviewSummaries,
      'readonly',
      (store) =>
        new Promise<number>((resolve, reject) => {
          const request = store.count();
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error ?? new Error('count failed'));
        }),
    );
  }

  /** Newest-first events for one summary. */
  async eventsFor(key: string, limit: number): Promise<ReviewEvent[]> {
    return this.db.withStore(STORES.reviewEvents, 'readonly', async (store) => {
      const range = IDBKeyRange.bound([key], [key, '\uffff']);
      const all = await idbGetByIndex<ReviewEvent>(store.index('bySummary'), range);
      return all.sort((a, b) => b.occurredAt - a.occurredAt).slice(0, limit);
    });
  }

  /**
   * Clear review history ONLY (summaries + events + operation journal).
   * Corrections live in their own store and survive this call (R11).
   */
  async clearHistory(): Promise<void> {
    await this.db.withStores(
      [STORES.reviewSummaries, STORES.reviewEvents, STORES.operations] as const,
      'readwrite',
      async (stores) => {
        await Promise.all([
          new Promise<void>((resolve, reject) => {
            const request = stores[0].clear();
            request.onsuccess = () => resolve();
            request.onerror = () => reject(request.error ?? new Error('clear failed'));
          }),
          new Promise<void>((resolve, reject) => {
            const request = stores[1].clear();
            request.onsuccess = () => resolve();
            request.onerror = () => reject(request.error ?? new Error('clear failed'));
          }),
          new Promise<void>((resolve, reject) => {
            const request = stores[2].clear();
            request.onsuccess = () => resolve();
            request.onerror = () => reject(request.error ?? new Error('clear failed'));
          }),
        ]);
      },
    );
  }

  /** Bounded retention: drop oldest summaries beyond the cap. */
  async enforceSummariesRetention(cap: number = SUMMARY_RETENTION_CAP): Promise<number> {
    const count = await this.countSummaries();
    if (count <= cap) return 0;
    const victims = await this.db.withStore(STORES.reviewSummaries, 'readwrite', async (store) => {
      const request = openIndexCursor(store.index('lastSeen'), undefined, 'prev');
      let cursor = await new Promise<IDBCursorWithValue | null>((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error ?? new Error('cursor failed'));
      });
      const out: string[] = [];
      let seen = 0;
      while (cursor !== null) {
        const summary = validateSummary(cursor.value);
        if (summary !== null) {
          seen += 1;
          if (seen > cap) out.push(summary.key);
        }
        cursor = await continueIndexCursor(request, cursor);
      }
      return out;
    });
    for (const key of victims) await this.deleteSummaryCascade(key);
    return victims.length;
  }

  /**
   * Age retention (DATA-07): drop summaries not seen within `retentionDays`.
   * Deterministic boundary (lastSeen <= now - days), oldest-first by the
   * `lastSeen` index; a future lastSeen (clock skew) is never pruned.
   */
  async enforceAgeRetention(retentionDays: number, now: number = Date.now()): Promise<number> {
    const days = Math.max(1, Math.round(retentionDays));
    const cutoff = now - days * 24 * 60 * 60 * 1000;
    const victims = await this.db.withStore(STORES.reviewSummaries, 'readwrite', async (store) => {
      const request = openIndexCursor(store.index('lastSeen'), undefined, 'next');
      let cursor = await new Promise<IDBCursorWithValue | null>((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error ?? new Error('cursor failed'));
      });
      const out: string[] = [];
      while (cursor !== null) {
        const summary = validateSummary(cursor.value);
        // Corrupt rows are skipped, not deleted; they cannot break the scan.
        if (summary !== null) {
          // Boundary is exclusive-prune: exactly-at-cutoff records survive.
          if (summary.lastSeen >= cutoff) break; // index is ascending: rest are newer
          out.push(summary.key);
        }
        cursor = await continueIndexCursor(request, cursor);
      }
      return out;
    });
    for (const key of victims) await this.deleteSummaryCascade(key);
    return victims.length;
  }

  /** Delete a summary and its events. */
  async deleteSummaryCascade(key: string): Promise<void> {
    await this.db.withStores(
      [STORES.reviewSummaries, STORES.reviewEvents] as const,
      'readwrite',
      async (stores) => {
        const events = await idbGetByIndex<ReviewEvent>(
          stores[1].index('bySummary'),
          IDBKeyRange.bound([key], [key, '\uffff']),
        );
        for (const event of events) await idbDelete(stores[1], event.eventId);
        await idbDelete(stores[0], key);
      },
    );
  }

  /**
   * Apply a resolution transition (restore / correction / re-pend for undo)
   * WITHOUT counting a new observation. No-ops when the summary is gone.
   */
  async setResolution(
    key: string,
    resolution: ReviewSummary['resolution'],
    kind: ReviewEventKind,
    at: number,
    operationId: string,
  ): Promise<boolean> {
    const existing = await this.getSummary(key);
    if (existing === undefined) return false;
    await this.recordEvent(
      {
        key,
        title: existing.title,
        surface: existing.surfaces[0] ?? 'unknown',
        decision: existing.latestDecision,
        occurredAt: at,
        operationId,
      },
      kind === 'hidden' ? 'reshown' : kind,
    );
    // Force the requested resolution (recordEvent maps kinds; undo needs a
    // specific target that may differ, e.g. back to 'pending').
    return this.db.withStore(STORES.reviewSummaries, 'readwrite', async (store) => {
      const summary = await idbGet<ReviewSummary>(store, key);
      if (summary === undefined) return false;
      summary.resolution = resolution;
      await idbPut(store, summary);
      return true;
    });
  }

  /** Delete several summaries (bulk action, HIS-14..16). */
  async deleteSummariesCascade(keys: readonly string[]): Promise<number> {
    let deleted = 0;
    for (const key of keys) {
      const existing = await this.getSummary(key);
      if (existing === undefined) continue;
      await this.deleteSummaryCascade(key);
      deleted += 1;
    }
    return deleted;
  }

  /**
   * Re-insert summaries verbatim (bounded undo of a bulk delete, HIS-16;
   * import merge, N06). Rows that fail structural validation are skipped so
   * a hostile or stale import can never poison the durable store.
   */
  async putSummaries(summaries: readonly ReviewSummary[]): Promise<number> {
    return this.db.withStore(STORES.reviewSummaries, 'readwrite', async (store) => {
      let skipped = 0;
      for (const candidate of summaries) {
        const summary = validateSummary(candidate);
        if (summary === null) {
          skipped += 1;
          continue;
        }
        await idbPut(store, summary);
      }
      return skipped;
    });
  }

  /**
   * Restore one summary (review action) as a durable, idempotent fact.
   * No-ops when the summary does not exist — restores never create history.
   */
  async markRestored(
    key: string,
    decision: FilterDecision,
    at: number,
    operationId: string,
  ): Promise<boolean> {
    const existing = await this.getSummary(key);
    if (existing === undefined) return false;
    await this.recordEvent(
      {
        key,
        title: existing.title,
        surface: existing.surfaces[0] ?? 'unknown',
        decision,
        occurredAt: at,
        operationId,
      },
      'restored',
    );
    return true;
  }
}
