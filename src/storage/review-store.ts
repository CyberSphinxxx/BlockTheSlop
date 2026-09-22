import { REVIEW_MAX_RECORDS, validateReviewRecords, type ReviewRecord } from '@/domain/review';
import type { KVStore } from './db';
import { STORAGE_KEYS } from './keys';

/** Persists hidden-content review records with a bounded retention policy. */
export class ReviewStore {
  constructor(private readonly kv: KVStore) {}

  async load(): Promise<ReviewRecord[]> {
    const raw = await this.kv.get<unknown>(STORAGE_KEYS.reviewRecords);
    return validateReviewRecords(raw) ?? [];
  }

  async save(records: ReviewRecord[]): Promise<void> {
    // Enforce retention: newest first, drop overflow.
    const sorted = [...records]
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, REVIEW_MAX_RECORDS);
    await this.kv.set(STORAGE_KEYS.reviewRecords, sorted);
  }

  /** Insert or update by id; deduplicates and caps history. */
  async upsert(record: ReviewRecord): Promise<void> {
    const records = await this.load();
    const index = records.findIndex((r) => r.id === record.id);
    if (index >= 0) {
      records[index] = record;
    } else {
      records.push(record);
    }
    await this.save(records);
  }

  async get(id: string): Promise<ReviewRecord | undefined> {
    const records = await this.load();
    return records.find((r) => r.id === id);
  }

  async clear(): Promise<void> {
    await this.kv.remove(STORAGE_KEYS.reviewRecords);
  }
}
