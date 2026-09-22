import { validateReviewRecords, REVIEW_MAX_RECORDS, type ReviewRecord } from '@/domain/review';
import { videoKey, type CorrectionRecord } from '@/domain/history';
import type { KVStore } from './db';
import { STORAGE_KEYS } from './keys';
import { idbGet, type IdbDatabase } from './idb';
import { STORES, getMeta, putMeta } from './idb-schema';
import type { HistoryRepository } from './history-repository';
import type { CorrectionStore } from './correction-store';
import type { QuarantineStore } from './quarantine-store';

/**
 * Legacy → IDB migration (R13, 04 §6).
 *
 * Stages (each resumable, all writes idempotent):
 *   snapshot → commit → verify → complete (+ bounded rollback backup)
 *
 * - Corrections are extracted across ALL legacy records per video and merged
 *   into the dedicated corrections store (independent of review retention).
 * - Summaries merge by identity: firstSeen=min, lastSeen=max, count=sum.
 * - Legacy records without videoId keep an unresolved-identity session key
 *   (hash of title+channel+surface); handles are NEVER derived from names.
 * - Invalid records are quarantined (bounded, exportable), not discarded.
 * - Old keys are deleted only AFTER durable verified commit; the legacy
 *   snapshot is retained until a subsequent successful startup.
 */

const MIGRATION_META_KEY = 'legacyStorageMigration';
const SESSION_KEY_PREFIX = 'legacy-u';

