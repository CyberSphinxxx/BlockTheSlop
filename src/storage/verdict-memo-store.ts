import {
  type VerdictMemoEntry,
  type VerdictMemoValidationOptions,
  isVerdictMemoValid,
  VERDICT_MEMO_MAX_ENTRIES,
} from '@/domain/verdict-memo';

/**
 * In-memory LRU store for Tier 2 Verdict Memos (V5-03).
 * Fast-paths repeat sightings of the same video while respecting bounded size,
 * TTL expiry, hydration changes, and immediate invalidation on user actions.
 */
export class VerdictMemoStore {
  private readonly entries = new Map<string, VerdictMemoEntry>();
  private readonly maxEntries: number;

  constructor(maxEntries = VERDICT_MEMO_MAX_ENTRIES) {
    this.maxEntries = maxEntries;
  }

  /**
   * Fast-path lookup. Returns the memo entry if present and valid;
   * otherwise returns undefined and deletes invalid/expired entries.
   */
  get(videoId: string, options: VerdictMemoValidationOptions): VerdictMemoEntry | undefined {
    if (!videoId) return undefined;
    const entry = this.entries.get(videoId);
    if (!entry) return undefined;

    if (!isVerdictMemoValid(entry, options)) {
      this.entries.delete(videoId);
      return undefined;
    }

    // Refresh LRU order on valid access
    this.entries.delete(videoId);
    this.entries.set(videoId, entry);
    return entry;
  }

  /**
   * Store or update a verdict memo entry with LRU eviction.
   */
  put(entry: VerdictMemoEntry): void {
    if (!entry.videoId) return;

    this.entries.delete(entry.videoId);
    if (this.entries.size >= this.maxEntries) {
      const oldestKey = this.entries.keys().next().value;
      if (oldestKey) this.entries.delete(oldestKey);
    }
    this.entries.set(entry.videoId, entry);
  }

  /**
   * Put multiple entries in batch.
   */
  putMany(entries: readonly VerdictMemoEntry[]): void {
    for (const entry of entries) {
      this.put(entry);
    }
  }

  /**
   * Delete an entry by videoId.
   */
  delete(videoId: string): void {
    this.entries.delete(videoId);
  }

  /**
   * Check if a videoId exists in the store (diagnostics/testing).
   */
  has(videoId: string): boolean {
    return this.entries.has(videoId);
  }

  /**
   * Invalidate entry when user marks Not AI or Not slop.
   */
  invalidateForCorrection(videoId: string): void {
    this.entries.delete(videoId);
  }

  /**
   * Invalidate entries affected by explicit rule updates.
   */
  invalidateForRules(rules: {
    allowedVideoIds?: readonly string[] | undefined;
    blockedVideoIds?: readonly string[] | undefined;
  }): void {
    if (rules.allowedVideoIds) {
      for (const id of rules.allowedVideoIds) this.entries.delete(id);
    }
    if (rules.blockedVideoIds) {
      for (const id of rules.blockedVideoIds) this.entries.delete(id);
    }
  }

  /**
   * Invalidate all entries when settings change globally or on import.
   */
  clear(): void {
    this.entries.clear();
  }

  /**
   * Alias for clear() to invalidate all entries on rule/settings changes.
   */
  invalidate(): void {
    this.clear();
  }

  /**
   * Purge expired entries and return the number purged.
   */
  sweepExpired(now: number = Date.now()): number {
    let purged = 0;
    for (const [key, entry] of this.entries.entries()) {
      if (now >= entry.expiresAt) {
        this.entries.delete(key);
        purged++;
      }
    }
    return purged;
  }

  size(): number {
    return this.entries.size;
  }

  /** Read-only snapshot for diagnostics/testing */
  entriesSnapshot(): readonly VerdictMemoEntry[] {
    return Array.from(this.entries.values());
  }
}
