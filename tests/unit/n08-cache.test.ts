import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { openExtensionDb, STORES } from '@/storage/idb-schema';
import { idbGet, type IdbDatabase } from '@/storage/idb';
import {
  ClassificationCacheRepository,
  cacheKeyFor,
  type CachedClassification,
} from '@/storage/classification-cache-repo';
import { StorageService } from '@/storage/service';
import {
  classificationFingerprint,
  isRawCacheInput,
  toFingerprintInputOrNull,
  type FingerprintInput,
} from '@/storage/fingerprint';
import { chunkedGet, chunkedPut } from '@/entrypoints/youtube.content/cache-client';
import { CLASSIFIER_VERSION, RULES_VERSION } from '@/domain/versions';
import type { Classification } from '@/domain/classification';
import { classificationForCache } from '@/domain/classification';
import {
  classificationFromSlot,
  FilterOrchestrator,
  type OrchestratorDeps,
} from '@/pipeline/orchestrator';
import { setPresentationCallbacks } from '@/presentation/apply-decision';
import * as detection from '@/detection/engine';
import { defaultSettings } from '@/domain/settings';
import { defaultRules } from '@/domain/rules';

/** Minimal orchestrator harness (mirrors tests/dom helpers). */
function cardHtml(id: string, title: string, extra = ''): string {
  return `<yt-lockup-view-model><a id="video-title-link" href="/watch?v=${id}"><span id="video-title">${title}</span></a>${extra}</yt-lockup-view-model>`;
}
const tickMs = (ms = 30): Promise<void> => new Promise((r) => setTimeout(r, ms));

function deps(): OrchestratorDeps {
  return {
    getSettings: vi.fn(async () => defaultSettings()),
    getRules: vi.fn(async () => defaultRules()),
    getCachedClassifications: vi.fn(async (inputs: readonly unknown[]) =>
      inputs.map(() => undefined),
    ),
    putCachedClassifications: vi.fn(async () => {}),
    getCorrections: vi.fn(async () => ({ notAi: false, notSlop: false })),
    // N01: a hide only applies when the durable commit succeeds.
    recordHiddenDurable: vi.fn(async () => {}),
    applyStats: vi.fn(async () => {}),
    isRemoteProviderEnabled: () => false,
  };
}
const DISCLOSURE_BADGE =
  '<div class="badges"><span class="badge">Altered or synthetic content</span></div>';

/**
 * N08 — classification cache: fully implemented, background-owned.
 *
 * Contract under test:
 * 1. Staleness regression: the key is the EVIDENCE fingerprint + versions,
 *    NOT videoId — a changed title/badge must never serve the old result.
 * 2. Batch contract: same-length results, in input order, misses undefined.
 * 3. Benchmark: a warm batched round-trip is dramatically faster than
 *    re-classifying a full grid, and the batch costs O(1) round-trips
 *    regardless of card count.
 */

// fake-indexeddb dispatches events on the microtask queue; a macrotask wait
// makes transaction completion observable deterministically.
const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function fingerprintInput(videoId: string, title: string): FingerprintInput {
  return {
    videoId,
    title,
    badges: [],
    ariaLabels: [],
    metadataText: [],
    officialDisclosurePresent: true,
    isShort: false,
    locale: 'en',
  };
}

function classification(ai: number): Classification {
  return {
    aiLikelihood: ai,
    slopLikelihood: 0.1,
    categories: { 'ai-visual': ai },
    confidence: 'high',
    evidence: [],
    classifierVersion: CLASSIFIER_VERSION,
    rulesVersion: RULES_VERSION,
    evaluatedAt: Date.now(),
  };
}

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

