import {
  MAX_MISS_REVIEW_ENTRIES,
  MAX_MISS_REVIEW_ENTRIES as CAP,
  serializeMissEntries,
  upsertMissEntry,
  validateMissEntries,
  type MissReviewEntry,
} from '@/domain/miss-review';
import type { KVStore } from './db';
import { STORAGE_KEYS } from './keys';

/**
 * V7-07: durable local miss-review store.
 *
 * Promise-chain mutex on every read-modify-write (same discipline as the
 * V6-audited DailyStatsStore): concurrent tab records can never lose updates.
 * Plain-JSON payloads only — the queue crosses process boundaries on export.
 */
export class MissReviewStore {
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly kv: KVStore) {}

  /** Serialize a critical section onto the per-instance chain. */
  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const next = this.chain.then(task, task);
    this.chain = next.catch(() => undefined);
    return next;
  }

  private async rawList(): Promise<MissReviewEntry[]> {
    const raw = await this.kv.get<unknown>(STORAGE_KEYS.missReview);
    return validateMissEntries(raw);
  }

  async record(input: {
    videoId: string | undefined;
    title: string;
    channelName?: string | undefined;
    surface: string;
    reason: MissReasonImport;
    seenAt: number;
    note?: string | undefined;
  }): Promise<void> {
    await this.enqueue(async () => {
      const entries = await this.rawList();
      const next = upsertMissEntry(entries, { ...input, videoId: input.videoId ?? undefined });
      // Hard bound enforced at the store boundary as well.
      await this.kv.set(STORAGE_KEYS.missReview, next.slice(0, CAP));
    });
  }

  async list(): Promise<MissReviewEntry[]> {
    return this.enqueue(() => this.rawList());
  }

  /** Explicit user action only — a private local snapshot, no network. */
  async exportForUser(): Promise<ReturnType<typeof serializeMissEntries>> {
    return this.enqueue(async () => serializeMissEntries(await this.rawList()));
  }

  async clear(): Promise<void> {
    await this.enqueue(() => this.kv.remove(STORAGE_KEYS.missReview));
  }
}

type MissReasonImport = Parameters<typeof upsertMissEntry>[1]['reason'];

export { MAX_MISS_REVIEW_ENTRIES };
