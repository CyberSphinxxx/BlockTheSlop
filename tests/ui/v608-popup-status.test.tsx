import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { PopupApp } from '@/entrypoints/popup/App';
import type { Backend } from '@/ui/messaging';
import { defaultSettings } from '@/domain/settings';
import { defaultStats } from '@/domain/stats';
import type { DailyStatsState } from '@/domain/stats-daily';

function dailyStats(overrides: Partial<DailyStatsState['days'][string]> = {}): DailyStatsState {
  const today = new Date();
  const key = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(
    today.getDate(),
  ).padStart(2, '0')}`;
  return {
    version: 1,
    currentDay: key,
    days: {
      [key]: {
        hides: 3,
        warns: 2,
        restores: 1,
        manualBlocks: 0,
        distinctHidden: new Set(['a', 'b', 'c']),
        distinctWarned: new Set(['d', 'e']),
        ...overrides,
      },
    },
  };
}

const globalAny = globalThis as Record<string, unknown>;

function stubTabs(tab: { id?: number; url?: string } | null): void {
  globalAny['browser'] = {
    ...((globalAny['browser'] as object) ?? {}),
    tabs: {
      query: vi.fn(async () => (tab ? [tab] : [])),
      sendMessage: vi.fn(async (_id: number, msg: { type: string }) => {
        if (msg.type === 'session:listHides') return { hides: [] };
        if (msg.type === 'orchestrator:status') {
          return { state: 'active', surface: 'home', distinctHidden: 2, collectLocalStats: true };
        }
        return {};
      }),
      create: vi.fn(async () => ({})),
    },
    runtime: {
      id: 'test-extension',
      getURL: (p: string) => `chrome-extension://test/${p}`,
      sendMessage: vi.fn(async () => ({})),
    },
    storage: {
      local: {
        get: async () => ({}),
        set: async () => {},
      },
      onChanged: { addListener: () => {}, removeListener: () => {} },
    },
  };
}

function fakeBackend(overrides: Partial<Backend> = {}): Backend {
  let settings = defaultSettings();
  return {
    getSettings: vi.fn(async () => settings),
    saveSettings: vi.fn(async (patch) => {
      settings = { ...settings, ...patch };
    }),
    getRules: vi.fn(async () => ({
      allowedVideoIds: [],
      blockedVideoIds: [],
      allowedChannelIds: [],
      blockedChannelIds: [],
      fallbackAllowedHandles: [],
      fallbackBlockedHandles: [],
      blockedPhrases: [],
      blockedPhraseRules: [],
    })),
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
    getOnboardingState: vi.fn(async () => ({ completed: true, version: 1 })),
    completeOnboarding: vi.fn(async () => true),
    getDailyStats: vi.fn(async () => dailyStats()),
    resetDailyStats: vi.fn(async () => true),
    ...overrides,
  };
}