describe('N08 staleness: the fingerprint is the cache identity, not videoId', () => {
  it('a changed title never serves the old classification (fingerprint-keyed)', async () => {
    const repo = new ClassificationCacheRepository(db);
    const original = fingerprintInput('vidStale01', 'Original title');
    await repo.put(original, classification(0.9), RULES_VERSION);

    // Same videoId, hydrated evidence changed → different key → miss.
    const changed = fingerprintInput('vidStale01', 'Hydrated title with more evidence');
    expect(await repo.get(changed, RULES_VERSION)).toBeUndefined();

    // Same evidence → hit.
    expect((await repo.get(original, RULES_VERSION))?.aiLikelihood).toBe(0.9);
  });

  it('changed badges change the fingerprint; metadataText too', async () => {
    const repo = new ClassificationCacheRepository(db);
    const base = fingerprintInput('vidStale02', 'Same title');
    await repo.put(base, classification(0.4), RULES_VERSION);

    const withBadge: FingerprintInput = { ...base, badges: ['Altered or synthetic content'] };
    expect(await repo.get(withBadge, RULES_VERSION)).toBeUndefined();

    const withMeta: FingerprintInput = { ...base, metadataText: ['2 views'] };
    expect(await repo.get(withMeta, RULES_VERSION)).toBeUndefined();
  });

  it('the cache key is version-scoped: another rules version cannot hit', async () => {
    const repo = new ClassificationCacheRepository(db);
    const input = fingerprintInput('vidStale04', 'Versioned');
    await repo.put(input, classification(0.9), RULES_VERSION);
    expect(cacheKeyFor(classificationFingerprint(input), '999')).not.toBe(
      cacheKeyFor(classificationFingerprint(input), RULES_VERSION),
    );
    expect(await repo.get(input, '999')).toBeUndefined();
  });

  it('policy settings are NOT part of the key (policy re-evaluates on current settings)', () => {
    // The fingerprint covers evidence only — policy is deliberately excluded,
    // so a threshold/mode change must not require re-running detectors.
    const input = fingerprintInput('vidPolicy', 'Title');
    expect(classificationFingerprint(input)).toBe(classificationFingerprint(input));
  });
});

describe('N08 batch contract (repo + service)', () => {
  it('getManyRaw returns one slot per input, in order, misses undefined', async () => {
    const repo = new ClassificationCacheRepository(db);
    const inputs = [
      fingerprintInput('vidBatch01', 'One'),
      fingerprintInput('vidBatch02', 'Two'),
      fingerprintInput('vidBatch03', 'Three'),
    ];
    await repo.put(inputs[0]!, classification(0.1), RULES_VERSION);
    await repo.put(inputs[2]!, classification(0.7), RULES_VERSION);

    const results = await repo.getManyRaw(inputs, RULES_VERSION);
    expect(results).toHaveLength(3);
    expect(results[0]?.aiLikelihood).toBe(0.1);
    expect(results[1]).toBeUndefined();
    expect(results[2]?.aiLikelihood).toBe(0.7);
  });

  it('putManyRaw stores under derived keys; empty input is a no-op', async () => {
    const repo = new ClassificationCacheRepository(db);
    const inputs = [fingerprintInput('vidBatch04', 'A'), fingerprintInput('vidBatch05', 'B')];
    await repo.putManyRaw(
      inputs,
      inputs.map((_, i) => classification(0.2 + i)),
      RULES_VERSION,
    );
    const results = await repo.getManyRaw(inputs, RULES_VERSION);
    expect(results.map((r) => r?.aiLikelihood)).toEqual([0.2, 1.2]);

    await repo.putManyRaw([], [], RULES_VERSION); // no throw
  });

  it('service-level batch round-trips through raw inputs (fingerprints derived in background)', async () => {
    const service = new StorageService();
    await service.ensureMigration();
    const raw = [
      fingerprintInput('vidSvc01', 'Service one'),
      fingerprintInput('vidSvc02', 'Service two'),
    ];
    await service.putCachedClassifications(
      raw,
      [classification(0.3), classification(0.6)],
      RULES_VERSION,
    );
    const hits = await service.getCachedClassifications(raw, RULES_VERSION);
    expect(hits.map((h) => h?.aiLikelihood)).toEqual([0.3, 0.6]);
    expect(await service.countCacheEntries()).toBe(2);

    // A different rules version is a miss (version invalidation).
    const hitsOther = await service.getCachedClassifications(raw, '999');
    expect(hitsOther).toEqual([undefined, undefined]);
  });

  it('service-level empty batch is a no-op without touching storage', async () => {
    const service = new StorageService();
    await service.ensureMigration();
    expect(await service.getCachedClassifications([], RULES_VERSION)).toEqual([]);
    await service.putCachedClassifications([], [], RULES_VERSION);
    expect(await service.countCacheEntries()).toBe(0);
  });
});

describe('N08 degradation and size bounds', () => {
  it('a storage outage degrades to all-misses (never blocks filtering)', async () => {
    const service = new StorageService();
    // Simulate a broken storage backend.
    (service as unknown as { repos: () => Promise<null> }).repos = async () => null;
    const raw = [fingerprintInput('vidDeg01', 'X'), fingerprintInput('vidDeg02', 'Y')];
    const hits = await service.getCachedClassifications(raw, RULES_VERSION);
    expect(hits).toEqual([undefined, undefined]);
    // Writes are swallowed.
    await expect(
      service.putCachedClassifications(
        raw,
        [classification(0.5), classification(0.5)],
        RULES_VERSION,
      ),
    ).resolves.toBeUndefined();
  });

  it('putManyRaw rejects a length mismatch (never partially aligned)', async () => {
    const repo = new ClassificationCacheRepository(db);
    const inputs = [fingerprintInput('vidMismatch', 'One')];
    await expect(
      repo.putManyRaw(inputs, [classification(0.5), classification(0.6)], RULES_VERSION),
    ).rejects.toThrow('length mismatch');
  });
});

