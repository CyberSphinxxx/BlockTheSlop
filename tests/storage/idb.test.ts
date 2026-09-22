import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  openExtensionDb,
  STORES,
  putMeta,
  getMeta,
  IDB_SCHEMA_VERSION,
} from '@/storage/idb-schema';
import { idbPut, type IdbDatabase } from '@/storage/idb';
import { HistoryRepository } from '@/storage/history-repository';
import { CorrectionStore } from '@/storage/correction-store';
import { ClassificationCacheRepository, cacheKeyFor } from '@/storage/classification-cache-repo';
import { QuarantineStore } from '@/storage/quarantine-store';
import { migrateLegacyStorage } from '@/storage/idb-migrations';
import { StorageService } from '@/storage/service';
import { MemoryKVStore, type KVStore } from '@/storage/db';
import { classificationFingerprint } from '@/storage/fingerprint';
import type { FilterDecision } from '@/domain/decision';
import type { NormalizedVideoCandidate } from '@/domain/video';
import type { Classification } from '@/domain/classification';
import type { ReviewRecord } from '@/domain/review';

// fake-indexeddb dispatches events on the microtask queue; a macrotask wait
// makes transaction completion observable deterministically.
const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

const decision: FilterDecision = {
  action: 'hide',
  reason: 'automatic',
  explanation: ['Matched official disclosure'],
};

const baseCandidate: NormalizedVideoCandidate = {
  videoId: 'vid1',
  title: 'AI slop video',
  channel: { channelId: 'UC0000000000000000000001', displayName: 'Slop Co' },
  surface: 'home',
  cardKind: 'video',
  badges: [],
  ariaLabels: [],
  metadataText: [],
  isShort: false,
  observedAt: 1_700_000_000_000,
};

const classification: Classification = {
  aiLikelihood: 0.9,
  slopLikelihood: 0.85,
  categories: {},
  confidence: 'high',
  evidence: [],
  classifierVersion: '1',
  rulesVersion: '1',
  evaluatedAt: 1_700_000_000_000,
};

let db: IdbDatabase;

beforeEach(async () => {
  db = await openExtensionDb();
});

afterEach(() => {
  db.close();
  // Separate databases per test avoid cross-test index/state bleed.
  Object.defineProperty(globalThis, 'indexedDB', {
    value: new IDBFactory(),
    configurable: true,
    writable: true,
  });
});

