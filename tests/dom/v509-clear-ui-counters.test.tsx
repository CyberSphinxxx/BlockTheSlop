import { beforeEach, describe, expect, it } from 'vitest';
import { HideActivityNotice, formatDecisionReason } from '@/presentation/activity';
import { sessionRecovery } from '@/presentation/session-recovery';
import { ATTR_STATE, ATTR_VIDEO_ID } from '@/youtube/selectors';
import { fireEvent, render } from '@testing-library/react';
import { OptionsApp } from '@/entrypoints/options/App';
import type { Backend } from '@/ui/messaging';
import { defaultSettings } from '@/domain/settings';
import { defaultRules } from '@/domain/rules';
import { defaultStats } from '@/domain/stats';
import type { ReviewSummary } from '@/domain/history';

describe('V5-09: Clear UI, Counters, Explanations & Privacy', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    sessionRecovery.clear();
  });

  const createCard = (videoId: string, title = 'Test Video'): HTMLElement => {
    const card = document.createElement('div');
    card.setAttribute(ATTR_STATE, 'hidden');
    card.setAttribute('data-bts-collapse', '');
    card.setAttribute(ATTR_VIDEO_ID, videoId);
    card.textContent = title;
    document.body.appendChild(card);
    return card;
  };

  it('counts distinct currently hidden video IDs on this page and avoids double-counting duplicate DOM copies', () => {
    const notice = new HideActivityNotice();

    // 3 cards in DOM: video 'v1' rendered twice (duplicate DOM shelf), and video 'v2' once
    createCard('v1', 'Duplicate Card 1');
    createCard('v1', 'Duplicate Card 2 (repeat in shelf)');
    createCard('v2', 'Other Video');

    notice.update();

    const noticeEl = document.querySelector('.bts-activity-notice');
    expect(noticeEl).not.toBeNull();

    // Counter shows 2 distinct videos hidden (not 3)
    expect(noticeEl?.textContent).toBe('2 videos hidden · Review');

    // Language avoids implying they are ads or proven AI
    expect(noticeEl?.textContent).not.toContain('ad');
    expect(noticeEl?.textContent).not.toContain('proven AI');
    expect(noticeEl?.getAttribute('aria-label')).toBe(
      '2 videos hidden on this page. Click to review or restore.',
    );
  });

  it('removes notice when all hidden cards are removed / restored', () => {
    const notice = new HideActivityNotice();

    const card = createCard('v1');
    notice.update();
    expect(document.querySelector('.bts-activity-notice')).not.toBeNull();

    // Card restored or removed from DOM
    card.removeAttribute(ATTR_STATE);
    card.removeAttribute('data-bts-collapse');
    notice.update();

    expect(document.querySelector('.bts-activity-notice')).toBeNull();
  });

  it('provides single in-place notice without spamming multiple toasts per repeated card', () => {
    const notice = new HideActivityNotice();

    // Rapid updates
    createCard('v1');
    notice.update();
    createCard('v2');
    notice.update();
    createCard('v3');
    notice.update();

    // Exactly one notice element exists in the DOM
    const notices = document.querySelectorAll('.bts-activity-notice');
    expect(notices).toHaveLength(1);
    expect(notices[0]?.textContent).toBe('3 videos hidden · Review');
  });

  it('supports full keyboard navigation and accessible Escape key dismissal', () => {
    const notice = new HideActivityNotice();
    createCard('v1', 'Sample Video');
    notice.update();

    const noticeEl = document.querySelector('.bts-activity-notice') as HTMLElement;
    expect(noticeEl.getAttribute('role')).toBe('button');
    expect(noticeEl.getAttribute('tabindex')).toBe('0');
    expect(noticeEl.getAttribute('aria-expanded')).toBe('false');

    // Press Enter to open panel
    noticeEl.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));

    const panelEl = document.querySelector('.bts-activity-panel') as HTMLElement;
    expect(panelEl).not.toBeNull();
    expect(panelEl.getAttribute('role')).toBe('dialog');
    expect(panelEl.getAttribute('aria-modal')).toBe('true');
    expect(noticeEl.getAttribute('aria-expanded')).toBe('true');

    // Press Escape to close panel
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

    expect(document.querySelector('.bts-activity-panel')).toBeNull();
    expect(noticeEl.getAttribute('aria-expanded')).toBe('false');
  });

  it('distinguishes automatic, explicit video, manual channel, and automatic channel hides', () => {
    expect(formatDecisionReason('automatic')).toBe('Automatic hide');
    expect(formatDecisionReason('user-rule', 'video-block:v123')).toBe('Explicit video rule');
    expect(formatDecisionReason('user-rule', 'phrase-rule:clickbait')).toBe('Phrase rule');
    expect(formatDecisionReason('channel-rule', 'channel-block:UC123')).toBe('Manual channel rule');
    expect(formatDecisionReason('channel-rule', 'auto-channel:UC123')).toBe(
      'Automatic channel block',
    );
    expect(formatDecisionReason('correction')).toBe('User correction');
  });

  it('displays detailed reasons and channel actions in session recovery panel', () => {
    const notice = new HideActivityNotice();
    const cardEl = createCard('v10', 'AI Video Title');

    sessionRecovery.record(
      cardEl,
      {
        videoId: 'v10',
        title: 'AI Video Title',
        surface: 'home',
        channel: { displayName: 'AI Factory', channelId: 'UC_ai_factory_123' },
        cardKind: 'video',
        badges: [],
        ariaLabels: [],
        metadataText: [],
        isShort: false,
        observedAt: Date.now(),
      },
      {
        action: 'hide',
        reason: 'channel-rule',
        ruleId: 'auto-channel:UC_ai_factory_123',
        explanation: ['Automatic channel block (3 qualifying AI videos)'],
      },
      'sig_v10',
    );

    notice.update();
    notice.openPanel();

    const panelEl = document.querySelector('.bts-activity-panel');
    expect(panelEl).not.toBeNull();
    expect(panelEl?.textContent).toContain('AI Video Title');
    expect(panelEl?.textContent).toContain('AI Factory');
    expect(panelEl?.textContent).toContain('[Automatic channel block]');
  });

  it('discloses memory expiry/cap, automatic-channel threshold, false-positive cost, and offline privacy in Options', async () => {
    const mockBackend: Backend = {
      getSettings: async () => defaultSettings(),
      saveSettings: async () => {},
      getRules: async () => defaultRules(),
      getReview: async () => [],
      getStats: async () => defaultStats(),
      resetStats: async () => {},
      getOnboardingState: async () => ({ completed: true, version: 1 }),
      completeOnboarding: async () => true,
      getSummaries: async () => [],
      putSummaries: async () => {},
      getDailyStats: async () => ({ version: 1, days: {}, currentDay: '2026-09-25' }),
      resetDailyStats: async () => true,
      deleteSummaries: async () => ({ deleted: [], missing: [] }),
      queryHistory: async () => ({
        items: [],
        total: 0,
        page: 1,
        pageSize: 25,
      }),
      restoreSummary: async () => true,
      setCorrection: async () => {},
      getHistoryEvents: async () => [],
      clearHistory: async () => {},
      getQuarantine: async () => [],
      getReviewSummaries: async () => [],
      clearCache: async () => {},
      clearCorrections: async () => {},
      listMissReview: async () => [],
      clearMissReview: async () => true,
      exportMissReview: async () => [],
    };

    const { findByText } = render(<OptionsApp backend={mockBackend} />);

    // 1. Verdict memory disclosure (24h TTL, 10,000 LRU cap)
    expect(await findByText(/Verdict Memory \(Tier 2 Fast-Path\)/i)).not.toBeNull();
    expect(await findByText(/24-hour time-to-live/i)).not.toBeNull();
    expect(await findByText(/10,000-entry LRU cap/i)).not.toBeNull();

    // 2. Automatic channel threshold disclosure
    expect(await findByText(/Automatic Channel Threshold/i)).not.toBeNull();
    expect(await findByText(/at least 3 distinct qualifying videos/i)).not.toBeNull();
    expect(await findByText(/max 5 promotions per day/i)).not.toBeNull();

    // 3. False-positive cost disclosure
    expect(await findByText(/False-Positive Cost & One-Click Demotion/i)).not.toBeNull();
    expect(
      await findByText(/Heuristic classification has a non-zero false-positive rate/i),
    ).not.toBeNull();

    // 4. Local-first and offline privacy disclosure
    expect(await findByText(/Local-First & Offline Privacy/i)).not.toBeNull();
    expect(await findByText(/100% locally in your browser/i)).not.toBeNull();
    expect(await findByText(/no telemetry, and no background network requests/i)).not.toBeNull();
  });

  it('renders attribution badges in Review History list', async () => {
    const summaries: ReviewSummary[] = [
      {
        key: 'vid1',
        videoId: 'vid1',
        title: 'Auto Blocked Video',
        channelName: 'Channel A',
        channelId: 'UCchannelA12345',
        surfaces: ['home'],
        resolution: 'pending',
        count: 1,
        firstSeen: Date.now() - 1000,
        lastSeen: Date.now(),
        latestDecision: {
          action: 'hide',
          reason: 'channel-rule',
          ruleId: 'auto-channel:UCchannelA12345',
          explanation: ['Auto-channel block'],
        },
        evidenceSummary: 'Auto-channel block',
        revision: 1,
      },
      {
        key: 'vid2',
        videoId: 'vid2',
        title: 'Manually Blocked Video',
        channelName: 'Channel B',
        surfaces: ['search'],
        resolution: 'pending',
        count: 2,
        firstSeen: Date.now() - 2000,
        lastSeen: Date.now(),
        latestDecision: {
          action: 'hide',
          reason: 'user-rule',
          ruleId: 'video-block:vid2',
          explanation: ['Blocked via right-click'],
        },
        evidenceSummary: 'Blocked via right-click',
        revision: 1,
      },
    ];

    const mockBackend: Backend = {
      getSettings: async () => defaultSettings(),
      saveSettings: async () => {},
      getRules: async () => defaultRules(),
      getReview: async () => [],
      getStats: async () => defaultStats(),
      resetStats: async () => {},
      getOnboardingState: async () => ({ completed: true, version: 1 }),
      completeOnboarding: async () => true,
      getSummaries: async () => summaries,
      putSummaries: async () => {},
      getDailyStats: async () => ({ version: 1, days: {}, currentDay: '2026-09-25' }),
      resetDailyStats: async () => true,
      deleteSummaries: async () => ({ deleted: [], missing: [] }),
      queryHistory: async () => ({
        items: summaries,
        total: 2,
        page: 1,
        pageSize: 25,
      }),
      restoreSummary: async () => true,
      setCorrection: async () => {},
      getHistoryEvents: async () => [],
      clearHistory: async () => {},
      getQuarantine: async () => [],
      getReviewSummaries: async () => [],
      clearCache: async () => {},
      clearCorrections: async () => {},
      listMissReview: async () => [],
      clearMissReview: async () => true,
      exportMissReview: async () => [],
    };

    const { findByText, findByRole } = render(<OptionsApp backend={mockBackend} />);

    // Switch to Review tab
    const reviewTabBtn = await findByRole('button', { name: /Review history/i });
    fireEvent.click(reviewTabBtn);

    expect(await findByText('Automatic channel block')).not.toBeNull();
    expect(await findByText('Explicit video rule')).not.toBeNull();
  });
});
