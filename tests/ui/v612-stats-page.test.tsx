import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { StatsTab } from '@/entrypoints/options/StatsTab';
import type { Backend } from '@/ui/messaging';
import type { DailyStatsState } from '@/domain/stats-daily';
import { dayBucketFor } from '@/domain/stats-daily';

function bucket(hides: number, distinct: number) {
  const hidden = new Set<string>();
  for (let i = 0; i < distinct; i++) hidden.add(`v${i}`);
  return {
    hides,
    warns: 0,
    restores: 0,
    manualBlocks: 0,
    distinctHidden: hidden,
    distinctWarned: new Set<string>(),
  };
}

function dailyState(days: Record<string, ReturnType<typeof bucket>>): DailyStatsState {
  return { version: 1, days, currentDay: dayBucketFor(Date.now()) };
}

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
    getOnboardingState: vi.fn(async () => ({ completed: true, version: 1 })),
    completeOnboarding: vi.fn(async () => true),
    getDailyStats: vi.fn(async () => dailyState({})),
    resetDailyStats: vi.fn(async () => true),
    ...overrides,
  };
}

import { defaultSettings } from '@/domain/settings';
import { defaultRules } from '@/domain/rules';
import { defaultStats } from '@/domain/stats';

describe('statistics page (V6-12)', () => {
  it('shows the empty state honestly (no fake zeros)', async () => {
    render(<StatsTab backend={fakeBackend()} />);
    await screen.findByText(/no outcomes recorded in this range/i);
    expect(document.body.textContent).toMatch(/never uploaded/i);
  });

  it('renders distinct vs event counts separately with a real data table', async () => {
    const today = dayBucketFor(Date.now());
    const backend = fakeBackend({
      getDailyStats: vi.fn(
        async () => dailyState({ [today]: bucket(5, 3) }), // 5 sightings, 3 distinct
      ),
    });
    render(<StatsTab backend={backend} />);
    await screen.findByRole('table');
    // The distinct count (3) is shown with the sighting annotation (5 sightings).
    expect(screen.getByText(/\(5 sightings\)/)).toBeDefined();
    const table = screen.getByRole('table');
    expect(table.textContent).toContain('3');
    expect(table.textContent).toContain('(5 sightings)');
    // The distinction is explained in the caption.
    expect(document.body.textContent).toMatch(/unique videos/i);
  });

  it('range switching changes the visible days', async () => {
    const today = dayBucketFor(Date.now());
    const backend = fakeBackend({
      getDailyStats: vi.fn(async () => dailyState({ [today]: bucket(1, 1) })),
    });
    render(<StatsTab backend={backend} />);
    await screen.findByRole('table');
    await userEvent.click(screen.getByRole('tab', { name: 'Last 7 days' }));
    await waitFor(() =>
      expect(screen.getByRole('tab', { name: 'Last 7 days' })).toHaveAttribute(
        'aria-selected',
        'true',
      ),
    );
    // Today's row remains visible under the 7-day range.
    expect(screen.getByText(today)).toBeDefined();
  });

  it('reset requires confirmation and never touches rules/review backend calls', async () => {
    const today = dayBucketFor(Date.now());
    const backend = fakeBackend({
      getDailyStats: vi.fn(async () => dailyState({ [today]: bucket(1, 1) })),
    });
    render(<StatsTab backend={backend} />);
    await screen.findByRole('table');
    await userEvent.click(screen.getByRole('button', { name: 'Reset statistics…' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog.textContent).toMatch(/rules/i);
    expect(dialog.textContent).toMatch(/NOT affected/i);
    await userEvent.click(screen.getByRole('button', { name: 'Reset statistics' }));
    await waitFor(() => expect(backend.resetDailyStats).toHaveBeenCalled());
    // No rules/review destructive calls were made.
    expect(backend.clearHistory).not.toHaveBeenCalled();
    expect(backend.deleteSummaries).not.toHaveBeenCalled();
  });

  it('shows an error state with Retry when loading fails', async () => {
    const backend = fakeBackend({
      getDailyStats: vi.fn(async () => {
        throw new Error('storage unavailable');
      }),
    });
    render(<StatsTab backend={backend} />);
    await screen.findByRole('alert');
    expect(screen.getByRole('alert').textContent).toMatch(/storage unavailable/i);
    expect(screen.getByRole('button', { name: 'Retry' })).toBeDefined();
  });

  it('audit H3: multi-day distinct tiles are a UNION, not a per-day sum', async () => {
    const day0 = dayBucketFor(Date.now());
    const day1 = dayBucketFor(Date.now() - 86_400_000);
    // v0 re-sighted on day0 (2 sightings, 1 distinct); v1 hidden on day1.
    const reseen = {
      hides: 2,
      warns: 0,
      restores: 0,
      manualBlocks: 0,
      distinctHidden: new Set(['v0']),
      distinctWarned: new Set<string>(),
    };
    const otherDay = {
      hides: 1,
      warns: 0,
      restores: 0,
      manualBlocks: 0,
      distinctHidden: new Set(['v1']),
      distinctWarned: new Set<string>(),
    };
    const backend = fakeBackend({
      getDailyStats: vi.fn(async () => dailyState({ [day0]: reseen, [day1]: otherDay })),
    });
    render(<StatsTab backend={backend} />);
    await userEvent.click(await screen.findByRole('tab', { name: 'Last 7 days' }));
    await screen.findByRole('table');
    // v0 + v1 = 2 distinct across the range (pre-fix summed per-day sizes = 3).
    const distinctTile = screen.getByText('Distinct hidden').parentElement;
    expect(distinctTile?.textContent).toContain('2');
    // Events remain 3 sightings; the re-sighted day annotates the difference.
    expect(document.body.textContent).toMatch(/\(2 sightings\)/);
  });

  it('audit H2: collection-off is read from real settings and explained', async () => {
    const backend = fakeBackend({
      getSettings: vi.fn(async () => ({ ...defaultSettings(), collectLocalStats: false })),
    });
    render(<StatsTab backend={backend} />);
    await screen.findByRole('note');
    expect(screen.getByRole('note').textContent).toMatch(/currently OFF/i);
    expect(screen.getByRole('note').textContent).toMatch(/no data was deleted/i);
  });

  it('audit H2: collection ON renders no note (state is real, not hardcoded)', async () => {
    const backend = fakeBackend({
      getSettings: vi.fn(async () => ({ ...defaultSettings(), collectLocalStats: true })),
      getDailyStats: vi.fn(async () => dailyState({ [dayBucketFor(Date.now())]: bucket(1, 1) })),
    });
    render(<StatsTab backend={backend} />);
    await screen.findByRole('table');
    expect(screen.queryByRole('note')).toBeNull();
  });
});
