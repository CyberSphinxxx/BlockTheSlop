/**
 * Single IndexedDB wrapper for extension-origin storage (R10/04 §4).
 *
 * Every IDB access in the extension goes through this module so transaction
 * semantics, upgrade handling, and error propagation are tested once.
 * Content scripts must NOT use this module — IndexedDB in a content script
 * lives on the *page* origin (youtube.com), which is exactly what the
 * architecture contract forbids. Content scripts reach this data only via
 * typed background messages.
 */

/** A promise-based handle over one open IDB connection. */
export class IdbDatabase {
  constructor(private readonly db: IDBDatabase) {}

  get name(): string {
    return this.db.name;
  }

  get version(): number {
    return this.db.version;
  }

  /** Names of all object stores in the current schema. */
  storeNames(): string[] {
    return Array.from(this.db.objectStoreNames);
  }

  close(): void {
    this.db.close();
  }

  /**
   * Run a callback against one object store inside a transaction and wait
   * for durable commit (transaction `complete`) before resolving.
   * A callback exception ABORTS the transaction: partial writes in a failed
   * unit of work are rolled back, not committed.
   */
  async withStore<T>(
    storeName: string,
    mode: IDBTransactionMode,
    callback: (store: IDBObjectStore) => Promise<T> | T,
  ): Promise<T> {
    const tx = this.db.transaction(storeName, mode);
    const store = tx.objectStore(storeName);
    const settled = attachTxHandlers(tx, storeName);
    let result: T | undefined;
    let callbackError: unknown;
    let failed = false;
    try {
      result = await callback(store);
    } catch (error) {
      failed = true;
      callbackError = error;
      try {
        tx.abort();
      } catch {
        // Transaction already committed/aborted — nothing to roll back.
      }
    }
    try {
      await settled;
    } catch (error) {
      if (!failed) throw error;
    }
    if (failed) throw callbackError;
    return result as T;
  }

  /**
   * Run several operations against multiple stores in ONE transaction
   * (atomic multi-store writes, e.g. summary+event+operation). The callback's
   * value is returned after the transaction durably commits. A callback
   * exception aborts the whole transaction (atomicity, R10).
   */
  async withStores<T extends readonly string[], R = void>(
    storeNames: T,
    mode: IDBTransactionMode,
    callback: (stores: { [K in keyof T]: IDBObjectStore }) => Promise<R> | R,
  ): Promise<R> {
    const tx = this.db.transaction([...storeNames], mode);
    const stores = storeNames.map((name) => tx.objectStore(name)) as {
      [K in keyof T]: IDBObjectStore;
    };
    const settled = attachTxHandlers(tx, `[${storeNames.join(', ')}]`);
    let result: R | undefined;
    let callbackError: unknown;
    let failed = false;
    try {
      result = await callback(stores);
    } catch (error) {
      failed = true;
      callbackError = error;
      try {
        tx.abort();
      } catch {
        // Transaction already committed/aborted — nothing to roll back.
      }
    }
    try {
      await settled;
    } catch (error) {
      if (!failed) throw error;
    }
    if (failed) throw callbackError;
    return result as R;
  }
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IDB request failed'));
  });
}

/**
 * Attach transaction completion handlers IMMEDIATELY (before any callback
 * await) so an auto-commit between callback completion and handler attachment
 * cannot hang the wait.
 */
function attachTxHandlers(tx: IDBTransaction, label: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error ?? new Error(`transaction aborted on ${label}`));
    tx.onerror = () => reject(tx.error ?? new Error(`transaction error on ${label}`));
  });
}

/**
 * Continue a cursor and resolve with its next value (or null at the end).
 * `IDBCursor.continue()` returns void and completion is observed on the
 * ORIGINAL request object, so the request must be captured at openCursor time.
 */
function continueCursor(
  request: IDBRequest<IDBCursorWithValue | null>,
  cursor: IDBCursorWithValue,
): Promise<IDBCursorWithValue | null> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IDB cursor failed'));
    cursor.continue();
  });
}

/**
 * Open (and upgrade) a database. `onUpgrade` creates/patches object stores
 * inside the versionchange transaction. A `blocked` event (another tab/worker
 * holds an older version open) closes our connection per contract so the
 * holder's upgrade can proceed; callers see a rejection and retry later.
 */
