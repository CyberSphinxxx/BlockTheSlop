import { decideOnboardingOpener, validateOnboardingState } from '@/domain/onboarding';
import type { OnboardingStore } from '@/storage/onboarding-store';
import { logger } from '@/shared/logger';

/**
 * V6-02: the opener is the ONLY place onboarding is ever auto-opened, and
 * only from `runtime.onInstalled` (reason filtered by decideOnboardingOpener).
 * Kept in its own module so the decision is testable without importing the
 * whole background worker (whose import has storage/menu side effects).
 * It never runs at module import time — the background wires it explicitly.
 */
export function wireOnboardingOpener(
  api: {
    runtime: {
      onInstalled: { addListener(cb: (details: { reason: string }) => void): void };
    };
    tabs: {
      query(query: { url: string }): Promise<Array<{ id?: number | undefined }>>;
      create(props: { url: string }): Promise<unknown>;
    };
  },
  getOnboardingUrl: () => string,
  stores: { onboarding: OnboardingStore },
): void {
  // Duplicate-event guard for THIS worker lifetime: onInstalled can fire more
  // than once (browser quirk/re-enable) and a racing second event would not
  // yet see the first tab via tabs.query. Across worker restarts the durable
  // tabs.query + completed-state checks cover dedup instead.
  let openedThisRun = false;
  api.runtime.onInstalled.addListener(({ reason }) => {
    void (async () => {
      const state = await stores.onboarding.load();
      const urlPattern = getOnboardingUrl();
      let hasOnboardingTab = false;
      try {
        const tabs = await api.tabs.query({ url: urlPattern });
        hasOnboardingTab = tabs.length > 0;
        if (tabs.length > 1) {
          logger.warn('multiple onboarding tabs detected', tabs.length);
        }
      } catch {
        // tabs.query failure must never crash the install handler; the
        // conservative read is "maybe a tab exists" so we do not duplicate.
        hasOnboardingTab = true;
      }
      const decision = decideOnboardingOpener(reason, state, {
        hasOnboardingTab,
        openedThisRun,
      });
      if (!decision.open) return;
      openedThisRun = true; // set BEFORE the async create: no double-open race
      await stores.onboarding.save(validateOnboardingState({ ...state }));
      await api.tabs.create({ url: urlPattern }).catch((error: unknown) => {
        // Tab-open failure: allow a later event to retry, never crash install.
        openedThisRun = false;
        logger.error('onboarding tab could not be opened', error);
      });
    })();
  });
}
