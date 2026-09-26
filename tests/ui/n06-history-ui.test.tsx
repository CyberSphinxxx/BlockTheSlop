import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { OptionsApp } from '@/entrypoints/options/App';
import type { Backend } from '@/ui/messaging';
import type { HistoryQuery, HistoryQueryResult } from '@/storage/history-repository';
import { defaultSettings } from '@/domain/settings';
import { defaultRules } from '@/domain/rules';
import { defaultStats } from '@/domain/stats';

/** Generous waitFor timeout: parallel CI runners can stall >1s on round-trips. */
const WAIT = { timeout: 10_000 };

// Multi-round-trip interaction tests can exceed the 5s default under load.
vi.setConfig({ testTimeout: 30_000 });

/**
 * N06 (UI) — history pagination contract in the options page.
 *
 * Filters reset to page one, selection is scoped to the current query window,
 * and a slow in-flight response never clobbers a newer one (HIS-05).
 */

function page(items: string[], total: number, pageSize = 25, pageNo = 1): HistoryQueryResult {
  return {
    items: items.map((key) => ({
      key,
      videoId: key.slice(2),
      title: `Title for ${key}`,
      channelId: undefined,
      channelName: undefined,
      handle: undefined,
      surfaces: ['home'] as const,
      latestDecision: { action: 'hide' as const, reason: 'automatic' as const, explanation: ['x'] },
      resolution: 'pending' as const,
      firstSeen: 1_700_000_000_000,
      lastSeen: 1_700_000_000_000,
      count: 1,
      evidenceSummary: '',
      revision: 1,
    })),
    total,
    page: pageNo,
    pageSize,
  };
}

/** Backend whose queryHistory is scriptable per test. */
function backendWith(impl: (q: HistoryQuery) => Promise<HistoryQueryResult>): Backend {
  return {
    getSettings: vi.fn(async () => defaultSettings()),
    saveSettings: vi.fn(async () => {}),
    getRules: vi.fn(async () => defaultRules()),
    getReview: vi.fn(async () => []),
    getReviewSummaries: vi.fn(async () => []),
    listMissReview: vi.fn(async () => []),
    clearMissReview: vi.fn(async () => true),
    exportMissReview: vi.fn(async () => []),
    queryHistory: vi.fn(impl),
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
  } as unknown as Backend;
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

async function openReview(): Promise<void> {
  await screen.findByRole('button', { name: 'General' }, WAIT);
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: 'Review history' }));
  await waitFor(() => expect(screen.getByLabelText('Search history')).toBeInTheDocument(), WAIT);
}