describe('popup active-tab status (V6-08)', () => {
  it('shows ACTIVE with the surface and this-page distinct hidden count', async () => {
    stubTabs({ id: 1, url: 'https://www.youtube.com/' });
    render(<PopupApp backend={fakeBackend()} />);
    await screen.findByText(/active/i);
    const body = document.body.textContent ?? '';
    expect(body).toMatch(/home/i);
    expect(body).toMatch(/2/); // distinct hidden on THIS page
  });

  it('shows UNAVAILABLE on a non-YouTube tab (never a fake connected state)', async () => {
    stubTabs({ id: 1, url: 'https://example.com/page' });
    render(<PopupApp backend={fakeBackend()} />);
    await screen.findByText(/not available here|unsupported/i);
  });

  it('shows the daily-bucketed counts under an explicit local-day label', async () => {
    stubTabs({ id: 1, url: 'https://www.youtube.com/' });
    render(<PopupApp backend={fakeBackend()} />);
    // The old misleading cumulative "Today" section is GONE.
    await waitFor(() => expect(screen.queryByText(/^Today$/)).toBeNull());
    const body = document.body.textContent ?? '';
    expect(body).toMatch(/3/); // hidden today (distinct)
    expect(body).toMatch(/2/); // warned today
  });

  it('explains when statistics collection is off (no fake zero)', async () => {
    stubTabs({ id: 1, url: 'https://www.youtube.com/' });
    // Audit M3: the note is sourced from the AUTHORITATIVE settings (the
    // content-script report is advisory only), so the fixture disables it there.
    const backend = fakeBackend({
      getSettings: vi.fn(async () => ({ ...defaultSettings(), collectLocalStats: false })),
    });
    (
      globalAny['browser'] as {
        tabs: { sendMessage: (id: number, msg: { type: string }) => unknown };
      }
    ).tabs.sendMessage = vi.fn(async (_id: number, msg: { type: string }) => {
      if (msg.type === 'orchestrator:status') {
        return { state: 'active', surface: 'home', distinctHidden: 0, collectLocalStats: false };
      }
      return { hides: [] };
    });
    render(<PopupApp backend={backend} />);
    await screen.findByText(/statistics are turned off|not being collected/i);
  });

  it('audit M3: the collection-off note is sourced from settings, not the status report', async () => {
    stubTabs({ id: 1, url: 'https://www.youtube.com/' });
    // Content script NOT loaded (sendMessage rejects) but settings say stats
    // off: the note must STILL render because it comes from the authoritative
    // settings, not the absent content-script report.
    (
      globalAny['browser'] as {
        tabs: { sendMessage: (id: number, msg: { type: string }) => unknown };
      }
    ).tabs.sendMessage = vi.fn(async () => {
      throw new Error('could not establish connection');
    });
    const backend = fakeBackend({
      getSettings: vi.fn(async () => ({ ...defaultSettings(), collectLocalStats: false })),
    });
    render(<PopupApp backend={backend} />);
    await screen.findByText(/statistics are turned off/i);
  });
});

describe('popup quick controls (V6-09)', () => {
  it('mode switch is explicit (no cycling) and saves immediately', async () => {
    stubTabs({ id: 1, url: 'https://www.youtube.com/' });
    const backend = fakeBackend();
    render(<PopupApp backend={backend} />);
    // Explicit labeled choices, not a click-cycling button:
    await screen.findByRole('radio', { name: /safe/i });
    await screen.findByRole('radio', { name: /balanced/i });
    await screen.findByRole('radio', { name: /strict/i });
    await screen.findByRole('radio', { name: /aggressive/i });
    await userEvent.click(screen.getByRole('radio', { name: /strict/i }));
    await waitFor(() => expect(backend.saveSettings).toHaveBeenCalledWith({ mode: 'strict' }));
  });

  it('category quick controls use explicit labeled choices (allow/warn/hide), no cycling', async () => {
    stubTabs({ id: 1, url: 'https://www.youtube.com/' });
    const backend = fakeBackend();
    render(<PopupApp backend={backend} />);
    await screen.findByText('Quick controls');
    const selects = screen.getAllByRole('combobox');
    expect(selects.length).toBeGreaterThan(0);
    await userEvent.selectOptions(selects[0]!, 'hide');
    await waitFor(() => expect(backend.saveSettings).toHaveBeenCalled());
  });

  it('rolls back the visible value when the save fails', async () => {
    stubTabs({ id: 1, url: 'https://www.youtube.com/' });
    const backend = fakeBackend({
      saveSettings: vi.fn(async () => {
        throw new Error('storage unavailable');
      }),
    });
    render(<PopupApp backend={backend} />);
    await screen
      .findByRole('radio', { name: /balanced/i })
      .then(() => undefined)
      .catch(() => undefined);
    const strictRadio = await screen.findByRole('radio', { name: /strict/i });
    await userEvent.click(strictRadio);
    // Visible error and the control returns to the stored value.
    await screen.findByRole('alert');
    await waitFor(() => {
      const balanced = screen.getByRole('radio', { name: /balanced/i }) as HTMLInputElement;
      expect(balanced.checked).toBe(true);
    });
  });
});