/** Deterministic session key for legacy records without a video id. */
function legacySessionKey(record: ReviewRecord): string {
  const basis = [record.title, record.channelId ?? record.channelName ?? '', record.surface].join(
    '\u0000',
  );
  let hash = 0x811c9dc5;
  for (let i = 0; i < basis.length; i++) {
    hash ^= basis.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return `${SESSION_KEY_PREFIX}-${(hash >>> 0).toString(36)}-${record.id}`;
}

export interface LegacyMigrationResult {
  status: 'not-needed' | 'complete' | 'already-complete' | 'verified-pending-cleanup';
  summaries: number;
  corrections: number;
  quarantined: number;
  verified: boolean;
}

interface MigrationJournal {
  status: 'snapshot' | 'commit' | 'complete';
  records?: ReviewRecord[] | undefined;
  invalidCount?: number | undefined;
  completedAt?: number | undefined;
  backupRetained?: boolean | undefined;
  lastVerifiedAt?: number | undefined;
}

/**
 * Verify a completed migration by checking that sampled per-record operation
 * journal entries still exist in the operations store (durable-commit proof).
 */
async function verifyMigratedOperations(
  db: IdbDatabase,
  records: readonly ReviewRecord[],
): Promise<boolean> {
  const sample = records.slice(0, 25);
  if (sample.length === 0) return true;
  return db.withStore(STORES.operations, 'readonly', async (store) => {
    for (const record of sample) {
      const op = await idbGet<{ operationId: string }>(store, `mig:${record.id}`);
      if (op === undefined) return false;
    }
    return true;
  });
}

export async function migrateLegacyStorage(deps: {
  kv: KVStore;
  db: IdbDatabase;
  history: HistoryRepository;
  corrections: CorrectionStore;
  quarantine: QuarantineStore;
}): Promise<LegacyMigrationResult> {
  const { kv, db, history, corrections, quarantine } = deps;
  const journal = await getMeta<MigrationJournal>(db, MIGRATION_META_KEY);

  // Already complete on a previous run: verify the commit (sampled operation
  // journal entries), drop the bounded rollback backup once proven, then fall
  // through so STRAGGLER legacy rows (written after the last run) still
  // migrate — the per-record operation ids make re-processing idempotent.
  if (journal?.status === 'complete') {
    if (journal.backupRetained === true) {
      const verifiedNow = await verifyMigratedOperations(db, journal.records ?? []);
      if (verifiedNow) {
        await putMeta(db, MIGRATION_META_KEY, {
          ...journal,
          backupRetained: false,
          records: [],
          lastVerifiedAt: Date.now(),
        });
        journal.backupRetained = false;
        journal.records = [];
      } else {
        return {
          status: 'verified-pending-cleanup',
          summaries: 0,
          corrections: 0,
          quarantined: 0,
          verified: false,
        };
      }
    }
    // Fall through: straggler rows below re-run the idempotent commit.
    const stragglers = validateReviewRecords(await kv.get<unknown>(STORAGE_KEYS.reviewRecords));
    if (stragglers === null || stragglers.length === 0) {
      return {
        status: 'already-complete',
        summaries: 0,
        corrections: 0,
        quarantined: 0,
        verified: true,
      };
    }
    // Keep rollback data for the merged batch (dedupe by id, bounded).
    const mergedBackup = new Map<string, ReviewRecord>();
    for (const r of journal.records ?? []) mergedBackup.set(r.id, r);
    for (const r of stragglers) mergedBackup.set(r.id, r);
    journal.records = [...mergedBackup.values()].slice(0, REVIEW_MAX_RECORDS);
    journal.backupRetained = true;
  }

  // ---- stage: snapshot (read + validate old records, journal them) ----
  const rawLegacy = await kv.get<unknown>(STORAGE_KEYS.reviewRecords);
  let records: ReviewRecord[] = [];
  let invalidCount = 0;
  if (rawLegacy !== undefined) {
    const validated = validateReviewRecords(rawLegacy);
    if (validated === null) {
      invalidCount = Array.isArray(rawLegacy) ? rawLegacy.length : 1;
      // Non-array payloads are quarantined as a bounded redacted item so the
      // data is never silently discarded (04 §6).
      await quarantine.add({
        reason: 'legacy review records were not a valid array',
        source: 'migration',
        preview: Array.isArray(rawLegacy) ? `(${rawLegacy.length} invalid records)` : '(redacted)',
      });
    } else {
      const validIds = new Set(validated.map((r) => r.id));
      const rawArray = Array.isArray(rawLegacy) ? rawLegacy : [];
      invalidCount = rawArray.length - validIds.size;
      records = validated;
      for (const item of rawArray) {
        const id =
          typeof item === 'object' &&
          item !== null &&
          typeof (item as Record<string, unknown>)['id'] === 'string'
            ? ((item as Record<string, unknown>)['id'] as string)
            : '(no-id)';
        if (!validIds.has(id) && id !== '(no-id)') {
          await quarantine.add({
            reason: 'legacy record failed validation',
            source: 'migration',
            preview: JSON.stringify({ id }).slice(0, 200),
          });
        } else if (id === '(no-id)') {
          await quarantine.add({
            reason: 'legacy record missing id',
            source: 'migration',
            preview: '(redacted)',
          });
        }
      }
    }
  }
  if (rawLegacy === undefined && journal === undefined) {
    await putMeta(db, MIGRATION_META_KEY, { status: 'complete', backupRetained: false });
    return { status: 'not-needed', summaries: 0, corrections: 0, quarantined: 0, verified: true };
  }

  const snapshot: MigrationJournal = {
    status: 'snapshot',
    records,
    invalidCount,
  };
  await putMeta(db, MIGRATION_META_KEY, snapshot);

  // ---- stage: commit (idempotent via deterministic operation ids) ----
  const now = Date.now();
  let summaryCount = 0;

  // Corrections: merge across ALL legacy records per video, write once each.
  const mergedCorrections = new Map<string, CorrectionRecord>();
  for (const record of records) {
    if (record.videoId === undefined) continue;
    if (record.correction === undefined || record.correction.length === 0) continue;
    const notAi = record.correction.includes('not-ai');
    const notSlop = record.correction.includes('not-slop');
    const existing = mergedCorrections.get(record.videoId);
    mergedCorrections.set(record.videoId, {
      videoId: record.videoId,
      notAi: (existing?.notAi ?? false) || notAi,
      notSlop: (existing?.notSlop ?? false) || notSlop,
      updatedAt: Math.max(existing?.updatedAt ?? 0, record.createdAt),
      revision: (existing?.revision ?? 0) + 1,
      source: 'migrated',
    });
  }
  for (const correction of mergedCorrections.values()) {
    const existing = await corrections.get(correction.videoId);
    if (existing === undefined) {
      await db.withStore(STORES.corrections, 'readwrite', (store) => store.put(correction));
    }
  }

  // Summaries: merge by identity; one event per legacy record.
  const summaryOps = new Map<string, { firstSeen: number; lastSeen: number; count: number }>();
  for (const record of records) {
    const key = videoKey(record.videoId, legacySessionKey(record));
    const agg = summaryOps.get(key) ?? {
      firstSeen: record.createdAt,
      lastSeen: record.createdAt,
      count: 0,
    };
    agg.firstSeen = Math.min(agg.firstSeen, record.createdAt);
    agg.lastSeen = Math.max(agg.lastSeen, record.createdAt);
    agg.count += 1;
    summaryOps.set(key, agg);

    await history.recordEvent(
      {
        key,
        videoId: record.videoId,
        title: record.title,
        channelId: record.channelId,
        channelName: record.channelName,
        surface: record.surface,
        decision: record.decision,
        occurredAt: record.createdAt,
        operationId: `mig:${record.id}`,
      },
      'hidden',
    );
  }
  summaryCount = summaryOps.size;

  // ---- stage: verify (batch-scoped, not store-scoped) ----
  // The durable store also legitimately contains post-migration browsing
  // history, so verification must check THIS batch's keys only (comparing the
  // whole store made migration never verify + never clean up once any hide
  // had been recorded).
  const correctionsCount = await corrections.count();
  const committedKeys = (
    await db.withStore(STORES.reviewSummaries, 'readonly', (store) => {
      const request = store.getAllKeys();
      return new Promise<IDBValidKey[]>((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error ?? new Error('getAllKeys failed'));
      });
    })
  ).map(String);
  const committedKeySet = new Set(committedKeys);
  const missingBatchKeys = [...summaryOps.keys()].filter((k) => !committedKeySet.has(k));
  const verified = missingBatchKeys.length === 0 && correctionsCount >= mergedCorrections.size;

  if (!verified) {
    // Keep legacy keys + backup for recovery; expose result for diagnostics.
    return {
      status: 'complete',
      summaries: summaryCount,
      corrections: mergedCorrections.size,
      quarantined: invalidCount,
      verified: false,
    };
  }

  await putMeta(db, MIGRATION_META_KEY, {
    status: 'complete',
    completedAt: now,
    backupRetained: true,
    records, // bounded rollback backup (≤ REVIEW_MAX_RECORDS, truncated fields)
    invalidCount,
  });

  // Durable commit proven: now (and only now) remove the old keys.
  await kv.remove(STORAGE_KEYS.reviewRecords);
  await kv.remove(STORAGE_KEYS.classificationCache); // cache semantics changed (fingerprint-keyed)

  return {
    status: 'complete',
    summaries: summaryCount,
    corrections: mergedCorrections.size,
    quarantined: invalidCount,
    verified: true,
  };
}

/** Exported for diagnostics: the cap mirrors the legacy retention bound. */
export const LEGACY_MIGRATION_MAX_RECORDS = REVIEW_MAX_RECORDS;
