import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { OnboardingApp } from '@/entrypoints/onboarding/App';
import type { Backend } from '@/ui/messaging';
import { defaultSettings } from '@/domain/settings';
import { expectSettingsPayload } from './helpers/settings-payload';

function fakeBackend(overrides: Partial<Backend> = {}): Backend {
  let settings = defaultSettings();
  return {
    getSettings: vi.fn(async () => settings),
    saveSettings: vi.fn(async (next) => {
      settings = { ...settings, ...next };
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
    getOnboardingState: vi.fn(async () => ({ completed: false, version: 1 })),
    completeOnboarding: vi.fn(async () => true),
    getDailyStats: vi.fn(async () => ({ version: 1, days: {}, currentDay: '2026-09-25' })),
    resetDailyStats: vi.fn(async () => true),
    ...overrides,
  };
}

import { defaultStats } from '@/domain/stats';

describe('onboarding flow UI (V6-03..07)', () => {
  it('welcome explains visible-text limits and offers Start + Skip', async () => {
    const backend = fakeBackend();
    render(<OnboardingApp backend={backend} />);
    await screen.findByRole('heading', { name: /welcome/i });
    // Honest limitation copy: no frames/audio/transcript claims.
    const body = document.body.textContent ?? '';
    expect(body).toMatch(/visible text/i);
    expect(body).toMatch(/cannot/i);
    expect(body).toMatch(/restor/i);
    screen.getByRole('button', { name: 'Start' });
    screen.getByRole('button', { name: 'Skip setup' });
  });

  it('skip never writes settings and records completion', async () => {
    const backend = fakeBackend();
    render(<OnboardingApp backend={backend} />);
    await screen.findByRole('heading', { name: /welcome/i });
    await userEvent.click(screen.getByRole('button', { name: 'Skip setup' }));
    await screen.findByRole('heading', { name: /all set/i });
    expect(backend.saveSettings).not.toHaveBeenCalled();
    expect(backend.completeOnboarding).toHaveBeenCalledWith(undefined);
  });

  it('discovery question is skippable (Continue without answering works)', async () => {
    const backend = fakeBackend();
    render(<OnboardingApp backend={backend} />);
    await screen.findByRole('heading', { name: /welcome/i });
    await userEvent.click(screen.getByRole('button', { name: 'Start' }));
    await screen.findByRole('heading', { name: /how did you find us/i });
    await userEvent.click(screen.getByRole('button', { name: 'Continue' })); // no answer
    await screen.findByRole('heading', { name: /what do you want filtered/i });
    expect(backend.completeOnboarding).not.toHaveBeenCalled();
  });

  it('back preserves choices; full flow applies atomically', async () => {
    const backend = fakeBackend();
    render(<OnboardingApp backend={backend} />);
    await screen.findByRole('heading', { name: /welcome/i });
    await userEvent.click(screen.getByRole('button', { name: 'Start' }));
    await screen.findByRole('heading', { name: /how did you find us/i });
    await userEvent.click(screen.getByLabelText('Friend or family'));
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }));
    const contentHeading = await screen.findByRole('heading', {
      name: /what do you want filtered/i,
    });
    expect(contentHeading).toBeDefined();
    // Uncheck AI music, continue to treatment.
    await userEvent.click(screen.getByLabelText(/^AI music/));
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await screen.findByRole('heading', { name: /what should happen/i });
    // Choose Warn treatment.
    await userEvent.click(screen.getByRole('radio', { name: /warn/i }));
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await screen.findByRole('heading', { name: /how aggressively/i });
    // Choose High sensitivity.
    await userEvent.click(screen.getByRole('radio', { name: /high/i }));
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }));
    // Review shows the summary and Back preserves state.
    await screen.findByRole('heading', { name: /review your choices/i });
    await userEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(screen.getByRole('radio', { name: /high/i })).toBeChecked();
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await screen.findByRole('heading', { name: /review your choices/i });
    await userEvent.click(screen.getByRole('button', { name: 'Apply' }));

    await screen.findByRole('heading', { name: /all set/i });
    expect(backend.completeOnboarding).toHaveBeenCalledWith('friend');
    const patch = expectSettingsPayload(backend.saveSettings);
    expect(patch.mode).toBe('strict'); // High → strict
    expect(patch.categoryActions!['ai-music']).toBe('allow'); // unchecked → explicit allow
    expect(patch.categoryActions!['ai-visual']).toBe('warn'); // checked + Warn treatment
    expect(patch.categoryActions!['ai-discussion']).toBe('allow'); // about-AI stays off
  });

  it('apply failure shows visible error and retry succeeds; Ready only after success', async () => {
    let fail = true;
    const saveCalls = { count: 0 };
    const backend = fakeBackend({
      saveSettings: vi.fn(async () => {
        saveCalls.count += 1;
        if (fail) throw new Error('storage unavailable');
      }),
    });
    render(<OnboardingApp backend={backend} />);
    await screen.findByRole('heading', { name: /welcome/i });
    await userEvent.click(screen.getByRole('button', { name: 'Start' }));
    await screen.findByRole('heading', { name: /how did you find us/i });
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await screen.findByRole('heading', { name: /review your choices/i });
    await userEvent.click(screen.getByRole('button', { name: 'Apply' }));
    // Visible failure; no Ready. (role=alert has name-from-author, so query by text)
    await screen.findByText(/saving failed/i);
    expect(screen.queryByRole('heading', { name: /all set/i })).toBeNull();
    expect(backend.completeOnboarding).not.toHaveBeenCalled(); // no completion on failure
    fail = false;
    await userEvent.click(screen.getByRole('button', { name: 'Apply' }));
    await screen.findByRole('heading', { name: /all set/i });
    expect(backend.completeOnboarding).toHaveBeenCalledTimes(1); // completion only after success
    expect(saveCalls.count).toBe(2); // failed attempt + successful retry, never a half-write
  });

  it('never offers Blur or Dim (no placebo choices)', async () => {
    const backend = fakeBackend();
    render(<OnboardingApp backend={backend} />);
    await screen.findByRole('heading', { name: /welcome/i });
    // Walk to treatment step.
    await userEvent.click(screen.getByRole('button', { name: 'Start' }));
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await screen.findByRole('heading', { name: /what should happen/i });
    const body = document.body.textContent ?? '';
    expect(body.toLowerCase()).not.toContain('blur');
    expect(body.toLowerCase()).not.toContain('dim');
    const radios = screen.getAllByRole('radio');
    expect(radios).toHaveLength(2); // Hide and Warn only
  });

  it('a completed setup shows the read-only page instead of the flow', async () => {
    const backend = fakeBackend({
      getOnboardingState: vi.fn(async () => ({ completed: true, version: 1 })),
    });
    render(<OnboardingApp backend={backend} />);
    await screen.findByText(/setup already completed/i);
    expect(screen.queryByRole('button', { name: 'Start' })).toBeNull();
  });
});
