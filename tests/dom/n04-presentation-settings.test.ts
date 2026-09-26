import { beforeEach, describe, expect, it } from 'vitest';
import { applyDecision, setPresentationCallbacks } from '@/presentation/apply-decision';
import { defaultSettings, type UserSettings } from '@/domain/settings';
import type { FilterDecision } from '@/domain/decision';
import type { NormalizedVideoCandidate } from '@/domain/video';
import { elementFromHtml, HUMAN_CARD_HTML } from '../fixtures/youtube';

/**
 * N04 blocker-4: presentation settings must take effect on OPEN tabs —
 * both directions, on ALREADY-hidden cards, without duplicate UI:
 * - showExplanations toggles the inline reason line;
 * - displayMode placeholder ↔ collapse transitions re-render the slot;
 * - rapid setting changes settle on the last value.
 */

function decision(): FilterDecision {
  return {
    action: 'hide',
    reason: 'automatic',
    explanation: ['YouTube labels this video as containing altered or synthetic content.'],
  };
}

const candidate: NormalizedVideoCandidate = {
  videoId: 'n04vid1',
  title: 'Presentation settings card',
  channel: { channelId: 'UCN04Channel0000000000000', displayName: 'Channel' },
  surface: 'home',
  cardKind: 'video',
  badges: [],
  ariaLabels: [],
  metadataText: [],
  isShort: false,
  observedAt: 1,
};

function settings(overrides: Partial<UserSettings> = {}): UserSettings {
  return { ...defaultSettings(), displayMode: 'placeholder', ...overrides };
}

let card: Element;

beforeEach(() => {
  card = elementFromHtml(HUMAN_CARD_HTML);
  setPresentationCallbacks({
    showOnce: () => {},
    why: () => {},
    allowVideo: () => {},
    allowChannel: () => {},
  });
});

describe('N04: showExplanations has a runtime consumer', () => {
  it('explanations ON renders the reason line', () => {
    applyDecision(card, decision(), candidate, settings({ showExplanations: true }));
    const placeholder = card.querySelector('.bts-placeholder')!;
    expect(placeholder.textContent).toContain('altered or synthetic');
  });

  it('explanations OFF hides the reason line but keeps the recovery controls', () => {
    applyDecision(card, decision(), candidate, settings({ showExplanations: false }));
    const placeholder = card.querySelector('.bts-placeholder')!;
    expect(placeholder.textContent).not.toContain('altered or synthetic');
    expect(placeholder.textContent).toContain('Hidden by BlockTheSlop');
    const buttons = [...placeholder.querySelectorAll('button')].map((b) => b.textContent);
    expect(buttons).toContain('Reveal once');
    expect(buttons).toContain('Why hidden?');
  });

  it('toggling OFF→ON on an already-hidden card re-renders with the reason (no duplicates)', () => {
    applyDecision(card, decision(), candidate, settings({ showExplanations: false }));
    applyDecision(card, decision(), candidate, settings({ showExplanations: true }));
    expect(card.querySelectorAll('.bts-placeholder')).toHaveLength(1);
    expect(card.querySelector('.bts-placeholder')!.textContent).toContain('altered or synthetic');

    // And back OFF.
    applyDecision(card, decision(), candidate, settings({ showExplanations: false }));
    expect(card.querySelectorAll('.bts-placeholder')).toHaveLength(1);
    expect(card.querySelector('.bts-placeholder')!.textContent).not.toContain(
      'altered or synthetic',
    );
  });
});

describe('N04: displayMode transitions on already-hidden cards', () => {
  it('placeholder → collapse collapses the slot (same-state shortcut must not block)', () => {
    applyDecision(card, decision(), candidate, settings({ displayMode: 'placeholder' }));
    expect(card.querySelector('.bts-placeholder')).not.toBeNull();
    // Switch to collapse: the slot must be removed, not kept as-is.
    applyDecision(card, decision(), candidate, settings({ displayMode: 'collapse' }));
    expect(card.getAttribute('data-bts-collapse')).toBe('');
    expect(card.querySelector('.bts-placeholder')).toBeNull();
  });

  it('collapse (history on) → placeholder restores a placeholder slot', () => {
    applyDecision(card, decision(), candidate, settings({ displayMode: 'collapse' }));
    expect(card.getAttribute('data-bts-collapse')).toBe('');
    applyDecision(card, decision(), candidate, settings({ displayMode: 'placeholder' }));
    expect(card.getAttribute('data-bts-collapse')).toBeNull();
    expect(card.querySelector('.bts-placeholder')).not.toBeNull();
  });

  it('rapid displayMode changes settle on the last value with a single owned UI', () => {
    applyDecision(card, decision(), candidate, settings({ displayMode: 'placeholder' }));
    applyDecision(card, decision(), candidate, settings({ displayMode: 'collapse' }));
    applyDecision(card, decision(), candidate, settings({ displayMode: 'placeholder' }));
    expect(card.querySelectorAll('.bts-placeholder')).toHaveLength(1);
    expect(card.getAttribute('data-bts-collapse')).toBeNull();
  });
});