describe('IDB schema and wrapper', () => {
  it('creates the v1 schema with all required stores and indexes', async () => {
    expect(db.version).toBe(IDB_SCHEMA_VERSION);
    for (const name of Object.values(STORES)) {
      expect(db.storeNames()).toContain(name);
    }
    await db.withStore(STORES.reviewSummaries, 'readonly', (store) => {
      expect(Array.from(store.indexNames)).toContain('lastSeen');
      expect(Array.from(store.indexNames)).toContain('videoId');
    });
  });

  it('rejects a database whose meta marker is newer than supported', async () => {
    // A newer build can record a higher schemaVersion in meta (schema-only
    // change); this build must refuse to touch the data, not corrupt it.
    await putMeta(db, 'db', { schemaVersion: IDB_SCHEMA_VERSION + 1 });
    db.close();
    await expect(openExtensionDb()).rejects.toThrow(/newer than supported/);
  });

  it('withStores resolves only after durable commit and returns the callback value', async () => {
    const result = await db.withStores([STORES.meta] as const, 'readwrite', async (stores) => {
      await idbPut(stores[0], { key: 'k', value: 1 });
      return 'ok';
    });
    expect(result).toBe('ok');
    await tick();
    const stored = await getMeta<number>(db, 'k');
    expect(stored).toBe(1);
  });

  it('aborts a transaction on callback error and leaves data untouched', async () => {
    await putMeta(db, 'before', { v: 1 });
    await expect(
      db.withStore(STORES.meta, 'readwrite', async (store) => {
        await idbPut(store, { key: 'after', value: 2 });
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    await tick();
    expect(await getMeta(db, 'after')).toBeUndefined();
    expect(await getMeta<{ v: number }>(db, 'before')).toEqual({ v: 1 });
  });
});

describe('HistoryRepository (R10)', () => {
  const repo = () => new HistoryRepository(db);

  it('records a hide as summary + event + operation atomically', async () => {
    const result = await repo().recordHidden({
      key: 'v:vid1',
      videoId: 'vid1',
      title: 'AI slop video',
      channelId: 'UC0000000000000000000001',
      channelName: 'Slop Co',
      surface: 'home',
      decision,
      evidenceSummary: 'official disclosure',
      occurredAt: 1_700_000_000_000,
      operationId: 'op-1',
    });
    expect(result.applied).toBe(true);
    const summary = await repo().getSummary('v:vid1');
    expect(summary?.count).toBe(1);
    expect(summary?.resolution).toBe('pending');
    const events = await repo().eventsFor('v:vid1', 10);
    expect(events).toHaveLength(1);
    expect(events[0]?.operationId).toBe('op-1');
  });

  it('suppresses duplicate deliveries with the same operationId (idempotency)', async () => {
    const input = {
      key: 'v:vid1',
      videoId: 'vid1',
      title: 'AI slop video',
      surface: 'home' as const,
      decision,
      occurredAt: 1_700_000_000_000,
      operationId: 'op-dup',
    };
    await repo().recordHidden(input);
    const second = await repo().recordHidden(input);
    expect(second.applied).toBe(false);
    const summary = await repo().getSummary('v:vid1');
    expect(summary?.count).toBe(1);
    expect(await repo().eventsFor('v:vid1', 10)).toHaveLength(1);
  });

  it('merges repeated observations: count grows, firstSeen/lastSeen bound', async () => {
    const r = repo();
    await r.recordHidden({
      key: 'v:v',
      title: 't',
      surface: 'home',
      decision,
      occurredAt: 100,
      operationId: 'a',
    });
    await r.recordHidden({
      key: 'v:v',
      title: 't',
      surface: 'search',
      decision,
      occurredAt: 300,
      operationId: 'b',
    });
    const summary = await r.getSummary('v:v');
    expect(summary?.count).toBe(2);
    expect(summary?.firstSeen).toBe(100);
    expect(summary?.lastSeen).toBe(300);
    expect(summary?.surfaces).toEqual(expect.arrayContaining(['home', 'search']));
  });

  it('bounds events per summary to the cap (oldest dropped)', async () => {
    const r = repo();
    for (let i = 0; i < 25; i++) {
      await r.recordHidden({
        key: 'v:loop',
        title: 't',
        surface: 'home',
        decision,
        occurredAt: i,
        operationId: `op-${i}`,
      });
    }
    const events = await r.eventsFor('v:loop', 100);
    expect(events.length).toBeLessThanOrEqual(20);
    // The dropped events are the OLDEST ones.
    const times = events.map((e) => e.occurredAt);
    expect(Math.min(...times)).toBeGreaterThanOrEqual(5);
  });

  it('restore applies only to an existing summary and never creates one', async () => {
    const r = repo();
    const missing = await r.markRestored('v:ghost', decision, 500, 'r-1');
    expect(missing).toBe(false);
    await r.recordHidden({
      key: 'v:here',
      title: 't',
      surface: 'home',
      decision,
      occurredAt: 1,
      operationId: 'x',
    });
    const done = await r.markRestored('v:here', decision, 500, 'r-2');
    expect(done).toBe(true);
    expect((await r.getSummary('v:here'))?.resolution).toBe('restored');
    const duplicate = await r.markRestored('v:here', decision, 500, 'r-2');
    expect(duplicate).toBe(true);
    // Idempotent: still exactly 2 events (hidden + restored).
    expect(await r.eventsFor('v:here', 10)).toHaveLength(2);
  });

  it('clearHistory removes summaries+events+operations in one transaction', async () => {
    const r = repo();
    await r.recordHidden({
      key: 'v:c',
      title: 't',
      surface: 'home',
      decision,
      occurredAt: 1,
      operationId: 'o',
    });
    await r.clearHistory();
    expect(await r.countSummaries()).toBe(0);
    expect(await r.eventsFor('v:c', 10)).toHaveLength(0);
  });

  it('listSummaries returns newest-lastSeen first with a limit', async () => {
    const r = repo();
    await r.recordHidden({
      key: 'v:a',
      title: 'a',
      surface: 'home',
      decision,
      occurredAt: 10,
      operationId: '1',
    });
    await r.recordHidden({
      key: 'v:b',
      title: 'b',
      surface: 'home',
      decision,
      occurredAt: 20,
      operationId: '2',
    });
    await r.recordHidden({
      key: 'v:c',
      title: 'c',
      surface: 'home',
      decision,
      occurredAt: 30,
      operationId: '3',
    });
    const list = await r.listSummaries(2);
    expect(list.map((s) => s.key)).toEqual(['v:c', 'v:b']);
  });
});

describe('CorrectionStore (R11 durability)', () => {
  const store = () => new CorrectionStore(db);

  it('setDimension merges dimensions and bumps revision', async () => {
    const s = store();
    await s.setDimension('vid1', 'notAi', true);
    const afterSlop = await s.setDimension('vid1', 'notSlop', true);
    expect(afterSlop.notAi).toBe(true);
    expect(afterSlop.notSlop).toBe(true);
    expect(afterSlop.revision).toBe(2);
  });

  it('rejects optimistic-concurrency conflicts on expectedRevision', async () => {
    const s = store();
    const created = await s.setDimension('vid1', 'notAi', true);
    await expect(
      s.setDimension('vid1', 'notAi', false, { expectedRevision: created.revision - 1 }),
    ).rejects.toThrow(/revision conflict/);
  });

  it('survives history clears: corrections store is untouched by clearHistory', async () => {
    const corrections = store();
    const history = new HistoryRepository(db);
    await corrections.setDimension('vid1', 'notAi', true);
    await history.recordHidden({
      key: 'v:vid1',
      title: 't',
      surface: 'home',
      decision,
      occurredAt: 1,
      operationId: 'o',
    });

    await history.clearHistory();

    expect(await history.countSummaries()).toBe(0);
    const correction = await corrections.get('vid1');
    expect(correction?.notAi).toBe(true);
  });
});

describe('ClassificationCacheRepository (R12 fingerprints)', () => {
  const repo = () => new ClassificationCacheRepository(db);
  const input = {
    ...classificationFingerprintInput(baseCandidate),
  };

  function classificationFingerprintInput(c: NormalizedVideoCandidate) {
    return {
      videoId: c.videoId,
      title: c.title,
      description: c.description,
      badges: c.badges,
      ariaLabels: c.ariaLabels,
      metadataText: c.metadataText,
      officialDisclosurePresent: c.officialDisclosure?.present ?? false,
      isShort: c.isShort,
      locale: '',
    };
  }

  it('round-trips a classification by fingerprint + versions', async () => {
    const r = repo();
    await r.put(input, classification, '1');
    const hit = await r.get(input, '1');
    expect(hit?.aiLikelihood).toBe(0.9);
  });

  it('misses when the rules version differs (stale evidence is not served)', async () => {
    const r = repo();
    await r.put(input, classification, '1');
    expect(await r.get(input, '2')).toBeUndefined();
  });

  it('misses when evidence hydrates (fingerprint changes)', async () => {
    const r = repo();
    await r.put(input, classification, '1');
    const hydrated = { ...input, description: 'now a description exists' };
    expect(await r.get(hydrated, '1')).toBeUndefined();
  });

  it('enforceRetention purges expired entries and caps size', async () => {
    const r = repo();
    const oldInput = { ...input, videoId: 'old' };
    await r.put(oldInput, classification, '1');
    // Force expiry by rewriting expiresAt directly.
    const key = cacheKeyFor(classificationFingerprint(oldInput), '1');
    await db.withStore(STORES.classificationCache, 'readwrite', (store) => {
      const request = store.get(key);
      return new Promise<void>((resolve) => {
        request.onsuccess = () => {
          const entry = request.result as { expiresAt: number } | undefined;
          if (entry) store.put({ ...entry, expiresAt: 1 });
          resolve();
        };
      });
    });
    await tick();
    const removed = await r.enforceRetention();
    expect(removed).toBeGreaterThanOrEqual(1);
    expect(await r.get(oldInput, '1')).toBeUndefined();
  });
});

describe('Legacy migration (R13)', () => {
  interface MigrationHarness {
    kv: KVStore;
    serviceDeps: Parameters<typeof migrateLegacyStorage>[0];
  }

  async function harness(legacyRecords: unknown): Promise<MigrationHarness> {
    const kv = new MemoryKVStore();
    if (legacyRecords !== undefined) await kv.set('local:reviewRecords', legacyRecords);
    return {
      kv,
      serviceDeps: {
        kv,
        db,
        history: new HistoryRepository(db),
        corrections: new CorrectionStore(db),
        quarantine: new QuarantineStore(db),
      },
    };
  }

  const legacyRecord = (overrides: Partial<ReviewRecord>): ReviewRecord => ({
    id: `rv-${overrides.videoId ?? 'x'}`,
    videoId: 'vidX',
    title: 'Legacy hidden video',
    channelId: 'UC0000000000000000000002',
    channelName: 'Legacy channel',
    surface: 'home',
    decision,
    createdAt: 1_600_000_000_000,
    ...overrides,
  });

  it('is a no-op when no legacy data exists', async () => {
    const { kv, serviceDeps } = await harness(undefined);
    const result = await migrateLegacyStorage(serviceDeps);
    expect(result.status).toBe('not-needed');
    expect(await kv.get('local:reviewRecords')).toBeUndefined();
  });

  it('migrates summaries + extracts corrections across all legacy records', async () => {
    const records = [
      legacyRecord({ id: 'r1', videoId: 'vid1' }),
      legacyRecord({ id: 'r2', videoId: 'vid1', createdAt: 1_600_000_100_000 }),
      legacyRecord({ id: 'r3', videoId: 'vid2', correction: ['not-ai'] }),
    ];
    const { kv, serviceDeps } = await harness(records);
    const result = await migrateLegacyStorage(serviceDeps);
    expect(result.status).toBe('complete');
    expect(result.verified).toBe(true);
    expect(result.summaries).toBe(2);
    expect(result.corrections).toBe(1);

    const history = new HistoryRepository(db);
    expect(await history.countSummaries()).toBe(2);
    const summary = await history.getSummary('v:vid1');
    expect(summary?.count).toBe(2); // merged
    expect(summary?.firstSeen).toBe(1_600_000_000_000);
    const correction = await new CorrectionStore(db).get('vid2');
    expect(correction?.notAi).toBe(true);
    expect(correction?.source).toBe('migrated');

    // Legacy keys removed only after verified commit.
    expect(await kv.get('local:reviewRecords')).toBeUndefined();
  });

  it('is idempotent: re-running after completion does not duplicate', async () => {
    const records = [legacyRecord({ id: 'r1', videoId: 'vid1' })];
    const { serviceDeps } = await harness(records);
    await migrateLegacyStorage(serviceDeps);
    const history = new HistoryRepository(db);
    const countAfterFirst = await history.countSummaries();
    const result = await migrateLegacyStorage(serviceDeps);
    expect(result.status).toBe('already-complete');
    expect(await history.countSummaries()).toBe(countAfterFirst);
    expect(await history.eventsFor('v:vid1', 50)).toHaveLength(1);
  });

  it('quarantines invalid records instead of discarding or crashing', async () => {
    const records = [
      legacyRecord({ id: 'good', videoId: 'vid1' }),
      { id: 'bad', decision: { action: 'explode' } }, // invalid decision
      'not-even-an-object',
    ];
    const { serviceDeps } = await harness(records);
    const result = await migrateLegacyStorage(serviceDeps);
    expect(result.status).toBe('complete');
    expect(result.quarantined).toBeGreaterThanOrEqual(1);
    const quarantine = new QuarantineStore(db);
    expect(await quarantine.count()).toBeGreaterThanOrEqual(1);
    const items = await quarantine.list();
    expect(items.every((i) => typeof i.preview === 'string' && i.preview.length <= 200)).toBe(true);
  });

  it('retains a bounded rollback backup and reports pending cleanup once', async () => {
    const records = [legacyRecord({ id: 'r1', videoId: 'vid1' })];
    const { kv, serviceDeps } = await harness(records);
    const first = await migrateLegacyStorage(serviceDeps);
    expect(first.status).toBe('complete');
    expect(first.verified).toBe(true);
    // Backup was retained with the complete marker.
    const journal = await getMeta<{ backupRetained?: boolean }>(db, 'legacyStorageMigration');
    expect(journal?.backupRetained).toBe(true);
    // A second startup verifies and clears the backup.
    const second = await migrateLegacyStorage(serviceDeps);
    expect(['already-complete', 'verified-pending-cleanup']).toContain(second.status);
    const journalAfter = await getMeta<{ backupRetained?: boolean }>(db, 'legacyStorageMigration');
    expect(journalAfter?.backupRetained).toBe(false);
    expect(await kv.get('local:reviewRecords')).toBeUndefined();
  });
});

describe('StorageService facade', () => {
  it('degrades to no-ops when IndexedDB is unavailable (fail open)', async () => {
    const original = globalThis.indexedDB;
    Object.defineProperty(globalThis, 'indexedDB', {
      value: undefined,
      configurable: true,
      writable: true,
    });
    try {
      const service = new StorageService();
      await service.recordHidden({
        videoId: 'v',
        title: 't',
        surface: 'home',
        decision,
        occurredAt: 1,
        operationId: 'x',
        sessionKey: 's',
      });
      expect(await service.listRecentSummaries(5)).toEqual([]);
      expect(await service.countSummaries()).toBe(0);
      expect(await service.getCorrectionSignals('v')).toEqual({ notAi: false, notSlop: false });
      expect(await service.countCorrections()).toBe(0);
      await service.clearHistory(); // must not throw
      expect(await service.markRestored('v:v')).toBe(false);
    } finally {
      Object.defineProperty(globalThis, 'indexedDB', {
        value: original,
        configurable: true,
        writable: true,
      });
    }
  });

  it('records hides and restores them through the merged review surface', async () => {
    const service = new StorageService();
    await service.ensureMigration();
    await service.recordHidden({
      videoId: 'vid9',
      title: 'Slop',
      surface: 'home',
      decision,
      occurredAt: 1_700_000_000_000,
      operationId: 'svc-1',
      sessionKey: 'sess',
    });
    const summaries = await service.listRecentSummaries(10);
    expect(summaries.map((s) => s.key)).toContain('v:vid9');
    expect(await service.markRestored('v:vid9')).toBe(true);
    const after = await service.listRecentSummaries(10);
    expect(after.find((s) => s.key === 'v:vid9')?.resolution).toBe('restored');
  });

  it('clearHistory keeps corrections (R11 end-to-end)', async () => {
    const service = new StorageService();
    await service.ensureMigration();
    await service.recordHidden({
      videoId: 'vidK',
      title: 'K',
      surface: 'home',
      decision,
      occurredAt: 1,
      operationId: 'svc-k',
      sessionKey: 's',
    });
    await service.setCorrection('vidK', 'notSlop', true);
    await service.clearHistory();
    expect(await service.countSummaries()).toBe(0);
    expect(await service.getCorrectionSignals('vidK')).toEqual({ notAi: false, notSlop: true });
  });

  it('caches classifications by fingerprint and invalidates on version change', async () => {
    const service = new StorageService();
    await service.ensureMigration();
    const input = {
      videoId: 'vidC',
      title: 'Cacheable',
      badges: [],
      ariaLabels: [],
      metadataText: [],
      officialDisclosurePresent: true,
      isShort: false,
      locale: 'en',
    };
    await service.putCachedClassification(input, classification, '1');
    expect(await service.getCachedClassification(input, '1')).toBeDefined();
    expect(await service.getCachedClassification(input, '999')).toBeUndefined();
  });
});
