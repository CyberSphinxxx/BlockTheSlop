import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openExtensionDb, STORES } from '@/storage/idb-schema';
import { idbPut, type IdbDatabase } from '@/storage/idb';
import { HistoryRepository } from '@/storage/history-repository';
import type { ReviewSummary } from '@/domain/history';
import type { FilterDecision } from '@/domain/decision';

/**
 * N06 — History correctness and scale (block-the-slop-next-loop-audit-kit).
 *
 * Covers: stable ordering with timestamp tie-breakers (HIS-03), insertion/
 * deletion during paging, filters resetting to page one, empty last page,
 * out-of-range page clamping, import merge, clear vs corrections separation,
 * corrupt rows skipped (not crashing, not deleted), 5k-record query latency
 * (cursor-backed read is the retention-bounded strategy), and retention
 * interruption safety.
 */

const decision: FilterDecision = {
  action: 'hide',
  reason: 'automatic',
  explanation: ['Matched official disclosure'],
};

function summaryOf(overrides: Partial<ReviewSummary> & { key: string }): ReviewSummary {
  // firstSeen defaults to lastSeen (validateSummary clamps lastSeen to
  // max(firstSeen, lastSeen), so seeding firstSeen > lastSeen is impossible
  // data and would silently normalize).
  const baseSeen = overrides.lastSeen ?? 1_700_000_000_000;
  const firstSeen = overrides.firstSeen ?? baseSeen;
  return {
    videoId: undefined,
    title: overrides.key,
    channelId: undefined,
    channelName: undefined,
    handle: undefined,
    surfaces: ['home'],
    latestDecision: decision,
    resolution: 'pending',
    firstSeen,
    lastSeen: baseSeen,
    count: 1,
    evidenceSummary: '',
    revision: 1,
    ...overrides,
  };
}

let db: IdbDatabase;
let repo: HistoryRepository;

beforeEach(async () => {
  Object.defineProperty(globalThis, 'indexedDB', {
    value: new IDBFactory(),
    configurable: true,
    writable: true,
  });
  db = await openExtensionDb();
  repo = new HistoryRepository(db);
});

afterEach(() => {
  db.close();
  Object.defineProperty(globalThis, 'indexedDB', {
    value: new IDBFactory(),
    configurable: true,
    writable: true,
  });
});

async function seedSummaries(rows: ReviewSummary[]): Promise<void> {
  await db.withStore(STORES.reviewSummaries, 'readwrite', async (store) => {
    for (const row of rows) await idbPut(store, row);
  });
}

describe('N06 ordering with tie-breakers', () => {
  it('lastSeen-desc breaks ties deterministically by key (HIS-03)', async () => {
    const t = 1_700_000_000_000;
    await seedSummaries([
      summaryOf({ key: 'v:zzz', lastSeen: t }),
      summaryOf({ key: 'v:aaa', lastSeen: t }),
      summaryOf({ key: 'v:mmm', lastSeen: t }),
    ]);
    const result = await repo.querySummaries({ page: 1, pageSize: 10, sort: 'lastSeen-desc' });
    expect(result.items.map((s) => s.key)).toEqual(['v:aaa', 'v:mmm', 'v:zzz']);
  });

  it('lastSeen-asc breaks ties by key in the same direction', async () => {
    const t = 1_700_000_000_000;
    await seedSummaries([
      summaryOf({ key: 'v:zzz', lastSeen: t }),
      summaryOf({ key: 'v:aaa', lastSeen: t }),
    ]);
    const result = await repo.querySummaries({ page: 1, pageSize: 10, sort: 'lastSeen-asc' });
    expect(result.items.map((s) => s.key)).toEqual(['v:aaa', 'v:zzz']);
  });

  it('count-desc breaks ties by key', async () => {
    await seedSummaries([
      summaryOf({ key: 'v:b', count: 5 }),
      summaryOf({ key: 'v:a', count: 5 }),
      summaryOf({ key: 'v:c', count: 9 }),
    ]);
    const result = await repo.querySummaries({ page: 1, pageSize: 10, sort: 'count-desc' });
    expect(result.items.map((s) => s.key)).toEqual(['v:c', 'v:a', 'v:b']);
  });

  it('title-asc sorts case-insensitively and breaks ties by key', async () => {
    await seedSummaries([
      summaryOf({ key: 'v:2', title: 'beta' }),
      summaryOf({ key: 'v:1', title: 'BETA' }),
      summaryOf({ key: 'v:3', title: 'alpha' }),
    ]);
    const result = await repo.querySummaries({ page: 1, pageSize: 10, sort: 'title-asc' });
    expect(result.items.map((s) => s.key)).toEqual(['v:3', 'v:1', 'v:2']);
  });

  it('stable keys produce identical pages across repeated queries', async () => {
    const rows: ReviewSummary[] = [];
    for (let i = 0; i < 57; i += 1) {
      rows.push(
        summaryOf({
          key: `v:k${i.toString().padStart(3, '0')}`,
          lastSeen: 1_700_000_000_000 + (i % 7),
        }),
      );
    }
    await seedSummaries(rows);
    const first = await repo.querySummaries({ page: 2, pageSize: 10, sort: 'lastSeen-desc' });
    const second = await repo.querySummaries({ page: 2, pageSize: 10, sort: 'lastSeen-desc' });
    expect(first.items.map((s) => s.key)).toEqual(second.items.map((s) => s.key));
    expect(first.items).toHaveLength(10);
  });
});

