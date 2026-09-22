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

  async apply(mutation: RuleMutation): Promise<UserRules> {
    const rules = await this.load();
    const next = applyRuleMutation(rules, mutation);
    await this.save(next);
    return next;
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