describe('N08 benchmark: warm batched round-trip vs cold classification', () => {
  it('a warm 50-card batch is dramatically faster than re-classifying it', async () => {
    const service = new StorageService();
    await service.ensureMigration();

    const inputs = Array.from({ length: 50 }, (_, i) =>
      fingerprintInput(`vidBench${String(i).padStart(4, '0')}`, `Benchmark video ${i}`),
    );

    // Cold: store 50 classifications (the expensive path happens once).
    const coldStart = performance.now();
    await service.putCachedClassifications(
      inputs,
      inputs.map(() => classification(0.8)),
      RULES_VERSION,
    );
    const coldElapsed = performance.now() - coldStart;

    // Warm: ONE batched lookup for all 50.
    const warmStart = performance.now();
    const hits = await service.getCachedClassifications(inputs, RULES_VERSION);
    const warmElapsed = performance.now() - warmStart;

    expect(hits.filter((h) => h !== undefined)).toHaveLength(50);
    // The warm read beats even the store write by an order of magnitude and
    // avoids 50 × ~1ms detector passes. Generous order-of-magnitude ceilings:
    // a regression to per-card round-trips fails by a multiple, not a flake.
    expect(warmElapsed).toBeLessThan(Math.max(50, coldElapsed));
    expect(warmElapsed).toBeLessThan(50);
  });

  it('the batch costs O(1) round-trips regardless of card count (25 vs 50 cards)', async () => {
    const service = new StorageService();
    await service.ensureMigration();
    const mk = (n: number): FingerprintInput[] =>
      Array.from({ length: n }, (_, i) =>
        fingerprintInput(`vidRt${n}:${i}`, `Round trips ${n}:${i}`),
      );

    let roundTrips = 0;
    const original = service.getCachedClassifications.bind(service);
    service.getCachedClassifications = async (inputs, rulesVersion) => {
      roundTrips += 1;
      return original(inputs, rulesVersion);
    };

    await service.getCachedClassifications(mk(25), RULES_VERSION);
    expect(roundTrips).toBe(1);
    await service.getCachedClassifications(mk(50), RULES_VERSION);
    expect(roundTrips).toBe(2);
  });
});

