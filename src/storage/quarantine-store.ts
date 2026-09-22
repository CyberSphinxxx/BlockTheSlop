import { QUARANTINE_MAX_ITEMS, type QuarantineItem } from '@/domain/history';
import { idbGetAll, idbPut, type IdbDatabase } from './idb';
import { STORES } from './idb-schema';

/**
 * Quarantine (04 §6): records rejected during migration/import are kept
 * bounded and exportable — never silently discarded, never shown as data.
 */
export class QuarantineStore {
  constructor(private readonly db: IdbDatabase) {}

  async add(
    item: Omit<QuarantineItem, 'id' | 'occurredAt'> & { occurredAt?: number | undefined },
  ): Promise<void> {
    const record: QuarantineItem = {
      id: `q-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e9).toString(36)}`,
      reason: item.reason,
      source: item.source,
      preview: item.preview,
      occurredAt: item.occurredAt ?? Date.now(),
    };
    await this.db.withStore(STORES.quarantine, 'readwrite', (store) => idbPut(store, record));
    await this.enforceCap();
  }

  async list(limit: number = QUARANTINE_MAX_ITEMS): Promise<QuarantineItem[]> {
    return this.db.withStore(STORES.quarantine, 'readonly', (store) =>
      idbGetAll<QuarantineItem>(store, undefined, limit),
    );
  }

  async count(): Promise<number> {
    const items = await this.list(QUARANTINE_MAX_ITEMS);
    return items.length;
  }

  async clear(): Promise<void> {
    await this.db.withStore(
      STORES.quarantine,
      'readwrite',
      (store) =>
        new Promise<void>((resolve, reject) => {
          const request = store.clear();
          request.onsuccess = () => resolve();
          request.onerror = () => reject(request.error ?? new Error('clear failed'));
        }),
    );
  }

  private async enforceCap(): Promise<void> {
    const items = await this.list();
    if (items.length <= QUARANTINE_MAX_ITEMS) return;
    const stale = items.sort((a, b) => a.occurredAt - b.occurredAt);
    const excess = stale.slice(0, stale.length - QUARANTINE_MAX_ITEMS);
    await this.db.withStore(STORES.quarantine, 'readwrite', async (store) => {
      for (const item of excess) {
        await new Promise<void>((resolve, reject) => {
          const request = store.delete(item.id);
          request.onsuccess = () => resolve();
          request.onerror = () => reject(request.error ?? new Error('delete failed'));
        });
      }
    });
  }
}
