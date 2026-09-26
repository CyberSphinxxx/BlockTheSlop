import {
  ONBOARDING_VERSION,
  type OnboardingState,
  validateOnboardingState,
} from '@/domain/onboarding';
import type { KVStore } from './db';
import { STORAGE_KEYS } from './keys';

/**
 * Durable onboarding state (V6-02). Lives in storage.local so it survives
 * service-worker suspension, browser restarts and updates. Deliberately kept
 * OUT of UserSettings: Skip must be able to record completion without ever
 * touching (or implying a write to) the user's filter settings, and settings
 * patches from popup/options must never clobber onboarding state.
 */
export class OnboardingStore {
  constructor(private readonly kv: KVStore) {}

  async load(): Promise<OnboardingState> {
    return validateOnboardingState(await this.kv.get<unknown>(STORAGE_KEYS.onboarding));
  }

  async save(state: OnboardingState): Promise<void> {
    await this.kv.set(STORAGE_KEYS.onboarding, validateOnboardingState(state));
  }

  async markCompleted(): Promise<void> {
    const state = await this.load();
    await this.save({
      ...state,
      completed: true,
      version: Math.max(state.version, ONBOARDING_VERSION),
    });
  }

  /** Local-only; stored only when the user gives an explicit answer (V6-03). */
  async setDiscoverySource(source: OnboardingState['discoverySource']): Promise<void> {
    const state = await this.load();
    await this.save({ ...state, discoverySource: source });
  }
}
