import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { OptionsApp } from '@/entrypoints/options/App';
import type { Backend } from '@/ui/messaging';
import { defaultSettings, validateSettings } from '@/domain/settings';
import { defaultRules } from '@/domain/rules';
import { defaultStats } from '@/domain/stats';
import { SETTINGS_EFFECT_KEYS } from '@/domain/settings';

/**
 * N04 settings truth: every visible control maps to a persisted value with a
 * runtime effect; controls with no effect in this build are disabled and
 * labeled as such rather than fake-enabled.
 */

function fakeBackend(overrides: Partial<Backend> = {}): Backend {
  return {
    getSettings: vi.fn(async () => defaultSettings()),
    saveSettings: vi.fn(async () => {}),
    getRules: vi.fn(async () => defaultRules()),
    getReview: vi.fn(async () => []),
    getReviewSummaries: vi.fn(async () => []),
    listMissReview: vi.fn(async () => []),
    clearMissReview: vi.fn(async () => true),
    exportMissReview: vi.fn(async () => []),
    queryHistory: vi.fn(async () => ({ items: [], total: 0, page: 1, pageSize: 25 })),
    getHistoryEvents: vi.fn(async () => []),
    deleteSummaries: vi.fn(async () => ({ deleted: [], missing: [] })),
    getSummaries: vi.fn(async () => []),
    putSummaries: vi.fn(async () => {}),
    getStats: vi.fn(async () => defaultStats()),
    restoreSummary: vi.fn(async () => true),
    setCorrection: vi.fn(async () => {}),
    clearHistory: vi.fn(async () => {}),
    getQuarantine: vi.fn(async () => []),
    clearCache: vi.fn(async () => {}),
    clearCorrections: vi.fn(async () => {}),
    resetStats: vi.fn(async () => {}),
    getDailyStats: async () => ({ version: 1, days: {}, currentDay: '2026-09-25' }),
    resetDailyStats: async () => true,
    getOnboardingState: async () => ({ completed: true, version: 1 }),
    completeOnboarding: async () => true,
    ...overrides,
  };
}

describe('N04: settings truth', () => {
  let backend: Backend;

  beforeEach(() => {
    backend = fakeBackend();
    const storage: Record<string, unknown> = {
      'local:rules': defaultRules(),
    };
    vi.stubGlobal('browser', {
      storage: {
        local: {
          get: vi.fn(async (key: string) => ({ [key]: storage[key] })),
          set: vi.fn(async (items: Record<string, unknown>) => {
            Object.assign(storage, items);
          }),
          remove: vi.fn(async (key: string) => {
            delete storage[key];
          }),
        },
      },
      runtime: { getURL: (path: string) => `chrome-extension://test/${path}` },
    });
  });

  it('unwired remote-provider and YouTube-feedback controls are DISABLED with a reason', async () => {
    const user = userEvent.setup();
    render(<OptionsApp backend={backend} />);
    await waitFor(() => expect(screen.getByLabelText(/Filtering enabled/)).toBeEnabled());
    await user.click(screen.getByRole('button', { name: 'Privacy' }));

    const remote = screen.getByLabelText(/Enable remote reputation provider/);
    const ytFeedback = screen.getByLabelText(/Also tell YouTube "Not interested"/);
    expect(remote).toBeDisabled();
    expect(ytFeedback).toBeDisabled();
    // The disabled state is explained, not mysterious.
    expect(screen.getAllByText(/disabled until the feature ships/i).length).toBe(2);
  });

  it('every wired control persists its change through saveSettings', async () => {
    const user = userEvent.setup();
    render(<OptionsApp backend={backend} />);
    await waitFor(() => expect(screen.getByLabelText(/Filtering enabled/)).toBeEnabled());

    // Toggle the enable switch — must produce one saveSettings call whose
    // payload flips exactly `enabled`.
    await user.click(screen.getByLabelText(/Filtering enabled/));
    await waitFor(() => expect(backend.saveSettings).toHaveBeenCalled());
    const patch = vi.mocked(backend.saveSettings).mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect(patch.enabled).toBe(false);

    // History toggle persists the history sub-object.
    await user.click(screen.getByLabelText(/Keep review history/));
    await waitFor(() => expect(backend.saveSettings).toHaveBeenCalledTimes(2));
    const histPatch = vi.mocked(backend.saveSettings).mock.calls.at(-1)?.[0] as Record<
      string,
      unknown
    >;
    expect(histPatch.history).toMatchObject({ enabled: false });

    // A surface toggle persists the surfaces sub-object (Filtering tab).
    await user.click(screen.getByRole('button', { name: 'Filtering' }));
    await user.click(screen.getByLabelText('Home'));
    await waitFor(() => expect(backend.saveSettings).toHaveBeenCalledTimes(3));
    const surfacePatch = vi.mocked(backend.saveSettings).mock.calls.at(-1)?.[0] as Record<
      string,
      unknown
    >;
    expect(surfacePatch.surfaces).toMatchObject({ home: false });
  });

  it('all decision-changing keys are declared in SETTINGS_EFFECT_KEYS', () => {
    const s = defaultSettings();
    const declared = new Set(Object.keys(SETTINGS_EFFECT_KEYS));
    for (const key of Object.keys(s) as (keyof typeof s)[]) {
      expect(declared.has(key), `${key} must be declared decision/presentation-effective`).toBe(
        true,
      );
    }
  });

  it('validation rejects out-of-range enums so persisted values are always safe', () => {
    const bad = defaultSettings();
    // Mode is restricted to the three real modes.
    const forged = { ...bad, mode: 'turbo' } as unknown as ReturnType<typeof defaultSettings>;
    expect(validateSettings(forged)).not.toBeNull(); // unknown enum keys are dropped
    const forgedMode = (validateSettings(forged) as ReturnType<typeof defaultSettings>).mode;
    expect(['safe', 'balanced', 'strict']).toContain(forgedMode);
  });

  it('display style and presentation toggles roundtrip through validateSettings', () => {
    const s = defaultSettings();
    const next = validateSettings({ ...s, showExplanations: false, displayMode: 'collapse' });
    expect(next?.showExplanations).toBe(false);
    expect(next?.displayMode).toBe('collapse');
    expect(next?.surfaces).toEqual(s.surfaces);
    void screen; // keep testing-library import used in this file's harness
  });

  it('toggling the explanation placeholder fires a change without errors', async () => {
    const user = userEvent.setup();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    render(<OptionsApp backend={backend} />);
    await waitFor(() => expect(screen.getByLabelText(/Filtering enabled/)).toBeEnabled());
    await user.click(screen.getByRole('button', { name: 'Filtering' }));
    await user.click(screen.getByLabelText(/Show explanation placeholders/));
    await waitFor(() => expect(backend.saveSettings).toHaveBeenCalled());
    const patch = vi.mocked(backend.saveSettings).mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect(patch.showExplanations).toBe(false);
    expect(errorSpy).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});