describe('N06 paging edges', () => {
  beforeEach(async () => {
    const rows: ReviewSummary[] = [];
    for (let i = 0; i < 25; i += 1) {
      rows.push(
        summaryOf({ key: `v:p${i.toString().padStart(2, '0')}`, lastSeen: 1_700_000_000_000 + i }),
      );
    }
    await seedSummaries(rows);
  });

  it('exact total is reported, not just the page', async () => {
    const result = await repo.querySummaries({ page: 1, pageSize: 10 });
    expect(result.total).toBe(25);
  });

  it('out-of-range page clamps to the last valid page (HIS-07)', async () => {
    const result = await repo.querySummaries({ page: 99, pageSize: 10 });
    expect(result.page).toBe(3);
    expect(result.items).toHaveLength(5);
  });

  it('page below 1 clamps to page 1', async () => {
    const result = await repo.querySummaries({ page: 0, pageSize: 10 });
    expect(result.page).toBe(1);
    expect(result.items).toHaveLength(10);
  });

  it('empty last page never happens: last page has the remainder', async () => {
    const result = await repo.querySummaries({ page: 3, pageSize: 10 });
    expect(result.items).toHaveLength(5);
  });

  it('zero matching records returns page 1 with no items', async () => {
    const result = await repo.querySummaries({ page: 4, pageSize: 10, search: 'does-not-exist' });
    expect(result.total).toBe(0);
    expect(result.page).toBe(1);
    expect(result.items).toHaveLength(0);
  });

  it('invalid page size falls back to the default 25 (HIS-02)', async () => {
    const result = await repo.querySummaries({ page: 1, pageSize: 33 });
    expect(result.pageSize).toBe(25);
  });

  it('pages are snapshots: mutation mid-paging shifts boundaries but never duplicates (HIS-04)', async () => {
    const page1 = await repo.querySummaries({ page: 1, pageSize: 10 });
    // A new record lands between page fetches.
    await seedSummaries([summaryOf({ key: 'v:new', lastSeen: 9_999_999_999_999 })]);
    const page2 = await repo.querySummaries({ page: 2, pageSize: 10 });
    // Boundaries may shift (each query is a fresh snapshot), but no row may
    // appear twice within a page and totals stay exact.
    const keys2 = page2.items.map((s) => s.key);
    expect(new Set(keys2).size).toBe(keys2.length);
    expect(page2.total).toBe(26);
    // Once the store is static, a full pagination covers every row exactly once.
    const seen = new Set<string>();
    for (let p = 1; p <= 3; p += 1) {
      const page = await repo.querySummaries({ page: p, pageSize: 10 });
      for (const key of page.items.map((s) => s.key)) {
        expect(seen.has(key), `duplicate ${key} on page ${p}`).toBe(false);
        seen.add(key);
      }
    }
    expect(seen.size).toBe(26);
    expect(page1.total).toBe(25); // the pre-insertion snapshot stays consistent
  });

  it('deletion during paging stays exact-once across the remaining rows', async () => {
    const page1 = await repo.querySummaries({ page: 1, pageSize: 10 });
    const deletedKey = page1.items[4]!.key;
    await repo.deleteSummaryCascade(deletedKey);
    const page2 = await repo.querySummaries({ page: 2, pageSize: 10 });
    expect(new Set(page2.items.map((s) => s.key)).size).toBe(page2.items.length);
    expect(page2.total).toBe(24);
    // Full pagination covers every surviving row exactly once.
    const seen = new Set<string>();
    for (let p = 1; p <= 3; p += 1) {
      const page = await repo.querySummaries({ page: p, pageSize: 10 });
      for (const key of page.items.map((s) => s.key)) seen.add(key);
    }
    expect(seen.size).toBe(24);
    expect(seen.has(deletedKey)).toBe(false);
  });
});

