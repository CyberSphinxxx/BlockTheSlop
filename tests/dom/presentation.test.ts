import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  applyDecision,
  restore,
  setPresentationCallbacks,
  ensureStyles,
} from '@/presentation/apply-decision';
import { cleanupAll } from '@/presentation/cleanup';
import { defaultSettings } from '@/domain/settings';
import type { FilterDecision } from '@/domain/decision';
import type { NormalizedVideoCandidate } from '@/domain/video';
import { elementFromHtml, HUMAN_CARD_HTML } from '../fixtures/youtube';

function decision(action: FilterDecision['action']): FilterDecision {
  return {
    action,
    reason: 'automatic',
    explanation:
      action === 'allow'
        ? []
        : [
            'Likely AI-generated',
            'YouTube labels this video as containing altered or synthetic content.',
          ],
  };
}

const candidate: NormalizedVideoCandidate = {
  videoId: 'human123',
  title: 'Test video',
  channel: { channelId: 'UCHumanChannel1234567890ab', displayName: 'History Corner' },
  surface: 'home',
  cardKind: 'video',
  badges: [],
  ariaLabels: [],
  metadataText: [],
  isShort: false,
  observedAt: 1,
};

let card: Element;
const settings = { ...defaultSettings(), showExplanations: true };

beforeEach(() => {
  card = elementFromHtml(HUMAN_CARD_HTML);
  setPresentationCallbacks({
    showOnce: vi.fn(),
    why: vi.fn(),
    allowVideo: vi.fn(),
    allowChannel: vi.fn(),
  });
});

describe('applyDecision', () => {
  it('hides idempotently without duplicating placeholders', () => {
    applyDecision(card, decision('hide'), candidate, settings);
    applyDecision(card, decision('hide'), candidate, settings);
    expect(card.querySelectorAll('.bts-placeholder')).toHaveLength(1);
    expect(card.getAttribute('data-bts-state')).toBe('hidden');
  });

  it('warns idempotently without duplicating overlays', () => {
    applyDecision(card, decision('warn'), candidate, settings);
    applyDecision(card, decision('warn'), candidate, settings);
    expect(card.querySelectorAll('.bts-overlay')).toHaveLength(1);
    expect(card.getAttribute('data-bts-state')).toBe('warn');
  });

  it('changing decision removes stale previous state', () => {
    applyDecision(card, decision('hide'), candidate, settings);
    applyDecision(card, decision('warn'), candidate, settings);
    expect(card.querySelectorAll('.bts-placeholder')).toHaveLength(0);
    expect(card.querySelectorAll('.bts-overlay')).toHaveLength(1);
    expect(card.getAttribute('data-bts-state')).toBe('warn');

    applyDecision(card, decision('allow'), candidate, settings);
    expect(card.getAttribute('data-bts-state')).toBeNull();
    expect(card.querySelectorAll('.bts-overlay')).toHaveLength(0);
  });

  it('restore removes all extension state', () => {
    applyDecision(card, decision('warn'), candidate, settings);
    restore(card);
    expect(card.getAttribute('data-bts-state')).toBeNull();
    expect(card.querySelectorAll('.bts-overlay')).toHaveLength(0);
  });

  it('collapse display mode removes the layout slot (no placeholder)', () => {
    applyDecision(card, decision('hide'), candidate, { ...settings, displayMode: 'collapse' });
    expect(card.getAttribute('data-bts-state')).toBe('hidden');
    expect(card.getAttribute('data-bts-collapse')).toBe('');
    expect(card.querySelector('.bts-placeholder')).toBeNull();
  });

  it('uses textContent only — no HTML injection from decision text', () => {
    const malicious: FilterDecision = {
      action: 'hide',
      reason: 'automatic',
      explanation: ['<img src=x onerror=alert(1)>'],
    };
    applyDecision(card, malicious, candidate, settings);
    const placeholder = card.querySelector('.bts-placeholder');
    expect(placeholder?.textContent).toContain('<img');
    expect(placeholder?.querySelector('img')).toBeNull();
  });

  it('cleanupAll removes state from every card', () => {
    applyDecision(card, decision('hide'), candidate, settings);
    const container = card.parentElement ?? document.body;
    cleanupAll(container);
    expect(container.querySelectorAll('[data-bts-state]')).toHaveLength(0);
    expect(container.querySelectorAll('.bts-placeholder')).toHaveLength(0);
  });

  it('ensureStyles injects the stylesheet once', () => {
    ensureStyles();
    ensureStyles();
    expect(document.querySelectorAll('#bts-style')).toHaveLength(1);
  });
});
