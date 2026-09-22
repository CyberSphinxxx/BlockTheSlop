import { defaultStats, validateStats, type LocalStats, type StatsDelta } from '@/domain/stats';
import type { KVStore } from './db';
import { STORAGE_KEYS } from './keys';

export class StatsStore {
  constructor(private readonly kv: KVStore) {}

  async load(): Promise<LocalStats> {
    return validateStats(await this.kv.get<unknown>(STORAGE_KEYS.stats));
  }

  async save(stats: LocalStats): Promise<void> {
    await this.kv.set(STORAGE_KEYS.stats, validateStats(stats));
  }

  async apply(delta: StatsDelta): Promise<LocalStats> {
    const stats = await this.load();
    for (const [key, value] of Object.entries(delta)) {
      const k = key as keyof LocalStats;
      if (typeof value === 'number' && Number.isFinite(value)) {
        const current = stats[k];
        if (typeof current === 'number') {
          (stats[k] as number) = Math.min(current + value, Number.MAX_SAFE_INTEGER);
        }
      }
    }
    await this.save(stats);
    return stats;
  }

  async reset(): Promise<void> {
    await this.save({ ...defaultStats(), resetAt: Date.now() });
  }
}