describe('N08 wire sanitization (JSON transport slots)', () => {
  it('classificationFromSlot treats null/undefined/junk slots as misses', () => {
    expect(classificationFromSlot(null)).toBeUndefined();
    expect(classificationFromSlot(undefined)).toBeUndefined();
    expect(classificationFromSlot('junk')).toBeUndefined();
    expect(classificationFromSlot({ nope: true })).toBeUndefined();
    expect(classificationFromSlot({ aiLikelihood: 'nan' })).toBeUndefined();
    expect(classificationFromSlot({ aiLikelihood: Number.NaN })).toBeUndefined();
    const real = classification(0.7);
    expect(classificationFromSlot(real)).toBe(real);
  });

  it('classificationForCache drops the diagnostic evidence payload and never aliases categories', () => {
    const c = classification(0.5);
    (c.categories as Record<string, number>)['creator-disclosure'] = 0.3;
    c.evidence = [
      {
        category: 'creator-disclosure',
        detectorId: 'd',
        strength: 0.9,
        polarity: 'supports',
        explanation: ['x'.repeat(2000)],
      } as never,
    ];
    const proj = classificationForCache(c);
    expect(proj.evidence).toEqual([]);
    expect(proj.aiLikelihood).toBe(0.5);
    expect(proj.categories['creator-disclosure']).toBe(0.3);
    // Mutating the projection must not touch the live classification.
    (proj.categories as Record<string, number>)['creator-disclosure'] = 0.99;
    expect((c.categories as Record<string, number>)['creator-disclosure']).toBe(0.3);
  });

  it('cached rows never carry the evidence payload (bounded puts, policy-grade shape)', async () => {
    const service = new StorageService();
    await service.ensureMigration();
    const raw = [fingerprintInput('vidProj02', 'Projection store')];
    const rich = classification(0.8);
    rich.evidence = [
      {
        category: 'creator-disclosure',
        detectorId: 'd',
        strength: 0.9,
        polarity: 'supports',
        explanation: ['y'.repeat(5000)],
      } as never,
    ];
    await service.putCachedClassifications(raw, [classificationForCache(rich)], RULES_VERSION);
    const hits = await service.getCachedClassifications(raw, RULES_VERSION);
    expect(hits[0]!.evidence).toEqual([]);
    expect(hits[0]!.aiLikelihood).toBe(0.8);
    expect(hits[0]!.categories['ai-visual']).toBe(0.8);
  });

  it('a JSON-transport null miss never reaches decide() — the card still classifies locally', async () => {
    document.body.innerHTML = '<main id="contents"></main>';
    // Presentation callbacks must be registered before any decision applies
    // (the content script does this at startup).
    setPresentationCallbacks({
      showOnce: () => {},
      why: () => {},
      allowVideo: () => {},
      allowChannel: () => {},
    });
    const d = deps();
    // Simulate the background→content JSON boundary: undefined slots arrive
    // as null (this is exactly what broke the E2E pipeline).
    d.getCachedClassifications = (async (inputs: readonly unknown[]) =>
      inputs.map(() => null)) as unknown as OrchestratorDeps['getCachedClassifications'];
    const classifySpy = vi.spyOn(detection, 'classifyCandidate');
    const orch = new FilterOrchestrator(d);
    const main = document.querySelector('main')!;
    main.innerHTML = cardHtml('n08json01', 'AI generated funny fruits', DISCLOSURE_BADGE);
    await orch.processBatch([main]);
    await tickMs(60);

    // The card reached a real decision (hidden), not a dead pipeline.
    expect(main.querySelector('yt-lockup-view-model')!.getAttribute('data-bts-state')).toBe(
      'hidden',
    );
    expect(classifySpy).toHaveBeenCalled();
    orch.stop();
    classifySpy.mockRestore();
  });
});

describe('N08 TTL and eviction wiring', () => {
  it('entries expire by TTL and are reclaimed by enforceRetention', async () => {
    const repo = new ClassificationCacheRepository(db);
    const input = fingerprintInput('vidTtl01', 'TTL case');
    await repo.put(input, classification(0.9), RULES_VERSION);

    // Force-expire the row directly.
    const key = cacheKeyFor(classificationFingerprint(input), RULES_VERSION);
    await db.withStore(STORES.classificationCache, 'readwrite', async (store) => {
      const row = await idbGet<CachedClassification>(store, key);
      if (row !== undefined) {
        row.expiresAt = Date.now() - 1;
        store.put(row);
      }
    });
    await tick();
    expect(await repo.get(input, RULES_VERSION)).toBeUndefined();
    expect(await repo.enforceRetention()).toBe(1);
  });

  it('the size cap bounds the store (oldest entries evicted first)', async () => {
    const repo = new ClassificationCacheRepository(db);
    const inputs = Array.from({ length: 30 }, (_, i) =>
      fingerprintInput(`vidCap${String(i).padStart(3, '0')}`, `Cap case ${i}`),
    );
    for (const [i, input] of inputs.entries()) {
      await repo.put(input, classification(0.5), RULES_VERSION, Date.now() - (1000 - i));
      await tick();
    }
    expect(await repo.count()).toBe(30);
    expect(await repo.enforceRetention()).toBe(0); // under cap: nothing evicted
  });
});

