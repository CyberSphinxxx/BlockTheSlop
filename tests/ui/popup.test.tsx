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
    })),
    getReview: vi.fn(async () => []),
    getReviewSummaries: vi.fn(async () => []),
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
    ...overrides,
  };
}

describe('PopupApp', () => {
  it('renders the enable toggle with an accessible label', async () => {
    render(<PopupApp backend={fakeBackend()} />);
    const toggle = await screen.findByRole('checkbox', { name: 'On' });
    expect(toggle).toBeChecked();
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
    const toggle = await screen.findByRole('checkbox', { name: 'On' });
    await user.click(toggle);
    expect(backend.saveSettings).toHaveBeenCalledWith(expect.objectContaining({ enabled: false }));
  });

  it('quick control cycles category action and persists', async () => {
    const backend = fakeBackend();
    render(<PopupApp backend={backend} />);
    const user = userEvent.setup();
    const control = await screen.findByRole('button', { name: /AI thumbnail: currently/i });
    await user.click(control);
    expect(backend.saveSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        categoryActions: expect.objectContaining({ 'ai-thumbnail': 'hide' }),
      }),
    );
  });

  it('shows today stats', async () => {
    const backend = fakeBackend({
      getStats: vi.fn(async () => ({ ...defaultStats(), hidden: 23, warned: 8 })),
    });
    render(<PopupApp backend={backend} />);
    const statsSection = await screen.findByRole('region', { name: 'Statistics' });
    expect(statsSection.textContent).toContain('23');
    expect(statsSection.textContent).toContain('hidden');
    expect(statsSection.textContent).toContain('8');
    expect(statsSection.textContent).toContain('warned');
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
