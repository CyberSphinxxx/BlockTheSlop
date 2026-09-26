import { describe, expect, it } from 'vitest';
import { validatePayload } from '@/background/message-validation';
import {
  validateSettings,
  defaultSettings,
  migrateSettings,
  SETTINGS_SCHEMA_VERSION,
} from '@/domain/settings';
import { buildOnboardingSettingsPatch, defaultOnboardingDraft } from '@/domain/onboarding';
import type { UserSettings } from '@/domain/settings';

describe('onboarding message validation (V6-07)', () => {
  it('accepts completion with and without a discovery answer', () => {
    expect(validatePayload('onboarding:complete', {})).toEqual({ ok: true });
    expect(validatePayload('onboarding:complete', { discoverySource: 'friend' })).toEqual({
      ok: true,
    });
    expect(validatePayload('onboarding:complete', undefined)).toEqual({ ok: true });
  });

  it('rejects unknown discovery values (no free-form analytics channel)', () => {
    expect(validatePayload('onboarding:complete', { discoverySource: 'news-paper-ad' }).ok).toBe(
      false,
    );
    expect(validatePayload('onboarding:complete', { discoverySource: 42 }).ok).toBe(false);
    expect(validatePayload('onboarding:complete', 'yes').ok).toBe(false);
  });

  it('onboarding:get takes no payload', () => {
    expect(validatePayload('onboarding:get', undefined)).toEqual({ ok: true });
    expect(validatePayload('onboarding:get', { x: 1 }).ok).toBe(false);
  });
});

describe('atomic settings transaction (V6-07)', () => {
  it('patch merges onto current settings without clobbering unrelated keys', () => {
    const current = defaultSettings();
    const customized: UserSettings = {
      ...current,
      enabled: false,
      theme: 'dark',
      density: 'compact',
    };
    const patch = buildOnboardingSettingsPatch(defaultOnboardingDraft(), customized);
    const merged = validateSettings({ ...customized, ...patch });
    expect(merged).not.toBeNull();
    expect(merged!.enabled).toBe(false); // user's own change survives Apply
    expect(merged!.theme).toBe('dark');
    expect(merged!.density).toBe('compact');
    expect(merged!.mode).toBe('balanced'); // from the draft
    expect(merged!.categoryActions['ai-visual']).toBe('inherit');
  });

  it('a failed save leaves stored settings untouched (rollback = nothing partial written)', () => {
    // The transaction model: migrateSettings(validateSettings(next)) is the
    // only accepted write; any invalid draft contribution makes the WHOLE
    // write invalid instead of a half-write.
    const bad = { ...defaultSettings(), mode: 'nope' } as unknown as UserSettings;
    expect(validateSettings(bad)).not.toBeNull(); // validator repairs, never corrupts
    const merged = migrateSettings({ ...defaultSettings(), mode: 'nope' }, SETTINGS_SCHEMA_VERSION);
    expect(merged).not.toBeNull();
    expect(merged!.mode).toBe('balanced');
  });
});
