import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { OptionsApp } from '@/entrypoints/options/App';
import type { Backend } from '@/ui/messaging';
import type { HistoryQueryResult } from '@/storage/history-repository';
import { defaultSettings } from '@/domain/settings';
import { defaultRules } from '@/domain/rules';
import { defaultStats } from '@/domain/stats';
import type { ReviewRecord } from '@/domain/review';

const hiddenRecord: ReviewRecord = {
  id: 'rv-1',
  videoId: 'vid1',
  title: 'Suspicious video',
  channelId: 'UC1',
  channelName: 'Slop Channel',
  surface: 'home',
  decision: { action: 'hide', reason: 'automatic', explanation: ['Likely AI-generated'] },
  createdAt: 1_700_000_000_000,
};

function fakeBackend(overrides: Partial<Backend> = {}): Backend {
  return {
    getSettings: vi.fn(async () => defaultSettings()),
    saveSettings: vi.fn(async () => {}),
    getRules: vi.fn(async () => defaultRules()),
    getReview: vi.fn(async () => [hiddenRecord]),
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

// The review actions use browser.storage directly; stub it.
beforeEach(() => {
  const storage: Record<string, unknown> = {
    'local:rules': defaultRules(),
    'local:reviewRecords': [hiddenRecord],
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

describe('OptionsApp', () => {
  /** Render and wait until settings have loaded (nav buttons appear). */
  async function renderLoaded(backend: Backend) {
    render(<OptionsApp backend={backend} />);
    await screen.findByRole('button', { name: 'General' });
  }

  it('renders all main sections via tabs', async () => {
    await renderLoaded(fakeBackend());
    const user = userEvent.setup();
    for (const label of [
      'General',
      'Filtering',
      'Categories',
      'Allowed content',
      'Blocked content',
      'Review history',
      'Import/export',
      'Privacy',
      'About',
    ]) {
      expect(screen.getByRole('button', { name: label })).toBeInTheDocument();
    }
    await user.click(screen.getByRole('button', { name: 'Privacy' }));
    expect(await screen.findByLabelText(/Not interested/i)).not.toBeChecked();
    expect(screen.getByLabelText(/remote reputation provider/i)).not.toBeChecked();
  });

  it('shows review queue with all recovery actions (durable query)', async () => {
    const backend = fakeBackend({
      getReview: vi.fn(async () => []),
      queryHistory: vi.fn(async (): Promise<HistoryQueryResult> => ({
        items: [
          {
            key: 'v:vid1',
            videoId: 'vid1',
            title: 'Suspicious video',
            channelId: 'UC1',
            channelName: 'Slop Channel',
            handle: undefined,
            surfaces: ['home'],
            latestDecision: {
              action: 'hide',
              reason: 'automatic',
              explanation: ['Likely AI-generated'],
            },
            resolution: 'pending',
            firstSeen: 1_700_000_000_000,
            lastSeen: 1_700_000_000_000,
            count: 1,
            evidenceSummary: '',
            revision: 1,
          },
        ],
        total: 1,
        page: 1,
        pageSize: 25,
      })),
    });
    await renderLoaded(backend);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Review history' }));
    expect(await screen.findByText('Suspicious video')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Restore' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Allow video' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Allow channel' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Not AI' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Not slop' })).toBeInTheDocument();
  });

  it('restore routes the durable action through the backend (R10/R11)', async () => {
    const backend = fakeBackend();
    await renderLoaded(backend);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Review history' }));
    await user.click(await screen.findByRole('button', { name: 'Restore' }));
    await waitFor(() => expect(backend.restoreSummary).toHaveBeenCalledWith('rv-1'));
  });

  it('Not AI correction persists durably via the backend', async () => {
    const backend = fakeBackend();
    await renderLoaded(backend);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Review history' }));
    await user.click(await screen.findByRole('button', { name: 'Not AI' }));
    await waitFor(() => expect(backend.setCorrection).toHaveBeenCalledWith('vid1', 'notAi', true));
  });

  it('clear history clears via backend without touching corrections', async () => {
    const backend = fakeBackend();
    await renderLoaded(backend);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Review history' }));
    await user.click(await screen.findByRole('button', { name: 'Clear history…' }));
    expect(screen.getByRole('alertdialog', { name: /confirm clear history/i })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Clear history' }));
    await waitFor(() => expect(backend.clearHistory).toHaveBeenCalled());
  });

  it('category action select persists changes', async () => {
    const backend = fakeBackend();
    await renderLoaded(backend);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Categories' }));
    const select = await screen.findByRole('combobox', { name: 'AI-generated video action' });
    await user.selectOptions(select, 'hide');
    expect(backend.saveSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        categoryActions: expect.objectContaining({ 'ai-visual': 'hide' }),
      }),
    );
  });

  it('import rejects invalid file with a visible message', async () => {
    await renderLoaded(fakeBackend());
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Import/export' }));
    // Simulate choosing an invalid file through the input.
    const input = (await screen.findByLabelText('Import file')) as HTMLInputElement;
    const file = new File(['{not json'], 'import.json', { type: 'application/json' });
    await user.upload(input, file);
    await waitFor(() => expect(screen.getAllByText(/Import rejected/i).length).toBeGreaterThan(0));
  });

  it('reset settings requires confirmation', async () => {
    await renderLoaded(fakeBackend());
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Import/export' }));
    await user.click(await screen.findByRole('button', { name: 'Reset all settings…' }));
    expect(screen.getByRole('alertdialog', { name: /confirm reset/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reset settings' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
  });
});