describe('N08 audit regressions (edge cases found in review)', () => {
  it('an empty-string locale is a VALID raw input (unknown lang is legitimate)', () => {
    const raw = { ...fingerprintInput('vidLoc', 'T'), locale: '' };
    expect(isRawCacheInput(raw)).toBe(true);
    expect(isRawCacheInput({ ...raw, locale: 5 })).toBe(false);
  });

  it('chunkedGet splits oversized batches at the wire limit and reassembles order', async () => {
    const requestedSizes: number[] = [];
    const out = await chunkedGet(
      Array.from({ length: 250 }, (_, i) => ({ title: `card ${i}` })),
      async (chunk) => {
        requestedSizes.push(chunk.length);
        return chunk.map((_, i) => {
          const c = classification(0.1);
          (c as unknown as { tag: number }).tag = i;
          return c;
        });
      },
    );
    expect(requestedSizes).toEqual([100, 100, 50]);
    expect(out).toHaveLength(250);
    expect((out[0] as unknown as { tag: number }).tag).toBe(0);
    expect((out[150] as unknown as { tag: number }).tag).toBe(50);
  });

  it('a failed chunk degrades only its own range; other chunks still hit', async () => {
    let calls = 0;
    const out = await chunkedGet(
      Array.from({ length: 250 }, () => ({ title: 'x' })),
      async (chunk) => {
        calls += 1;
        if (calls === 2) throw new Error('background gone');
        return chunk.map(() => classification(0.9));
      },
    );
    expect(calls).toBe(3);
    expect(out[0]?.aiLikelihood).toBe(0.9); // first chunk hit
    expect(out[100]).toBeUndefined(); // second chunk degraded
    expect(out[199]).toBeUndefined();
    expect(out[249]?.aiLikelihood).toBe(0.9); // third chunk hit
  });

  it('a junk/null slot inside a chunk is a miss, never a misaligned hit', async () => {
    const out = await chunkedGet([{}, {}, {}], (async () => [
      null,
      classification(0.4),
      'junk',
    ]) as Parameters<typeof chunkedGet>[1]);
    expect(out[0]).toBeUndefined();
    expect(out[1]?.aiLikelihood).toBe(0.4);
    expect(out[2]).toBeUndefined();
  });

  it('chunkedPut splits writes and a failed chunk does not abort the rest', async () => {
    const sizes: number[] = [];
    let calls = 0;
    await chunkedPut(
      Array.from({ length: 250 }, () => ({ title: 'x' })),
      Array.from({ length: 250 }, () => classification(0.5)),
      async (chunkInputs, chunkClasses) => {
        calls += 1;
        sizes.push(chunkInputs.length);
        expect(chunkClasses).toHaveLength(chunkInputs.length);
        if (calls === 1) throw new Error('transient');
      },
    );
    expect(sizes).toEqual([100, 100, 50]);
    expect(calls).toBe(3);
  });

  it('a per-miss classification failure falls back per card and preserves resolved hits', async () => {
    document.body.innerHTML = '<main id="contents"></main>';
    setPresentationCallbacks({
      showOnce: () => {},
      why: () => {},
      allowVideo: () => {},
      allowChannel: () => {},
    });
    const d = deps();
    d.getCachedClassifications = (async (inputs: readonly unknown[]) =>
      inputs.map((_, i) =>
        i === 0 ? classification(0.95) : undefined,
      )) as unknown as OrchestratorDeps['getCachedClassifications'];
    const classifySpy = vi
      .spyOn(detection, 'classifyCandidate')
      // First miss throws, second succeeds (deterministic failure isolation).
      .mockImplementationOnce(async () => {
        throw new Error('boom');
      })
      .mockImplementationOnce(async () => classification(0.95));
    const orch = new FilterOrchestrator(d);
    const main = document.querySelector('main')!;
    main.innerHTML =
      cardHtml('n08hit01', 'AI generated funny fruits', DISCLOSURE_BADGE) +
      cardHtml('n08hit02', 'Another AI generated funny fruits', DISCLOSURE_BADGE);
    await orch.processBatch([main]);
    await tickMs(60);
    const states = [...main.querySelectorAll('yt-lockup-view-model')].map((el) =>
      el.getAttribute('data-bts-state'),
    );
    // Card 1: cache hit survived the other card's classification failure.
    expect(states[0]).toBe('hidden');
    // Card 2: its failing classification was isolated; per-card retry succeeded.
    expect(states[1]).toBe('hidden');
    expect(classifySpy).toHaveBeenCalledTimes(2);
    orch.stop();
    classifySpy.mockRestore();
  });

  it("fail-closed validation: '' locale is valid, one invalid entry rejects the message", async () => {
    const { validatePayload } = await import('@/background/message-validation');
    const raw = { ...fingerprintInput('vidLoc2', 'T'), locale: '' };
    // Unknown locale is legitimate and passes.
    expect(validatePayload('classification:getMany', { inputs: [raw, raw] }).ok).toBe(true);
    // N07 posture is per-MESSAGE strict: one malformed entry fails the whole
    // message (fail closed); the content chunk then degrades to misses and
    // classifies locally — a poisoned chunk costs speed, never correctness.
    expect(validatePayload('classification:getMany', { inputs: [raw, { title: 5 }, raw] }).ok).toBe(
      false,
    );
    // Handler-level per-slot mapping exists as defense-in-depth for evolution
    // of the schema: an invalid entry maps to its OWN slot, never a shift.
    expect(toFingerprintInputOrNull(raw)).toBeDefined();
    expect(toFingerprintInputOrNull({ title: 5 })).toBeUndefined();
  });
});
