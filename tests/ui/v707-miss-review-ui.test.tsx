import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MissReviewSection } from '@/entrypoints/options/MissReviewSection';
import type { Backend } from '@/ui/messaging';
import { defaultSettings } from '@/domain/settings';
import { defaultRules } from '@/domain/rules';
import type { MissReviewEntry } from '@/domain/miss-review';

/**
 * V7-07 UI: the local miss-review diagnostics section lives on the Review
 * tab. It lists bounded entries, explains each miss reason in plain language,
 * clears only on explicit confirmation, and exports a private local snapshot
 * only on explicit user action.
 */

const ENTRY: MissReviewEntry = {
  id: 'v-miss1',
  videoId: 'v-miss1',
  title: 'A video the filter passed',
  channelName: 'Channel',
  surface: 'home',
  surfaces: ['home', 'search'],
  reason: 'below-threshold',
  firstSeenAt: 1_700_000_000_000,
  lastSeenAt: 1_700_000_100_000,
  sightingCount: 3,
};

function backend(overrides: Partial<Backend> = {}): Backend {
  return {
    getSettings: vi.fn(async () => defaultSettings()),
    saveSettings: vi.fn(async () => {}),
    getRules: vi.fn(async () => defaultRules()),
    getReview: vi.fn(async () => []),
    getReviewSummaries: vi.fn(async () => []),
    listMissReview: vi.fn(async () => [ENTRY]),
    clearMissReview: vi.fn(async () => true),
    exportMissReview: vi.fn(async () => [ENTRY]),
    queryHistory: vi.fn(async () => ({ items: [], total: 0, page: 1, pageSize: 25 })),
    getHistoryEvents: vi.fn(async () => []),
    deleteSummaries: vi.fn(async () => ({ deleted: [], missing: [] })),
    getSummaries: vi.fn(async () => []),
    putSummaries: vi.fn(async () => {}),
    getStats: vi.fn(async () => ({
      cardsEvaluated: 0,
      hidden: 0,
      restored: 0,
      falsePositiveCorrections: 0,
      sessionHidden: 0,
      warned: 0,
    })),
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
  } as Backend;
}

beforeEach(() => {
  vi.stubGlobal('browser', {
    storage: {
      local: {
        get: vi.fn(async (key: string) => ({ [key]: undefined })),
        set: vi.fn(async () => {}),
        remove: vi.fn(async () => {}),
      },
    },
    runtime: { getURL: (path: string) => `chrome-extension://test/${path}` },
  });
});

describe('V7-07: MissReviewSection', () => {
  it('lists entries with a plain-language reason and sighting count', async () => {
    render(<MissReviewSection backend={backend()} />);
    await waitFor(() => expect(screen.getByText('A video the filter passed')).toBeDefined());
    const text = document.body.textContent ?? '';
    expect(text).toContain('Below threshold');
    expect(text).toContain('seen 3×');
    expect(text).toContain('home');
  });

  it('shows the privacy line: local diagnostics, never training', async () => {
    render(<MissReviewSection backend={backend()} />);
    await waitFor(() => expect(screen.getByText('A video the filter passed')).toBeDefined());
    const text = document.body.textContent ?? '';
    expect(text).toMatch(/never (?:used for )?training|not training/i);
    expect(text).toMatch(/stays on this device|local/i);
  });

  it('clear requires confirmation and calls the backend', async () => {
    const b = backend({
      listMissReview: vi
        .fn(async () => [ENTRY])
        .mockResolvedValueOnce([ENTRY])
        .mockResolvedValueOnce([]),
    });
    render(<MissReviewSection backend={b} />);
    await waitFor(() => expect(screen.getByText('A video the filter passed')).toBeDefined());
    fireEvent.click(screen.getByRole('button', { name: /^clear$/i }));
    // Confirmation step first.
    fireEvent.click(screen.getByRole('button', { name: /confirm clear/i }));
    await waitFor(() => expect(b.clearMissReview).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByText('A video the filter passed')).toBeNull());
  });

  it('export triggers a local JSON download from the backend snapshot', async () => {
    const b = backend();
    const createObjectURL = vi.fn(() => 'blob:test');
    const revokeObjectURL = vi.fn();
    const click = vi.fn();
    const anchor = { href: '', download: '', click, style: {} } as unknown as HTMLAnchorElement;
    vi.stubGlobal('URL', {
      ...URL,
      createObjectURL,
      revokeObjectURL,
    });
    const originalCreateElement = document.createElement.bind(document);
    vi.spyOn(document, 'createElement').mockImplementation(((
      tag: string,
      opts?: ElementCreationOptions,
    ) =>
      tag === 'a' ? anchor : originalCreateElement(tag, opts)) as typeof document.createElement);
    render(<MissReviewSection backend={b} />);
    await waitFor(() => expect(screen.getByText('A video the filter passed')).toBeDefined());
    fireEvent.click(screen.getByRole('button', { name: /export/i }));
    await waitFor(() => expect(b.exportMissReview).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(click).toHaveBeenCalled());
    expect(anchor.download).toMatch(/miss-review.*\.json$/i);
    vi.restoreAllMocks();
  });

  it('empty queue renders the honest empty state', async () => {
    render(<MissReviewSection backend={backend({ listMissReview: vi.fn(async () => []) })} />);
    await waitFor(() =>
      expect(document.body.textContent ?? '').toMatch(/no missed videos recorded/i),
    );
  });
});
