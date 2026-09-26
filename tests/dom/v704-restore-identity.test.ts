import { beforeEach, describe, expect, it, vi } from 'vitest';
import { applyDecision, ensureStyles, identityStillMatches } from '@/presentation/apply-decision';
import { setPresentationCallbacks } from '@/presentation/apply-decision';
import { defaultSettings, type UserSettings } from '@/domain/settings';
import { sessionRecovery } from '@/presentation/session-recovery';
import { parseCardElement } from '@/youtube/parse/card';
import { identityOf, type NormalizedVideoCandidate } from '@/domain/video';
import type { FilterDecision } from '@/domain/decision';

import {
  elementFromHtml,
  RECYCLED_NODE_BEFORE_HTML,
  RECYCLED_NODE_AFTER_HTML,
} from '../fixtures/youtube';

/**
 * V7-04: gap-free recovery with identity validation on action.
 *
 * The session recovery panel and popup restore list MUST verify — at click
 * time — that the element still holds the SAME content the user is restoring.
 * YouTube recycles card nodes: without the check, "Restore" reveals a card
 * that now contains a DIFFERENT video (the recycled content was never hidden),
 * and the hidden video's recovery affordance silently disappears.
 *
 * Candidates are parsed from the fixture element (the real pipeline path) so
 * the stored fingerprint and the re-parsed fingerprint describe the same
 * content.
 */

function decision(): FilterDecision {
  return {
    action: 'hide',
    reason: 'user-rule',
    ruleId: 'video-block:before111',
    explanation: ['Hidden by your rule.'],
  };
}

function collapseSettings(): UserSettings {
  return { ...defaultSettings(), displayMode: 'collapse' };
}

function cardWith(html: string): Element {
  const el = elementFromHtml(html);
  document.body.appendChild(el);
  return el;
}

function parseOf(card: Element): NormalizedVideoCandidate {
  return parseCardElement(card, 'home', Date.now());
}

beforeEach(() => {
  document.body.innerHTML = '';
  ensureStyles();
  setPresentationCallbacks({
    showOnce: vi.fn(),
    why: vi.fn(),
    allowVideo: vi.fn(),
    allowChannel: vi.fn(),
  });
  sessionRecovery.clear();
});

describe('V7-04: identityStillMatches', () => {
  it('true when the element still holds the recorded content', () => {
    const card = cardWith(RECYCLED_NODE_BEFORE_HTML);
    const cand = parseOf(card);
    applyDecision(card, decision(), cand, collapseSettings());
    expect(identityStillMatches(card, identityOf(cand))).toBe(true);
  });

  it('false after the card was recycled to different content', () => {
    const card = cardWith(RECYCLED_NODE_BEFORE_HTML);
    const cand = parseOf(card);
    applyDecision(card, decision(), cand, collapseSettings());
    // YouTube recycles the node: same element, new video (real after-fixture
    // content swapped in).
    const after = elementFromHtml(RECYCLED_NODE_AFTER_HTML);
    card.replaceChildren(...[...after.childNodes]);
    expect(identityStillMatches(card, identityOf(cand))).toBe(false);
  });

  it('true for an unknown signature (empty string) — nothing to validate against', () => {
    const card = cardWith(RECYCLED_NODE_BEFORE_HTML);
    expect(identityStillMatches(card, '')).toBe(true);
  });

  it('false for a card we never marked', () => {
    const card = cardWith(RECYCLED_NODE_BEFORE_HTML);
    expect(identityStillMatches(card, '["not","a","real","signature"]')).toBe(false);
  });
});

describe('V7-04: session restore validates identity before revealing', () => {
  it('restore reveals the still-current card', () => {
    const card = cardWith(RECYCLED_NODE_BEFORE_HTML);
    const cand = parseOf(card);
    applyDecision(card, decision(), cand, collapseSettings());
    sessionRecovery.record(card, cand, decision(), identityOf(cand));

    const onRestore = vi.fn();
    const restored = sessionRecovery.restore(sessionRecovery.list()[0]!.id, onRestore);
    expect(restored).toBe(true);
    expect(onRestore).toHaveBeenCalledWith(card, identityOf(cand));
  });

  it('a recycled element is NOT revealed: the stale entry is dropped instead', () => {
    const card = cardWith(RECYCLED_NODE_BEFORE_HTML);
    const cand = parseOf(card);
    applyDecision(card, decision(), cand, collapseSettings());
    sessionRecovery.record(card, cand, decision(), identityOf(cand));

    // Recycle to new content while hidden.
    const after = elementFromHtml(RECYCLED_NODE_AFTER_HTML);
    card.replaceChildren(...[...after.childNodes]);

    // The validated restore path: identity check must reject the reveal.
    const entry = sessionRecovery.list()[0]!;
    expect(entry.signature).toBe(identityOf(cand));
    const validated = identityStillMatches(card, entry.signature);
    expect(validated).toBe(false);
    // A rejected entry must not linger as a phantom recovery row.
    if (!validated) sessionRecovery.removeByElement(card);
    expect(sessionRecovery.list()).toHaveLength(0);
  });
});
