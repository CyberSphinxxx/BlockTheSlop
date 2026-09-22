import type { CorrectionRecord } from '@/domain/history';
import { idbGet, idbPut, idbDelete, type IdbDatabase } from './idb';
import { STORES } from './idb-schema';

/**
 * Durable corrections (R11, 04 §4): per-video Not-AI / Not-slop signals
 * stored independently of review history. Clearing history must never
 * destroy corrections — they are policy-relevant user data.
 */
export class CorrectionStore {
  constructor(private readonly db: IdbDatabase) {}

  async get(videoId: string): Promise<CorrectionRecord | undefined> {
    return this.db.withStore(STORES.corrections, 'readonly', (store) =>
      idbGet<CorrectionRecord>(store, videoId),
    );
  }

  async getMany(videoIds: readonly string[]): Promise<Map<string, CorrectionRecord>> {
    const out = new Map<string, CorrectionRecord>();
    if (videoIds.length === 0) return out;
    await this.db.withStore(STORES.corrections, 'readonly', async (store) => {
      for (const id of videoIds) {
        const record = await idbGet<CorrectionRecord>(store, id);
        if (record !== undefined) out.set(id, record);
      }
    });
    return out;
  }

  /**
   * Merge-set the user's dimensional corrections with a revision check.
   * `expectedRevision` enables optimistic concurrency; a mismatch throws so
   * the caller can re-read and reapply rather than silently overwrite.
   */
  async setDimension(
    videoId: string,
    dimension: 'notAi' | 'notSlop',
    value: boolean,
    options: { expectedRevision?: number | undefined; source?: CorrectionRecord['source'] } = {},
  ): Promise<CorrectionRecord> {
    return this.db.withStore(STORES.corrections, 'readwrite', async (store) => {
      const existing = await idbGet<CorrectionRecord>(store, videoId);
      if (
        options.expectedRevision !== undefined &&
        existing !== undefined &&
        existing.revision !== options.expectedRevision
      ) {
        throw new Error(
          `correction revision conflict for ${videoId}: expected ${options.expectedRevision}, got ${existing.revision}`,
        );
      }
      const record: CorrectionRecord = {
        videoId,
        notAi: dimension === 'notAi' ? value : (existing?.notAi ?? false),
        notSlop: dimension === 'notSlop' ? value : (existing?.notSlop ?? false),
        updatedAt: Date.now(),
        revision: (existing?.revision ?? 0) + 1,
        source: options.source ?? 'user',
      };
      // Pure-false result with no prior record → nothing to persist.
      if (existing === undefined && !record.notAi && !record.notSlop) {
        throw new Error('refusing to persist an empty correction');
      }
      await idbPut(store, record);
      return record;
    });
  }

  async clear(videoId: string): Promise<void> {
    await this.db.withStore(STORES.corrections, 'readwrite', (store) => idbDelete(store, videoId));
  }

  async count(): Promise<number> {
    return this.db.withStore(
      STORES.corrections,
      'readonly',
      (store) =>
        new Promise<number>((resolve, reject) => {
          const request = store.count();
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error ?? new Error('count failed'));
        }),
    );
  }

  /** DATA-08: clear the ENTIRE corrections store (user-initiated only). */
  async clearAll(): Promise<void> {
    await this.db.withStore(STORES.corrections, 'readwrite', (store) => store.clear());
  }
}
