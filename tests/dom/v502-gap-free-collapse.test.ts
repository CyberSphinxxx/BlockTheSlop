import { beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultSettings, type UserSettings } from '@/domain/settings';
import {
  applyDecision,
  setPresentationCallbacks,
  ensureStyles,
  restore,
} from '@/presentation/apply-decision';
import { sessionRecovery } from '@/presentation/session-recovery';
import { HideActivityNotice } from '@/presentation/activity';
import type { FilterDecision } from '@/domain/decision';
import type { NormalizedVideoCandidate, Surface } from '@/domain/video';
import { elementFromHtml, HUMAN_CARD_HTML } from '../fixtures/youtube';

const SURFACES: readonly Surface[] = [
  'home',
  'search',
  'subscriptions',
  'watch-sidebar',
  'channel',
  'playlist',
  'history',
  'shorts-shelf',
];

function mockDecision(action: 'hide' | 'warn' | 'allow'): FilterDecision {
  return {
    action,
    reason: 'automatic',
    explanation: ['Synthetic media disclosure detected.'],
    rulesVersion: 'v1',
    classifierVersion: 'v1',
  };
}

function mockCandidate(surface: Surface, id = 'test-vid'): NormalizedVideoCandidate {
  return {
    videoId: id,
    title: `Test video on ${surface}`,
    channel: { channelId: 'UCchannel123', displayName: 'Channel 123' },
    surface,
    cardKind: surface === 'shorts-shelf' ? 'shorts-video' : 'video',
    badges: [],
    ariaLabels: [],
    metadataText: [],
    isShort: surface === 'shorts-shelf',
    observedAt: Date.now(),
  };
}

describe('V5-02: Gap-Free Collapse and Recovery Across Surfaces', () => {
  let callbacks: {
    showOnce: (el: Element) => void;
    why: (el: Element) => void;
    allowVideo: (c: NormalizedVideoCandidate, el?: Element) => void;
    allowChannel: (c: NormalizedVideoCandidate, el?: Element) => void;
  };

  beforeEach(() => {
    document.body.innerHTML = '';
    ensureStyles();
    callbacks = {
      showOnce: vi.fn(),
      why: vi.fn(),
      allowVideo: vi.fn(),
      allowChannel: vi.fn(),
    };
    setPresentationCallbacks(callbacks);
    sessionRecovery.clear();
  });

  for (const surface of SURFACES) {
    it(`surface [${surface}]: collapse mode sets data-bts-collapse without any placeholder (history ON)`, () => {
      const card = elementFromHtml(HUMAN_CARD_HTML);
      document.body.appendChild(card);
      const settings: UserSettings = {
        ...defaultSettings(),
        displayMode: 'collapse',
        history: { enabled: true, retentionDays: 30 },
      };
      const candidate = mockCandidate(surface);
      applyDecision(card, mockDecision('hide'), candidate, settings);

      expect(card.getAttribute('data-bts-state')).toBe('hidden');
      expect(card.getAttribute('data-bts-collapse')).toBe('');
      expect(card.querySelector('.bts-placeholder')).toBeNull();
      expect(card.querySelector('.bts-collapse-recovery')).toBeNull();
    });

    it(`surface [${surface}]: collapse mode leaves NO inline bar even when history is OFF`, () => {
      const card = elementFromHtml(HUMAN_CARD_HTML);
      document.body.appendChild(card);
      const settings: UserSettings = {
        ...defaultSettings(),
        displayMode: 'collapse',
        history: { enabled: false, retentionDays: 30 },
      };
      const candidate = mockCandidate(surface);
      applyDecision(card, mockDecision('hide'), candidate, settings);

      expect(card.getAttribute('data-bts-state')).toBe('hidden');
      expect(card.getAttribute('data-bts-collapse')).toBe('');
      // No placeholder or inline bar in the grid slot!
      expect(card.querySelector('.bts-placeholder')).toBeNull();
      expect(card.querySelector('.bts-collapse-recovery')).toBeNull();
    });
  }

  it('distinguishes hidden cards from warn markers', () => {
    const card = elementFromHtml(HUMAN_CARD_HTML);
    document.body.appendChild(card);
    const settings: UserSettings = { ...defaultSettings(), displayMode: 'collapse' };
    const candidate = mockCandidate('home');

    applyDecision(card, mockDecision('warn'), candidate, settings);
    expect(card.getAttribute('data-bts-state')).toBe('warn');
    expect(card.getAttribute('data-bts-collapse')).toBeNull();
    const marker = card.querySelector('.bts-warn-marker');
    expect(marker).not.toBeNull();
    expect(marker?.textContent).toContain('Filtered');
  });

  it('placeholder mode preserves styled placeholder when explicitly configured', () => {
    const card = elementFromHtml(HUMAN_CARD_HTML);
    document.body.appendChild(card);
    const settings: UserSettings = { ...defaultSettings(), displayMode: 'placeholder' };
    const candidate = mockCandidate('home');

    applyDecision(card, mockDecision('hide'), candidate, settings);
    expect(card.getAttribute('data-bts-state')).toBe('hidden');
    expect(card.getAttribute('data-bts-collapse')).toBeNull();
    const placeholder = card.querySelector('.bts-placeholder');
    expect(placeholder).not.toBeNull();
    expect(placeholder?.textContent).toContain('Hidden by BlockTheSlop');
  });

  it('session recovery tracks collapsed items and allows on-demand restore', () => {
    const card = elementFromHtml(HUMAN_CARD_HTML);
    document.body.appendChild(card);
    const candidate = mockCandidate('home', 'v_session1');
    const decision = mockDecision('hide');

    sessionRecovery.record(card, candidate, decision, 'sig_session1');
    expect(sessionRecovery.count()).toBe(1);

    const items = sessionRecovery.list();
    expect(items).toHaveLength(1);
    expect(items[0]?.videoId).toBe('v_session1');
    expect(items[0]?.title).toBe('Test video on home');

    const onRestore = vi.fn((el: Element, _sig: string) => {
      restore(el);
    });

    const restored = sessionRecovery.restore(items[0]!.id, onRestore);
    expect(restored).toBe(true);
    expect(onRestore).toHaveBeenCalledWith(card, 'sig_session1');
    expect(sessionRecovery.count()).toBe(0);
  });

  it('activity notice renders interactive panel and triggers restore', () => {
    const card = elementFromHtml(HUMAN_CARD_HTML);
    card.setAttribute('data-bts-state', 'hidden');
    card.setAttribute('data-bts-video-id', 'v_notice1');
    document.body.appendChild(card);

    const candidate = mockCandidate('home', 'v_notice1');
    sessionRecovery.record(card, candidate, mockDecision('hide'), 'sig_notice1');

    const notice = new HideActivityNotice();
    const onRestore = vi.fn();
    notice.onRestore = onRestore;
    notice.update();

    const badge = document.querySelector('.bts-activity-notice');
    expect(badge).not.toBeNull();
    expect(badge?.textContent).toContain('1 video hidden');

    // Click to open panel
    (badge as HTMLElement).click();
    const panel = document.querySelector('.bts-activity-panel');
    expect(panel).not.toBeNull();
    expect(panel?.textContent).toContain('Test video on home');

    // Click restore in panel
    const restoreBtn = panel?.querySelector('button.bts-button');
    expect(restoreBtn).not.toBeNull();
    (restoreBtn as HTMLElement).click();
    expect(onRestore).toHaveBeenCalled();

    notice.clear();
    expect(document.querySelector('.bts-activity-notice')).toBeNull();
  });
});