export function openIdb(
  name: string,
  version: number,
  onUpgrade: (db: IDBDatabase, oldVersion: number, tx: IDBTransaction) => void,
): Promise<IdbDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name, version);
    request.onupgradeneeded = (event) => {
      const db = request.result;
      const tx = request.transaction;
      if (tx === null) return;
      onUpgrade(db, event.oldVersion, tx);
    };
    request.onblocked = () => {
      request.result.close();
      reject(new Error(`database "${name}" upgrade blocked by another connection`));
    };
    request.onsuccess = () => {
      const db = request.result;
      // If another connection upgrades later, close immediately.
      db.onversionchange = () => db.close();
      resolve(new IdbDatabase(db));
    };
    request.onerror = () => reject(request.error ?? new Error(`failed to open "${name}"`));
  });
}

// ---- primitive helpers (usable inside withStore/withStores callbacks) ----

export function idbGet<T>(store: IDBObjectStore, key: IDBValidKey): Promise<T | undefined> {
  return requestToPromise<T | undefined>(store.get(key) as IDBRequest<T | undefined>);
}

export function idbPut(store: IDBObjectStore, value: unknown, key?: IDBValidKey): Promise<void> {
  const request = key === undefined ? store.put(value) : store.put(value, key);
  return requestToPromise(request).then(() => undefined);
}

export function idbDelete(store: IDBObjectStore, key: IDBValidKey): Promise<void> {
  return requestToPromise(store.delete(key)).then(() => undefined);
}

export function idbClear(store: IDBObjectStore): Promise<void> {
  return requestToPromise(store.clear()).then(() => undefined);
}

export function idbCount(store: IDBObjectStore, range?: IDBKeyRange): Promise<number> {
  return requestToPromise(range === undefined ? store.count() : store.count(range));
}

/** All values in key order, optionally bounded by range/limit. */
export async function idbGetAll<T>(
  store: IDBObjectStore,
  range?: IDBKeyRange,
  limit?: number,
): Promise<T[]> {
  if (limit === undefined) {
    const all = await requestToPromise(
      (range === undefined ? store.getAll() : store.getAll(range)) as IDBRequest<T[]>,
    );
    return all;
  }
  // Bounded scan via cursor (no store.getAll(range, limit) overload on all engines).
  const out: T[] = [];
  const request = (
    range === undefined ? store.openCursor() : store.openCursor(range)
  ) as IDBRequest<IDBCursorWithValue | null>;
  let cursor = await requestToPromise(request);
  while (cursor !== null && out.length < limit) {
    out.push(cursor.value as T);
    cursor = await continueCursor(request, cursor);
  }
  return out;
}

/** Values from an index in index order, optionally bounded. */
export async function idbGetByIndex<T>(
  index: IDBIndex,
  range?: IDBKeyRange,
  limit?: number,
): Promise<T[]> {
  const out: T[] = [];
  const request = (
    range === undefined ? index.openCursor() : index.openCursor(range)
  ) as IDBRequest<IDBCursorWithValue | null>;
  let cursor = await requestToPromise(request);
  while (cursor !== null && (limit === undefined || out.length < limit)) {
    out.push(cursor.value as T);
    cursor = await continueCursor(request, cursor);
  }
  return out;
}

/** Open an index cursor request (kept for callers that loop manually). */
export function openIndexCursor(
  index: IDBIndex,
  range: IDBKeyRange | undefined,
  direction: IDBCursorDirection,
): IDBRequest<IDBCursorWithValue | null> {
  return (
    range === undefined
      ? index.openCursor(undefined, direction)
      : index.openCursor(range, direction)
  ) as IDBRequest<IDBCursorWithValue | null>;
}

/** Await a cursor's next value via its opening request. */
export function continueIndexCursor(
  request: IDBRequest<IDBCursorWithValue | null>,
  cursor: IDBCursorWithValue,
): Promise<IDBCursorWithValue | null> {
  return continueCursor(request, cursor);
}

/** Count entries in an index for a range. */
export function idbCountByIndex(index: IDBIndex, range?: IDBKeyRange): Promise<number> {
  return requestToPromise(range === undefined ? index.count() : index.count(range));
}
