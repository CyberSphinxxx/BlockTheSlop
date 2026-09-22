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
    }),
    getReview: async () => [],
    getReviewSummaries: async () => [],
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
});

// Silence unused-var lint for the vi import used only as a type helper above.
void vi;
