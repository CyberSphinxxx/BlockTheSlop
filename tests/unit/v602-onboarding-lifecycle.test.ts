import { beforeEach, describe, expect, it } from 'vitest';
import {
  ONBOARDING_VERSION,
  defaultOnboardingState,
  decideOnboardingOpener,
  isTrueFirstInstall,
  validateOnboardingState,
} from '@/domain/onboarding';
import { OnboardingStore } from '@/storage/onboarding-store';
import { MemoryKVStore } from '@/storage/db';

describe('onboarding domain model (V6-02)', () => {
  it('default state is not completed and unopened', () => {
    const state = defaultOnboardingState();
    expect(state.completed).toBe(false);
    expect(state.version).toBe(ONBOARDING_VERSION);
    expect(state.discoverySource).toBeUndefined();
  });

  it('validates and repairs corrupt stored state without throwing', () => {
    expect(validateOnboardingState(undefined)).toEqual(defaultOnboardingState());
    expect(validateOnboardingState(null)).toEqual(defaultOnboardingState());
    expect(validateOnboardingState('nonsense')).toEqual(defaultOnboardingState());
    expect(validateOnboardingState({ completed: true, version: 1 })).toEqual({
      completed: true,
      version: 1,
      discoverySource: undefined,
    });
    // Invalid enums repair to defaults, never throw.
    expect(validateOnboardingState({ completed: 'yes', version: 'x', discoverySource: 5 })).toEqual(
      defaultOnboardingState(),
    );
  });

  it('isTrueFirstInstall: only install reason on a fresh profile is a true first install', () => {
    const hasOnboarded = (reason: string): boolean =>
      isTrueFirstInstall(reason, validateOnboardingState({ completed: true, version: 1 }));
    const fresh = validateOnboardingState(undefined);
    expect(isTrueFirstInstall('install', fresh)).toBe(true);
    expect(hasOnboarded('install')).toBe(false); // completed state blocks re-onboarding
    expect(isTrueFirstInstall('update', fresh)).toBe(false);
    expect(isTrueFirstInstall('chrome_update', fresh)).toBe(false);
    expect(isTrueFirstInstall('shared_module_update', fresh)).toBe(false);
    expect(isTrueFirstInstall('browser_update', fresh)).toBe(false);
    expect(isTrueFirstInstall('unknown', fresh)).toBe(false);
  });

  it('decideOnboardingOpener: idempotent, never duplicates, never forces onboarding on existing users', () => {
    const fresh = validateOnboardingState(undefined);
    const done = validateOnboardingState({ completed: true, version: 1 });
    // First install on fresh profile opens exactly once.
    expect(
      decideOnboardingOpener('install', fresh, { hasOnboardingTab: false, openedThisRun: false }),
    ).toEqual({
      open: true,
      markOpening: true,
    });
    // Second onInstalled event with opening already marked: no duplicate tab.
    expect(
      decideOnboardingOpener('install', fresh, { hasOnboardingTab: false, openedThisRun: true }),
    ).toEqual({
      open: false,
      markOpening: true,
    });
    // An onboarding tab already exists (e.g. reload of the tab itself): no new tab.
    expect(decatepenerHelper('install', fresh, true)).toEqual({ open: false, markOpening: true });
    // Existing user (state says completed): update/reload/install reasons never force.
    expect(
      decideOnboardingOpener('update', done, { hasOnboardingTab: false, openedThisRun: false }),
    ).toEqual({
      open: false,
      markOpening: false,
    });
    expect(
      decideOnboardingOpener('install', done, { hasOnboardingTab: false, openedThisRun: false }),
    ).toEqual({
      open: false,
      markOpening: false,
    });
  });

  it('decideOnboardingOpener: interrupted install does NOT nag on browser restart (recover via Settings/popup instead)', () => {
    const interrupted = validateOnboardingState({ completed: false, version: 1 });
    expect(
      decideOnboardingOpener('chrome_update', interrupted, {
        hasOnboardingTab: false,
        openedThisRun: false,
      }),
    ).toEqual({ open: false, markOpening: false });
  });
});

function decatepenerHelper(
  reason: string,
  state: ReturnType<typeof defaultOnboardingState>,
  hasOnboardingTab: boolean,
): { open: boolean; markOpening: boolean } {
  return decideOnboardingOpener(reason, state, { hasOnboardingTab, openedThisRun: false });
}

describe('onboarding store (V6-02)', () => {
  let kv: MemoryKVStore;
  let store: OnboardingStore;

  beforeEach(() => {
    kv = new MemoryKVStore();
    store = new OnboardingStore(kv);
  });

  it('returns defaults and persists completion + discovery source', async () => keyCycle(store));

  it('respects a completed legacy state after migration and never re-opens', async () => {
    await kv.set('local:onboarding', { completed: true, version: 1 });
    const state = await store.load();
    expect(state.completed).toBe(true);
    expect(
      decideOnboardingOpener('install', state, { hasOnboardingTab: false, openedThisRun: false })
        .open,
    ).toBe(false);
  });

  it('survives a service-worker restart: state is durable, not in-memory', async () => {
    await store.markCompleted();
    const rebornStore = new OnboardingStore(kv); // new worker, same storage
    expect((await rebornStore.load()).completed).toBe(true);
  });
});

async function keyCycle(store: OnboardingStore): Promise<void> {
  const state = await store.load();
  expect(state.completed).toBe(false);
  await store.setDiscoverySource('friend');
  await store.markCompleted();
  const after = await store.load();
  expect(after.completed).toBe(true);
  expect(after.discoverySource).toBe('friend');
}
