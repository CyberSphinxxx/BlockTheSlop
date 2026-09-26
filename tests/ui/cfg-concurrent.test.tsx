import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { OptionsApp } from '@/entrypoints/options/App';
import { RuntimeBackend, type Backend } from '@/ui/messaging';
import { defaultSettings, type UserSettings } from '@/domain/settings';

// Real RuntimeBackend against a shared storage.local stub — the CFG-03
// contract is about what happens when two surfaces save concurrently.
beforeEach(() => {
  const storage: Record<string, unknown> = {
    'local:settings': defaultSettings(),
  };
  const stub = {
    storage: {
      local: {
        get: async (key: string) => ({ [key]: storage[key] }),
        set: async (items: Record<string, unknown>) => {
          Object.assign(storage, items);
        },
        remove: async (key: string) => {
          delete storage[key];
        },
      },
      onChanged: {
        addListener: () => undefined,
        removeListener: () => undefined,
      },
    },
    runtime: {
      // getSettings() in RuntimeBackend sends a message; answer it from the
      // same storage so load works in this stub environment.
      sendMessage: async (request: { type: string }) => {
        if (request.type === 'settings:get') {
          return storage['local:settings'];
        }
        return undefined;
      },
    },
  };
  (globalThis as Record<string, unknown>)['browser'] = stub;
});

/** RuntimeBackend only for getSettings/saveSettings (the merge under test);
    everything else gets inert defaults so the options page can render. */
function storageBackend(): Backend {
  const backend = new RuntimeBackend();
  return {
    getSettings: () => backend.getSettings(),
    saveSettings: (s: Partial<UserSettings>) => backend.saveSettings(s),
    getRules: async () => ({
      allowedVideoIds: [],
      blockedVideoIds: [],
      allowedChannelIds: [],
      blockedChannelIds: [],
      fallbackAllowedHandles: [],
      fallbackBlockedHandles: [],
      blockedPhrases: [],
      blockedPhraseRules: [],
    }),
    getReview: async () => [],
    getReviewSummaries: async () => [],
    listMissReview: async () => [],
    clearMissReview: async () => true,
    exportMissReview: async () => [],
    getStats: async () => ({
      cardsEvaluated: 0,
      hidden: 0,
      restored: 0,
      falsePositiveCorrections: 0,
      sessionHidden: 0,
      warned: 0,
    }),
    queryHistory: async () => ({ items: [], total: 0, page: 1, pageSize: 25 }),
    getHistoryEvents: async () => [],
    restoreSummary: async () => true,
    setCorrection: async () => undefined,
    deleteSummaries: async () => ({ deleted: [], missing: [] }),
    getSummaries: async () => [],
    putSummaries: async () => undefined,
    clearHistory: async () => undefined,
    getQuarantine: async () => [],
    clearCache: async () => undefined,
    clearCorrections: async () => undefined,
    resetStats: async () => undefined,
    getDailyStats: async () => ({ version: 1, days: {}, currentDay: '2026-09-25' }),
    resetDailyStats: async () => true,
    getOnboardingState: async () => ({ completed: true, version: 1 }),
    completeOnboarding: async () => true,
  } as unknown as Backend;
}

describe('CFG-03 concurrent options/popup edits', () => {
  it('an edit made in the popup survives a subsequent options save (merge, not overwrite)', async () => {
    const backend = storageBackend();
    const options = render(<OptionsApp backend={backend} />);
    const user = userEvent.setup();

    // Popup-equivalent edit first (exactly what PopupApp.save does).
    const popupStyleSave = defaultSettings();
    await backend.saveSettings({ ...popupStyleSave, enabled: false });

    // Now change a DIFFERENT field in options.
    await user.click(await screen.findByRole('button', { name: 'Filtering' }));
    const strict = await screen.findByRole('radio', { name: /strict/i });
    await user.click(strict);

    await waitFor(async () => {
      const stored = (await browser.storage.local.get('local:settings'))[
        'local:settings'
      ] as Record<string, unknown>;
      expect(stored['mode']).toBe('strict');
      expect(stored['enabled']).toBe(false);
    });
    options.unmount();
  });

  it('settings changed between load and save are not clobbered when untouched', async () => {
    const backend = storageBackend();
    const options = render(<OptionsApp backend={backend} />);
    const user = userEvent.setup();

    await screen.findByRole('button', { name: 'General' });

    // External writer (simulating the popup) flips density while options sits open.
    const current = defaultSettings();
    await backend.saveSettings({ ...current, density: 'compact' });

    // Options saves a mode change only.
    await user.click(await screen.findByRole('button', { name: 'Filtering' }));
    await user.click(await screen.findByRole('radio', { name: /strict/i }));

    await waitFor(async () => {
      const stored = (await browser.storage.local.get('local:settings'))[
        'local:settings'
      ] as Record<string, unknown>;
      expect(stored['mode']).toBe('strict');
      expect(stored['density']).toBe('compact');
    });
    options.unmount();
  });
  // N04 blocker-5: a failed save must NOT keep the optimistic value — the UI
  // rolls back to the last persisted settings and shows a visible error.
  it('a rejected save rolls the UI back and shows an error state', async () => {
    const backend = storageBackend();
    let rejectNext = true;
    const failing: Backend = {
      ...backend,
      saveSettings: async (patch: Partial<UserSettings>) => {
        if (rejectNext) {
          rejectNext = false;
          throw new Error('storage write rejected');
        }
        return backend.saveSettings(patch);
      },
    };
    const options = render(<OptionsApp backend={failing} />);
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: 'Filtering' }));
    await user.click(await screen.findByRole('radio', { name: /strict/i }));

    // The failure is visible…
    await waitFor(() => {
      expect(screen.getByTestId('save-status').textContent).toContain('Save failed');
    });
    // …the optimistic value was ROLLED BACK (UI shows the persisted value)…
    await waitFor(() => {
      const balanced = document.querySelector(
        'input[name="opt-mode"][value="balanced"]',
      ) as HTMLInputElement;
      expect(balanced.checked).toBe(true);
      const strict = document.querySelector(
        'input[name="opt-mode"][value="strict"]',
      ) as HTMLInputElement;
      expect(strict.checked).toBe(false);
    });
    // …and storage never received the change.
    const stored = (await browser.storage.local.get('local:settings'))['local:settings'] as Record<
      string,
      unknown
    >;
    expect(stored['mode']).not.toBe('strict');
    options.unmount();
  });

  // N04 blocker-5: TRUE overlapping writes — options and popup save different
  // fields while both saves are in flight; neither edit may be lost.
  it('truly overlapping options+popup saves both survive (no lost update)', async () => {
    const backend = storageBackend();
    const options = render(<OptionsApp backend={backend} />);
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: 'Filtering' }));
    // Fire the options save (mode → strict) and, before it resolves, a popup
    // save of a DIFFERENT field. RuntimeBackend merges each patch against
    // FRESH storage, so the second writer cannot clobber the first.
    const optionsSave = (async () => {
      await user.click(await screen.findByRole('radio', { name: /strict/i }));
    })();
    const popupSave = backend.saveSettings({ displayMode: 'collapse' });
    await Promise.all([optionsSave, popupSave]);

    await waitFor(async () => {
      const stored = (await browser.storage.local.get('local:settings'))[
        'local:settings'
      ] as Record<string, unknown>;
      expect(stored['mode']).toBe('strict');
      expect(stored['displayMode']).toBe('collapse');
    });
    options.unmount();
  });
});

// Silence unused-var lint for the vi import used only as a type helper above.
void vi;