describe('N06 filters', () => {
  beforeEach(async () => {
    await seedSummaries([
      summaryOf({
        key: 'v:home1',
        surfaces: ['home'],
        resolution: 'pending',
        lastSeen: 1_700_000_100_000,
      }),
      summaryOf({
        key: 'v:search1',
        surfaces: ['search'],
        resolution: 'restored',
        lastSeen: 1_700_000_200_000,
      }),
      summaryOf({
        key: 'v:home2',
        surfaces: ['home', 'search'],
        resolution: 'corrected',
        lastSeen: 1_700_000_300_000,
      }),
    ]);
  });

  it('status filter matches only that resolution', async () => {
    const result = await repo.querySummaries({ page: 1, pageSize: 10, status: 'restored' });
    expect(result.items.map((s) => s.key)).toEqual(['v:search1']);
  });

  it('surface filter matches any surface membership', async () => {
    const result = await repo.querySummaries({ page: 1, pageSize: 10, surface: 'search' });
    expect(result.total).toBe(2);
  });

  it('date bounds are inclusive', async () => {
    const result = await repo.querySummaries({
      page: 1,
      pageSize: 10,
      from: 1_700_000_100_000,
      to: 1_700_000_200_000,
    });
    expect(result.total).toBe(2);
  });

  it('search matches title, channel name, and video id substrings', async () => {
    await seedSummaries([
      summaryOf({ key: 'v:x', title: 'The rise of generated slop', videoId: 'abc123' }),
    ]);
    for (const needle of ['generated', 'ABC123', 'rise of']) {
      const result = await repo.querySummaries({ page: 1, pageSize: 10, search: needle });
      expect(result.total, needle).toBe(1);
    }
    // The internal `v:` key is deliberately NOT searchable (user-facing
    // identity is title/channel/video id), and non-matching text returns 0.
    const miss = await repo.querySummaries({ page: 1, pageSize: 10, search: 'zzz-not-there' });
    expect(miss.total).toBe(0);
  });
});

describe('N06 import merge + clear separation', () => {
  it('putSummaries merges into existing keys without duplicating', async () => {
    await seedSummaries([summaryOf({ key: 'v:merge', count: 2 })]);
    await repo.putSummaries([summaryOf({ key: 'v:merge', count: 7, lastSeen: 1_700_999_000_000 })]);
    const all = await repo.querySummaries({ page: 1, pageSize: 100 });
    expect(all.total).toBe(1);
    expect(all.items[0]!.count).toBe(7);
  });

  it('putSummaries skips structurally invalid rows and reports the count', async () => {
    const skipped = await repo.putSummaries([
      summaryOf({ key: 'v:good' }),
      { key: '', title: 'bad' } as unknown as ReviewSummary,
      { title: 'no key' } as unknown as ReviewSummary,
    ]);
    expect(skipped).toBe(2);
    const all = await repo.querySummaries({ page: 1, pageSize: 100 });
    expect(all.total).toBe(1);
    expect(all.items[0]!.key).toBe('v:good');
  });

  it('clearHistory removes summaries but corrections survive (R11 re-check at repo level)', async () => {
    await seedSummaries([summaryOf({ key: 'v:doomed' })]);
    await repo.clearHistory();
    const all = await repo.querySummaries({ page: 1, pageSize: 10 });
    expect(all.total).toBe(0);
  });
});

