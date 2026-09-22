/**
 * Thin async key/value persistence over `browser.storage.local`.
 *
 * The rest of the storage layer programs against this interface so that every
 * store is unit-testable with an in-memory fake and the production code has a
 * single place where the extension API is touched.
 */
export interface KVStore {
  get<T>(key: string): Promise<T | undefined>;
  set<T>(key: string, value: T): Promise<void>;
  remove(key: string): Promise<void>;
}

/** Production implementation backed by the WXT `browser` abstraction. */
export class BrowserKVStore implements KVStore {
  async get<T>(key: string): Promise<T | undefined> {
    const result = await browser.storage.local.get(key);
    return result[key] as T | undefined;
  }

  async set<T>(key: string, value: T): Promise<void> {
    await browser.storage.local.set({ [key]: value });
  }

  async remove(key: string): Promise<void> {
    await browser.storage.local.remove(key);
  }
}

/** In-memory implementation for tests and non-extension contexts. */
export class MemoryKVStore implements KVStore {
  private readonly map = new Map<string, unknown>();

  async get<T>(key: string): Promise<T | undefined> {
    return this.map.get(key) as T | undefined;
  }

  async set<T>(key: string, value: T): Promise<void> {
    this.map.set(key, structuredClone(value));
  }

  async remove(key: string): Promise<void> {
    this.map.delete(key);
  }

  /** Test helper: inspect raw contents. */
  dump(): Record<string, unknown> {
    return Object.fromEntries(this.map);
  }
}
