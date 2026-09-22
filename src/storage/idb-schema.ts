import { openIdb, idbGet, idbPut, type IdbDatabase } from './idb';

/**
 * Extension-origin IndexedDB schema (R10/04 §4).
 *
 * Settings/rules stay in storage.local (small versioned snapshot); growing
 * history, events, corrections, classification cache, operation journal,
 * quarantine, and meta live here.
 */
export const IDB_NAME = 'block-the-slop';
export const IDB_SCHEMA_VERSION = 1;

export const STORES = {
  reviewSummaries: 'reviewSummaries',
  reviewEvents: 'reviewEvents',
  corrections: 'corrections',
  classificationCache: 'classificationCache',
  operations: 'operations',
  quarantine: 'quarantine',
  meta: 'meta',
} as const;

export type StoreName = (typeof STORES)[keyof typeof STORES];

export const ALL_STORES: readonly StoreName[] = [
  STORES.reviewSummaries,
  STORES.reviewEvents,
  STORES.corrections,
  STORES.classificationCache,
  STORES.operations,
  STORES.quarantine,
  STORES.meta,
];

/** Creates the v1 schema inside a versionchange transaction. */
function upgradeToV1(db: IDBDatabase): void {
  const summaries = db.createObjectStore(STORES.reviewSummaries, { keyPath: 'key' });
  summaries.createIndex('lastSeen', ['lastSeen', 'key']);
  summaries.createIndex('status', ['resolution', 'lastSeen', 'key']);
  summaries.createIndex('videoId', 'videoId', { unique: false });

  const events = db.createObjectStore(STORES.reviewEvents, { keyPath: 'eventId' });
  events.createIndex('bySummary', ['summaryKey', 'occurredAt']);
  events.createIndex('byTime', ['occurredAt', 'eventId']);

  const corrections = db.createObjectStore(STORES.corrections, { keyPath: 'videoId' });
  corrections.createIndex('updatedAt', 'updatedAt');

  const cache = db.createObjectStore(STORES.classificationCache, { keyPath: 'cacheKey' });
  cache.createIndex('videoId', 'videoId', { unique: false });
  cache.createIndex('expiresAt', 'expiresAt');

  db.createObjectStore(STORES.operations, { keyPath: 'operationId' });
  db.createObjectStore(STORES.quarantine, { keyPath: 'id' });
  db.createObjectStore(STORES.meta, { keyPath: 'key' });
}

const UPGRADES: readonly ((db: IDBDatabase) => void)[] = [upgradeToV1];

/**
 * Open the extension database, applying any pending upgrades.
 * Rejects with an `upgrade-needed` marker when the stored schema is NEWER
 * than this build supports (data must be preserved untouched, 04 §6).
 */
export async function openExtensionDb(): Promise<IdbDatabase> {
  const db = await openIdb(IDB_NAME, IDB_SCHEMA_VERSION, (database, oldVersion) => {
    for (let v = oldVersion; v < UPGRADES.length; v++) UPGRADES[v]?.(database);
  });
  const meta = await getMeta<Record<string, unknown>>(db, 'db');
  const stored = meta?.['schemaVersion'];
  if (typeof stored === 'number' && stored > IDB_SCHEMA_VERSION) {
    db.close();
    throw new UpgradeNeededError(stored);
  }
  await putMeta(db, 'db', { ...(meta ?? {}), schemaVersion: IDB_SCHEMA_VERSION });
  return db;
}

/** Thrown when the on-disk database is newer than this build supports. */
export class UpgradeNeededError extends Error {
  constructor(public readonly storedVersion: number) {
    super(`database schema ${storedVersion} is newer than supported ${IDB_SCHEMA_VERSION}`);
    this.name = 'UpgradeNeededError';
  }
}

export async function getMeta<T>(db: IdbDatabase, key: string): Promise<T | undefined> {
  return db.withStore(STORES.meta, 'readonly', async (store) => {
    const entry = await idbGet<{ key: string; value: T }>(store, key);
    return entry?.value;
  });
}

export async function putMeta(db: IdbDatabase, key: string, value: unknown): Promise<void> {
  await db.withStore(STORES.meta, 'readwrite', (store) => store.put({ key, value }));
}

export { idbGet, idbPut };
