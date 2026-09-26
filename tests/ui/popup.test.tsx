import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { PopupApp } from '@/entrypoints/popup/App';
import type { Backend } from '@/ui/messaging';
import { defaultSettings } from '@/domain/settings';
import { defaultStats } from '@/domain/stats';

function fakeBackend(overrides: Partial<Backend> = {}): Backend {
  let settings = defaultSettings();
  return {
    getSettings: vi.fn(async () => settings),
    saveSettings: vi.fn(async (next) => {
      settings = next;
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
    getDailyStats: vi.fn(async () => {
      const now = new Date();
      const key = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(
        now.getDate(),
      ).padStart(2, '0')}`;
      return {
        version: 1 as const,
        currentDay: key,
        days: {
          [key]: {
            hides: 5,
            warns: 3,
            restores: 0,
            manualBlocks: 0,
            distinctHidden: new Set(['a', 'b', 'c', 'd', 'e']),
            distinctWarned: new Set(['f', 'g', 'h']),
          },
        },
      };
    }),
    resetDailyStats: async () => true,
    getOnboardingState: async () => ({ completed: true, version: 1 }),
    completeOnboarding: async () => true,
    ...overrides,
  };
}

describe('PopupApp', () => {
  it('renders the enable control as an explicit On/Off choice', async () => {
    render(<PopupApp backend={fakeBackend()} />);
    const on = await screen.findByRole('radio', { name: 'On' });
    expect(on).toBeChecked();
  });

  it('changes mode via radio group', async () => {
    const backend = fakeBackend();
    render(<PopupApp backend={backend} />);
    const user = userEvent.setup();
    // The mode radios are visually hidden but keyboard reachable via labels.
    const strict = await screen.findByRole('radio', { name: /strict/i });
    await user.click(strict);
    expect(backend.saveSettings).toHaveBeenCalledWith(expect.objectContaining({ mode: 'strict' }));
  });

  it('disabling calls saveSettings with enabled=false', async () => {
    const backend = fakeBackend();
    render(<PopupApp backend={backend} />);
    const user = userEvent.setup();
    const off = await screen.findByRole('radio', { name: 'Off' });
    await user.click(off);
    expect(backend.saveSettings).toHaveBeenCalledWith(expect.objectContaining({ enabled: false }));
  });

  it('quick control sets an explicit category action (no cycling)', async () => {
    const backend = fakeBackend();
    render(<PopupApp backend={backend} />);
    const user = userEvent.setup();
    const control = await screen.findByRole('combobox', { name: /AI thumbnail/ });
    await user.selectOptions(control, 'hide');
    expect(backend.saveSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        categoryActions: expect.objectContaining({ 'ai-thumbnail': 'hide' }),
      }),
    );
  });

  it('shows local-day outcomes from the daily buckets (distinct videos, not lifetime)', async () => {
    const backend = fakeBackend();
    render(<PopupApp backend={backend} />);
    const statsSection = await screen.findByRole('region', { name: 'Outcomes today' });
    expect(statsSection.textContent).toContain('distinct');
    expect(statsSection.textContent).toMatch(/hidden/);
    expect(statsSection.textContent).toMatch(/warned/);
    // The misleading cumulative section must be gone.
    expect(screen.queryByRole('region', { name: 'Statistics' })).toBeNull();
  });

  it('renders an error state that does not block YouTube', async () => {
    const backend = fakeBackend({
      getSettings: vi.fn(async () => {
        throw new Error('backend unreachable');
      }),
    });
    render(<PopupApp backend={backend} />);
    expect(await screen.findByRole('alert')).toBeInTheDocument();
  });
});
