import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import 'fake-indexeddb/auto';
import { HistoryRepository } from '@/storage/history-repository';
import { openExtensionDb, IDB_SCHEMA_VERSION } from '@/storage/idb-schema';
import type { IdbDatabase } from '@/storage/idb';
import type { FilterDecision } from '@/domain/decision';

/**
 * QA-16 + DATA-02: counters and retries.
 *
 * - QA-16: repeated hides of the SAME video at the SAME observed time share an
 *   operation id and must not inflate `count`; a NEW observation (new op id)
 *   legitimately counts again. Restores/corrections never bump `count`.
 * - DATA-02: a duplicate delivery AFTER a durable commit returns the committed
 *   summary with `applied: false` (retry-safe acknowledgement).
 */

const hideDecision: FilterDecision = {
  action: 'hide',
  reason: 'automatic',
  explanation: ['test'],
};

describe('QA-16 counters over repeated scans and retries', () => {
  let db: IdbDatabase;
  let history: HistoryRepository;

  beforeEach(async () => {
    db = await openExtensionDb();
    history = new HistoryRepository(db);
  });

  afterEach(() => {
    db.close();
    Object.defineProperty(globalThis, 'indexedDB', {
      value: new IDBFactory(),
      configurable: true,
      writable: true,
    });
  });

  it('duplicate operation id does not inflate count; new observation does', async () => {
    const input = {
      key: 'v:qa16',
      videoId: 'qa16',
      title: 'QA16 title',
      surface: 'home' as const,
      decision: hideDecision,
      occurredAt: 1_000,
      operationId: 'hide:qa16:1000',
    };
    await history.recordHidden(input);
    await history.recordHidden({ ...input }); // scan/rescan retry — same op id
    await history.recordHidden({ ...input }); // and again
    const summary = await history.getSummary('v:qa16');
    expect(summary?.count).toBe(1);
    expect(summary?.revision).toBe(1);

    await history.recordHidden({
      ...input,
      occurredAt: 5_000,
      operationId: 'hide:qa16:5000',
    });
    const afterNew = await history.getSummary('v:qa16');
    expect(afterNew?.count).toBe(2); // a genuinely new observation counts
  });

  it('restore and correction transitions never count as new hides', async () => {
    await history.recordHidden({
      key: 'v:qa16b',
      videoId: 'qa16b',
      title: 'QA16B title',
      surface: 'home' as const,
      decision: hideDecision,
      occurredAt: 1_000,
      operationId: 'op-1',
    });
    await history.setResolution('v:qa16b', 'restored', 'restored', 2_000, 'op-2');
    await history.setResolution('v:qa16b', 'corrected', 'correction', 3_000, 'op-3');
    await history.setResolution('v:qa16b', 'pending', 'reshown', 4_000, 'op-4');
    const summary = await history.getSummary('v:qa16b');
    expect(summary?.count).toBe(1); // exactly the one hide
  });
});

describe('DATA-02 duplicate delivery after durable commit', () => {
  it('returns the committed summary with applied:false once the op exists', async () => {
    const db2 = await openExtensionDb();
    try {
      const history = new HistoryRepository(db2);
      expect(IDB_SCHEMA_VERSION).toBeGreaterThan(0);
      const input = {
        key: 'v:data02',
        videoId: 'data02',
        title: 'DATA02 title',
        surface: 'search' as const,
        decision: hideDecision,
        occurredAt: 777,
        operationId: 'hide:data02:777',
      };
      const first = await history.recordHidden(input);
      expect(first.applied).toBe(true);
      const second = await history.recordHidden({ ...input, occurredAt: 999 });
      expect(second.applied).toBe(false);
      expect(second.summary.count).toBe(first.summary.count);
      expect(second.summary.lastSeen).toBe(first.summary.lastSeen);
    } finally {
      db2.close();
    }
  });
});