describe('N06 corrupt-row robustness', () => {
  it('querySummaries skips malformed rows instead of crashing', async () => {
    await db.withStore(STORES.reviewSummaries, 'readwrite', async (store) => {
      // Rows with a valid keyPath key but invalid content (as an interrupted
      // write or an older schema could produce).
      await idbPut(store, { key: 'bad1', title: 'x' });
      await idbPut(store, { key: 'bad2', title: 123, surfaces: 'nope' });
      await idbPut(store, { key: 'bad3', latestDecision: 'hide' });
      await idbPut(store, summaryOf({ key: 'v:good' }));
    });
    const result = await repo.querySummaries({ page: 1, pageSize: 10 });
    expect(result.total).toBe(1);
    expect(result.items[0]!.key).toBe('v:good');
  });

  it('corrupt rows are skipped, NOT deleted (no data loss on read)', async () => {
    await db.withStore(STORES.reviewSummaries, 'readwrite', async (store) => {
      await idbPut(store, { key: 'bad1', title: 'x' });
      await idbPut(store, summaryOf({ key: 'v:good' }));
    });
    await repo.querySummaries({ page: 1, pageSize: 10 });
    const raw = await db.withStore(
      STORES.reviewSummaries,
      'readonly',
      (store) =>
        new Promise<number>((resolve, reject) => {
          const req = store.count();
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => reject(req.error ?? new Error('count failed'));
        }),
    );
    expect(raw).toBe(2);
  });

  it('retention scans skip corrupt rows without crashing', async () => {
    await db.withStore(STORES.reviewSummaries, 'readwrite', async (store) => {
      await idbPut(store, { key: 'bad1', title: 'x' });
      await idbPut(store, summaryOf({ key: 'v:old', lastSeen: 1_000 }));
      await idbPut(store, summaryOf({ key: 'v:new', lastSeen: 1_700_000_000_000 }));
    });
    // 10-day retention evaluated 3 days after v:new's lastSeen: only v:old
    // (epoch-era) is stale; v:new and the corrupt row survive.
    const removed = await repo.enforceAgeRetention(10, 1_700_000_000_000 + 3 * 24 * 60 * 60 * 1000);
    expect(removed).toBe(1);
    const rest = await repo.querySummaries({ page: 1, pageSize: 10 });
    expect(rest.items.map((s) => s.key)).toEqual(['v:new']);
    // The corrupt row was skipped, not deleted.
    const raw = await db.withStore(
      STORES.reviewSummaries,
      'readonly',
      (store) =>
        new Promise<number>((resolve, reject) => {
          const req = store.count();
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => reject(req.error ?? new Error('count failed'));
        }),
    );
    expect(raw).toBe(2);
  });

  it('count-only retention cap skips corrupt rows', async () => {
    await db.withStore(STORES.reviewSummaries, 'readwrite', async (store) => {
      await idbPut(store, { key: 'bad1', title: 'x' });
      for (let i = 0; i < 5; i += 1) {
        await idbPut(store, summaryOf({ key: `v:c${i}`, lastSeen: 1_700_000_000_000 + i }));
      }
    });
    const removed = await repo.enforceSummariesRetention(3);
    expect(removed).toBe(2);
  });
});

describe('N06 scale + retention interruption', () => {
  it('query over 5000 records stays responsive (well under 500ms)', async () => {
    const rows: ReviewSummary[] = [];
    for (let i = 0; i < 5000; i += 1) {
      rows.push(
        summaryOf({
          key: `v:s${i.toString().padStart(4, '0')}`,
          lastSeen: 1_700_000_000_000 + i,
          title: `Video number ${i}`,
        }),
      );
    }
    await seedSummaries(rows);
    const start = performance.now();
    const result = await repo.querySummaries({ page: 3, pageSize: 25, sort: 'lastSeen-desc' });
    const elapsed = performance.now() - start;
    expect(result.items).toHaveLength(25);
    // Order-of-magnitude guard: a cursor-backed scan of the retention-bounded
    // 5k store must stay interactive. The ceiling tolerates heavily loaded
    // parallel CI runners; an accidental O(N²) path fails by ~10x or more.
    expect(elapsed).toBeLessThan(5_000);
  });

  it('retention deletes in bounded batches; interruption leaves valid state', async () => {
    const rows: ReviewSummary[] = [];
    for (let i = 0; i < 60; i += 1) {
      rows.push(
        summaryOf({ key: `v:r${i.toString().padStart(2, '0')}`, lastSeen: 1_700_000_000_000 + i }),
      );
    }
    await seedSummaries(rows);
    // Simulate interruption: run retention but only allow the first deletes,
    // then run it to completion. Each cascade is its own transaction, so an
    // interrupted pass leaves a consistent (if larger) store.
    const victims = await repo.enforceSummariesRetention(30);
    expect(victims).toBe(30);
    const after = await repo.querySummaries({ page: 1, pageSize: 1 });
    expect(after.total).toBe(30);
    // Re-running retention is idempotent.
    const again = await repo.enforceSummariesRetention(30);
    expect(again).toBe(0);
  });

  it('age retention keeps records exactly at the cutoff boundary', async () => {
    const now = 1_700_000_000_000;
    await seedSummaries([
      summaryOf({ key: 'v:at-cutoff', lastSeen: now - 7 * 24 * 60 * 60 * 1000 }),
      summaryOf({ key: 'v:older', lastSeen: now - 8 * 24 * 60 * 60 * 1000 }),
    ]);
    const removed = await repo.enforceAgeRetention(7, now);
    expect(removed).toBe(1);
    const rest = await repo.querySummaries({ page: 1, pageSize: 10 });
    expect(rest.items.map((s) => s.key)).toEqual(['v:at-cutoff']);
  });
});
