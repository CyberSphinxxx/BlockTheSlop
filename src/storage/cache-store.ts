import type { Classification } from '@/domain/classification';
import { CLASSIFIER_VERSION } from '@/domain/versions';
import type { KVStore } from './db';
import { STORAGE_KEYS } from './keys';

/**
 * Cached classification keyed by video identity + rules/classifier versions.
 * Policy is never cached — only evidence/classification — so decisions always
 * reflect current settings.
 */
export interface ClassificationCacheEntry {
  videoId: string;
  classifierVersion: string;
  rulesVersion: string;
  classification: Classification;
  cachedAt: number;
}

const CACHE_MAX_ENTRIES = 2000;
const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export function cacheKeyFor(videoId: string): string {
  return `v1:${videoId}`;
}

export class ClassificationCacheStore {
  constructor(private readonly kv: KVStore) {}

  private async loadAll(): Promise<Record<string, ClassificationCacheEntry>> {
    const raw = await this.kv.get<Record<string, ClassificationCacheEntry>>(
      STORAGE_KEYS.classificationCache,
    );
    if (raw === null || typeof raw !== 'object') return {};
    return raw;
  }

  async get(
    videoId: string,
    rulesVersion: string = CLASSIFIER_VERSION,
  ): Promise<Classification | undefined> {
    const all = await this.loadAll();
    const entry = all[cacheKeyFor(videoId)];
    if (!entry) return undefined;
    if (entry.classifierVersion !== CLASSIFIER_VERSION) return undefined;
    if (entry.rulesVersion !== rulesVersion) return undefined;
    if (Date.now() - entry.cachedAt > CACHE_TTL_MS) return undefined;
    return entry.classification;
  }

  async put(videoId: string, classification: Classification, rulesVersion: string): Promise<void> {
    const all = await this.loadAll();
    all[cacheKeyFor(videoId)] = {
      videoId,
      classifierVersion: CLASSIFIER_VERSION,
      rulesVersion,
      classification,
      cachedAt: Date.now(),
    };
    await this.kv.set(STORAGE_KEYS.classificationCache, await enforceRetention(all));
  }

  async clear(): Promise<void> {
    await this.kv.remove(STORAGE_KEYS.classificationCache);
  }
}

/** Bounded retention: drop stale entries, then oldest until under the cap. */
export async function enforceRetention(
  all: Record<string, ClassificationCacheEntry>,
): Promise<Record<string, ClassificationCacheEntry>> {
  const now = Date.now();
  const valid = Object.fromEntries(
    Object.entries(all).filter(([, e]) => now - e.cachedAt <= CACHE_TTL_MS),
  );
  const entries = Object.entries(valid).sort((a, b) => a[1].cachedAt - b[1].cachedAt);
  const kept = entries.slice(Math.max(0, entries.length - CACHE_MAX_ENTRIES));
  return Object.fromEntries(kept);
}
