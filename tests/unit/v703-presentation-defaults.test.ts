import { describe, expect, it } from 'vitest';
import { buildOnboardingSettingsPatch, defaultOnboardingDraft } from '@/domain/onboarding';
import {
  defaultSettings,
  migrateSettings,
  SETTINGS_EFFECT_KEYS,
  validateSettings,
  type UserSettings,
} from '@/domain/settings';
import { SettingsStore } from '@/storage/settings-store';
import { MemoryKVStore } from '@/storage/db';

/**
 * V7-03: presentation defaults and live transition CONTRACTS, pinned as unit
 * tests so a future regression fails here, not on a user's screen:
 *
 * - Collapse is the default Hide presentation for NEW users.
 * - Existing users' saved Placeholder survives migration at every hop.
 * - The onboarding Hide choice must NEVER downgrade collapse to placeholder.
 * - displayMode is decision-relevant for open tabs (live transitions).
 * - Partial/corrupt settings blobs fall back to the collapse default, never
 *   to placeholder.
 */

describe('V7-03: displayMode defaults', () => {
  it('defaultSettings() uses collapse (new users are gap-free)', () => {
    expect(defaultSettings().displayMode).toBe('collapse');
  });

  it('validateSettings falls back to collapse on garbage/absent values', () => {
    expect(validateSettings({})?.displayMode).toBe('collapse');
    expect(validateSettings({ displayMode: 'neither' })?.displayMode).toBe('collapse');
    expect(validateSettings(null)).toBeNull();
    expect(validateSettings({ displayMode: 'placeholder' })?.displayMode).toBe('placeholder');
  });

  it('a corrupt stored blob loads as collapse defaults (never placeholder)', async () => {
    const kv = new MemoryKVStore();
    await kv.set('local:settings', 'not-an-object' as unknown);
    const store = new SettingsStore(kv);
    const { settings } = await store.load();
    expect(settings.displayMode).toBe('collapse');
  });
});

describe('V7-03: migration preserves an existing user\u2019s explicit Placeholder', () => {
  const PLACEHOLDER_USER: Record<string, unknown> = {
    enabled: true,
    mode: 'balanced',
    displayMode: 'placeholder',
  };

  it('every migration hop keeps placeholder for the existing user', () => {
    for (const from of [3, 4, 5, 6, 7]) {
      const migrated = migrateSettings(PLACEHOLDER_USER, from);
      expect(migrated?.displayMode, `migration from v${from}`).toBe('placeholder');
    }
  });

  it('legacy v2 users with showExplanations=false keep collapse; true keeps placeholder', () => {
    const collapseUser = migrateSettings(
      { enabled: true, mode: 'balanced', showExplanations: false },
      2,
    );
    expect(collapseUser?.displayMode).toBe('collapse');
    const placeholderUser = migrateSettings(
      { enabled: true, mode: 'balanced', showExplanations: true },
      2,
    );
    expect(placeholderUser?.displayMode).toBe('placeholder');
  });

  it('schema v7 stored users keep their saved mode through a store round-trip', async () => {
    const kv = new MemoryKVStore();
    await kv.set('local:schemaVersion', 7);
    await kv.set('local:settings', PLACEHOLDER_USER);
    const { settings } = await new SettingsStore(kv).load();
    expect(settings.displayMode).toBe('placeholder');
  });
});

describe('V7-03: onboarding Hide choice selects Collapse', () => {
  it('never downgrades a collapse default to placeholder', () => {
    const current: UserSettings = defaultSettings(); // displayMode: 'collapse'
    for (const treatment of ['hide', 'warn'] as const) {
      const patch = buildOnboardingSettingsPatch(
        { ...defaultOnboardingDraft(), treatment },
        current,
      );
      expect('displayMode' in patch, 'patch must not touch displayMode').toBe(false);
      const merged = { ...current, ...patch };
      expect(merged.displayMode).toBe('collapse');
    }
  });

  it('preserves an existing Placeholder user\u2019s saved mode through onboarding', () => {
    const existing = { ...defaultSettings(), displayMode: 'placeholder' as const };
    const patch = buildOnboardingSettingsPatch(defaultOnboardingDraft(), existing);
    expect('displayMode' in patch).toBe(false);
    expect({ ...existing, ...patch }.displayMode).toBe('placeholder');
  });
});

describe('V7-03: displayMode is a live-transition key for open tabs', () => {
  it('SETTINGS_EFFECT_KEYS marks displayMode as presentation (triggers rescan)', () => {
    expect(SETTINGS_EFFECT_KEYS['displayMode']).toBe('presentation');
  });
});
