import {
  applyRuleMutation,
  defaultRules,
  validateRules,
  type RuleMutation,
  type UserRules,
} from '@/domain/rules';
import type { KVStore } from './db';
import { STORAGE_KEYS } from './keys';

export class RuleStore {
  private mutationQueue: Promise<unknown> = Promise.resolve();

  constructor(private readonly kv: KVStore) {}

  async load(): Promise<UserRules> {
    const raw = await this.kv.get<unknown>(STORAGE_KEYS.rules);
    if (raw === undefined) return defaultRules();
    return validateRules(raw) ?? defaultRules();
  }

  async save(rules: UserRules): Promise<void> {
    const validated = validateRules(rules);
    if (validated === null) throw new Error('Refusing to persist invalid rules');
    await this.kv.set(STORAGE_KEYS.rules, validated);
  }

  /**
   * Apply a rule mutation atomically with sequential queue lock (V5-05).
   * Prevents concurrent writes from overwriting or losing updates.
   */
  async apply(mutation: RuleMutation): Promise<UserRules> {
    const run = async (): Promise<UserRules> => {
      const rules = await this.load();
      const next = applyRuleMutation(rules, mutation);
      await this.save(next);
      return next;
    };
    const nextPromise = this.mutationQueue.then(run, run);
    this.mutationQueue = nextPromise.catch(() => {});
    return nextPromise;
  }

  /**
   * Apply multiple rule mutations in a single atomic transaction (V5-05).
   */
  async applyBatch(mutations: readonly RuleMutation[]): Promise<UserRules> {
    const run = async (): Promise<UserRules> => {
      let next = await this.load();
      for (const m of mutations) {
        next = applyRuleMutation(next, m);
      }
      await this.save(next);
      return next;
    };
    const nextPromise = this.mutationQueue.then(run, run);
    this.mutationQueue = nextPromise.catch(() => {});
    return nextPromise;
  }

  /** Watch for external rule changes (options page edits while YouTube is open). */
  watch(callback: () => void): () => void {
    const listener = (changes: Record<string, { newValue?: unknown }>, area: string): void => {
      if (area !== 'local') return;
      if (STORAGE_KEYS.rules in changes) callback();
    };
    browser.storage.onChanged.addListener(listener);
    return () => {
      browser.storage.onChanged.removeListener(listener);
    };
  }
}