describe('N06 history UI pagination', () => {
  it('changing a filter resets to page 1', async () => {
    const user = userEvent.setup();
    // Echo the requested page so the UI actually advances between clicks.
    const backend = backendWith(async (q) => page(['v:a', 'v:b'], 60, 25, q.page));
    render(<OptionsApp backend={backend} />);
    await openReview();

    // Walk to page 3.
    await user.click(await screen.findByRole('button', { name: 'Next →' }, WAIT));
    await waitFor(() => expect(screen.getByText(/Page 2 \/ 3/)).toBeInTheDocument(), WAIT);
    await user.click(screen.getByRole('button', { name: 'Next →' }));
    await waitFor(() => expect(screen.getByText(/Page 3 \/ 3/)).toBeInTheDocument(), WAIT);

    // Any filter change must land back on page 1.
    await user.selectOptions(screen.getByLabelText('Filter by status'), 'restored');
    await waitFor(() => {
      const calls = (backend.queryHistory as ReturnType<typeof vi.fn>).mock.calls;
      const last = calls[calls.length - 1]![0] as HistoryQuery;
      expect(last.page).toBe(1);
      expect(last.status).toBe('restored');
    }, WAIT);
  });

  it('a no-op debounce commit (trimmed value unchanged) never reverts the page', async () => {
    const user = userEvent.setup();
    const backend = backendWith(async (q) => page(['v:a', 'v:b'], 60, 25, q.page));
    render(<OptionsApp backend={backend} />);
    await openReview();

    const searchBox = screen.getByLabelText('Search history');
    await user.type(searchBox, 'a');
    await waitFor(() => {
      const calls = (backend.queryHistory as ReturnType<typeof vi.fn>).mock.calls;
      const last = calls[calls.length - 1]![0] as HistoryQuery;
      expect(last.search).toBe('a');
    }, WAIT);

    await user.click(screen.getByRole('button', { name: 'Next →' }));
    await waitFor(() => expect(screen.getByText(/Page 2 \/ 3/)).toBeInTheDocument(), WAIT);

    // Typing a space leaves the trimmed search value unchanged: the pending
    // debounce commit is a no-op and must NOT reset the page (the mount-time
    // effect made this revert real users' page changes within 250ms).
    await user.type(searchBox, ' ');
    await act(async () => {
      await new Promise((r) => setTimeout(r, 400));
    });
    await waitFor(() => expect(screen.getByText(/Page 2 \/ 3/)).toBeInTheDocument(), WAIT);
  });

  it('page-size change resets to page 1 and is validated against the allowed sizes', async () => {
    const user = userEvent.setup();
    const backend = backendWith(async (q) => page(['v:a'], 60, 25, q.page));
    render(<OptionsApp backend={backend} />);
    await openReview();

    await user.click(await screen.findByRole('button', { name: 'Next →' }, WAIT));
    await user.selectOptions(screen.getByLabelText('Rows per page'), '50');
    await waitFor(() => {
      const calls = (backend.queryHistory as ReturnType<typeof vi.fn>).mock.calls;
      const last = calls[calls.length - 1]![0] as HistoryQuery;
      expect(last.page).toBe(1);
      expect(last.pageSize).toBe(50);
    }, WAIT);
  });

  it('debounced search resets to page 1 and is trimmed', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      let lastQuery: HistoryQuery | null = null;
      const backend = backendWith(async (q) => {
        lastQuery = q;
        return page(['v:a'], 1);
      });
      render(<OptionsApp backend={backend} />);
      await openReview();

      await user.type(screen.getByLabelText('Search history'), '  slop  ');
      await vi.advanceTimersByTimeAsync(400);
      await waitFor(() => {
        expect(lastQuery).not.toBeNull();
        expect(lastQuery!.search).toBe('slop');
        expect(lastQuery!.page).toBe(1);
      }, WAIT);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a slow stale response never clobbers a newer query (HIS-05)', async () => {
    const user = userEvent.setup();
    const gates: Array<(v: HistoryQueryResult) => void> = [];
    const queries: HistoryQuery[] = [];
    // The initial load resolves immediately; every later query hangs until its
    // gate is released.
    const backend = backendWith((q) => {
      queries.push(q);
      if (queries.length === 1) {
        return Promise.resolve(page(['v:initial'], 1));
      }
      return new Promise<HistoryQueryResult>((resolve) => {
        gates.push(resolve);
      });
    });
    render(<OptionsApp backend={backend} />);
    await openReview();
    await screen.findByText('Title for v:initial', undefined, WAIT);

    // Search (debounced → query 2) hangs; then a status filter (query 3) fires.
    await user.type(screen.getByLabelText('Search history'), 'slop');
    await waitFor(() => expect(queries.length).toBeGreaterThanOrEqual(2), WAIT);
    await user.selectOptions(screen.getByLabelText('Filter by status'), 'restored');
    await waitFor(() => expect(queries.length).toBe(3), WAIT);

    // The NEWER (query 3) response lands first; the STALE (query 2, search)
    // resolves last and must be dropped.
    gates[1]!(page(['v:fresh'], 1));
    await waitFor(() => expect(screen.getByText('Title for v:fresh')).toBeInTheDocument(), WAIT);
    gates[0]!(page(['v:stale-search'], 1));
    await waitFor(
      () => expect(screen.queryByText('Title for v:stale-search')).not.toBeInTheDocument(),
      WAIT,
    );
    expect(screen.getByText('Title for v:fresh')).toBeInTheDocument();
  });

  it('empty total renders the empty state, not the pager', async () => {
    const backend = backendWith(async () => page([], 0));
    render(<OptionsApp backend={backend} />);
    await openReview();
    await waitFor(() => expect(screen.getByText(/Nothing hidden yet/i)).toBeInTheDocument(), WAIT);
    expect(screen.queryByRole('button', { name: 'Next →' })).not.toBeInTheDocument();
  });
});
