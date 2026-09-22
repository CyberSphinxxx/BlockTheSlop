import type { Classification } from '@/domain/classification';
import { classificationFingerprint, type FingerprintInput } from './fingerprint';
import { CLASSIFIER_VERSION } from '@/domain/versions';
import { idbCount, idbDelete, idbGet, idbGetByIndex, idbPut, type IdbDatabase } from './idb';
import { STORES } from './idb-schema';

/**
 * Classification cache (R12, 04 §4): keyed by evidence fingerprint + rule/
 * classifier versions, NOT bare videoId — a card whose evidence hydrates
 * later must re-run detectors. TTL: 7 days for rich evidence, 24h for
 * thin/partial evidence (04 §8).
 */
export interface CachedClassification {
  cacheKey: string;
  videoId: string | undefined;
  inputFingerprint: string;
  ruleVersion: string;
  classifierVersion: string;
  classification: Classification;
  cachedAt: number;
  expiresAt: number;
}

const RICH_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const THIN_TTL_MS = 24 * 60 * 60 * 1000;
const CACHE_MAX_ENTRIES = 2000;

export function cacheKeyFor(fingerprint: string, rulesVersion: string): string {
  return `v1:${fingerprint}:${rulesVersion}`;
}

export function buildCacheEntry(
  input: FingerprintInput,
  classification: Classification,
  rulesVersion: string,
  now: number,
): CachedClassification {
  const fingerprint = classificationFingerprint(input);
  const richEvidence =
    input.officialDisclosurePresent || input.description !== undefined || input.badges.length > 0;
  return {
    cacheKey: cacheKeyFor(fingerprint, rulesVersion),
    videoId: input.videoId,
    inputFingerprint: fingerprint,
    ruleVersion: rulesVersion,
    classifierVersion: CLASSIFIER_VERSION,
    classification,
    cachedAt: now,
    expiresAt: now + (richEvidence ? RICH_TTL_MS : THIN_TTL_MS),
  };
}

export class ClassificationCacheRepository {
  constructor(private readonly db: IdbDatabase) {}

  async get(input: FingerprintInput, rulesVersion: string): Promise<Classification | undefined> {
    const key = cacheKeyFor(classificationFingerprint(input), rulesVersion);
    return this.db.withStore(STORES.classificationCache, 'readonly', async (store) => {
      const entry = await idbGet<CachedClassification>(store, key);
      if (entry === undefined) return undefined;
      if (entry.classifierVersion !== CLASSIFIER_VERSION) return undefined;
      if (entry.ruleVersion !== rulesVersion) return undefined;
      if (Date.now() > entry.expiresAt) return undefined;
      return entry.classification;
    });
  }

  async put(
    input: FingerprintInput,
    classification: Classification,
    rulesVersion: string,
  ): Promise<void> {
    const entry = buildCacheEntry(input, classification, rulesVersion, Date.now());
    await this.db.withStore(STORES.classificationCache, 'readwrite', (store) =>
      idbPut(store, entry),
    );
  }

  /** Purge expired entries and enforce the size cap (oldest first). */
  async enforceRetention(): Promise<number> {
    const now = Date.now();
    return this.db.withStore(STORES.classificationCache, 'readwrite', async (store) => {
      const expired = await idbGetByIndex<CachedClassification>(
        store.index('expiresAt'),
        IDBKeyRange.upperBound(now),
      );
      for (const entry of expired) await idbDelete(store, entry.cacheKey);

      const total = await idbCount(store);
      let removed = expired.length;
      if (total > CACHE_MAX_ENTRIES) {
        const excess = total - CACHE_MAX_ENTRIES;
        const all = await idbGetByIndex<CachedClassification>(store.index('expiresAt'));
        const oldest = [...all].sort((a, b) => a.cachedAt - b.cachedAt).slice(0, excess);
        for (const entry of oldest) await idbDelete(store, entry.cacheKey);
        removed += oldest.length;
      }
      return removed;
    });
  }

  async clear(): Promise<void> {
    await this.db.withStore(
      STORES.classificationCache,
      'readwrite',
      (store) =>
        new Promise<void>((resolve, reject) => {
          const request = store.clear();
          request.onsuccess = () => resolve();
          request.onerror = () => reject(request.error ?? new Error('clear failed'));
        }),
    );
  }

  async count(): Promise<number> {
    return this.db.withStore(STORES.classificationCache, 'readonly', (store) => idbCount(store));
  }
}
