import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  applyDecision,
  ensureStyles,
  identityRestoreMode,
  identityStillMatches,
  setPresentationCallbacks,
} from '@/presentation/apply-decision';
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
 * Audit Finding 3: identityStillMatches ignored the SAVED identity in its
 * final comparison — it only checked present content vs the stamped
 * fingerprint. A stale recovery entry (card A) plus a card B whose stamp
 * happens to equal A's could be revealed and granted a show-once override
 * for content that was never hidden. The fix compares the saved identity to
 * the freshly parsed card identity IN ADDITION to the stamp.
 *
 * Extra contract: an empty or malformed signature never grants an
 * identity-specific show-once override to an unverified or recycled card.
 */

function decision(): FilterDecision {
  return {
    action: 'hide',
    reason: 'user-rule',
    ruleId: 'video-block:auditf3',
    explanation: ['Hidden by your rule.'],
  };
}

function collapseSettings(): UserSettings {
  return { ...defaultSettings(), displayMode: 'collapse' };
}

function parseOf(card: Element): NormalizedVideoCandidate {
  return parseCardElement(card, 'home', Date.now());
}

function cardWith(html: string): Element {
  const el = elementFromHtml(html);
  document.body.appendChild(el);
  return el;
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

describe('Audit Finding 3: identityStillMatches validates the SAVED identity too', () => {
  it('REPRODUCES the audit finding: stamp agrees with current content but the SAVED identity describes a DIFFERENT video', () => {
    const card = cardWith(RECYCLED_NODE_BEFORE_HTML);
    const current = parseOf(card);
    // Stamp the card with ITS OWN current identity (as applyDecision would).
    applyDecision(card, decision(), current, collapseSettings());

    // A STALE saved identity for a different video: identityOf form, with the
    // card-kind fields identityOf reads (videoId, title, description,
    // channelId, handle, displayName, disclosure, badgeCount, isShort, kind).
    const savedIdentity = JSON.stringify([
      'differentid99',
      'A different video entirely',
      null,
      'UCDifferent1111111111111',
      null,
      'Different Channel',
      false,
      0,
      false,
      'video',
    ]);
    // Old logic: stamp === currentFingerprint → true (WRONG: the saved
    // identity describes another video). Fixed logic must return false.
    expect(identityStillMatches(card, savedIdentity)).toBe(false);
  });

  it('true when saved identity, stamp, and current content all agree', () => {
    const card = cardWith(RECYCLED_NODE_BEFORE_HTML);
    const cand = parseOf(card);
    applyDecision(card, decision(), cand, collapseSettings());
    expect(identityStillMatches(card, identityOf(cand))).toBe(true);
  });

  it('false when the card was recycled to different content', () => {
    const card = cardWith(RECYCLED_NODE_BEFORE_HTML);
    const cand = parseOf(card);
    applyDecision(card, decision(), cand, collapseSettings());
    const after = elementFromHtml(RECYCLED_NODE_AFTER_HTML);
    card.replaceChildren(...[...after.childNodes]);
    expect(identityStillMatches(card, identityOf(cand))).toBe(false);
  });

  it('malformed signature (not identityOf JSON) NEVER grants an identity-specific override', () => {
    const card = cardWith(RECYCLED_NODE_BEFORE_HTML);
    const cand = parseOf(card);
    applyDecision(card, decision(), cand, collapseSettings());
    // Even though stamp and current content agree, a malformed saved identity
    // cannot describe this video — no identity-specific override.
    expect(identityStillMatches(card, '["not","a","real","signature"]')).toBe(false);
  });

  it('EMPTY signature: plain restore allowed on our current card, but NEVER the identity override', () => {
    const card = cardWith(RECYCLED_NODE_BEFORE_HTML);
    const cand = parseOf(card);
    applyDecision(card, decision(), cand, collapseSettings());
    // Our card, stamp current, saved identity unknown → 'unverified': the
    // validated-restore path may plain-restore it, but identityStillMatches
    // (the override gate) must be false — nothing identity-specific without
    // a proven saved identity.
    expect(identityRestoreMode(card, '')).toBe('unverified');
    expect(identityStillMatches(card, '')).toBe(false);

    // A card we never marked, saved identity unknown → 'foreign': the
    // restore action must not touch it at all.
    const stranger = cardWith(RECYCLED_NODE_AFTER_HTML);
    expect(identityRestoreMode(stranger, '')).toBe('foreign');
    expect(identityStillMatches(stranger, '')).toBe(false);
  });

  it('empty signature on a recycled card (stale stamp) is rejected', () => {
    const card = cardWith(RECYCLED_NODE_BEFORE_HTML);
    const cand = parseOf(card);
    applyDecision(card, decision(), cand, collapseSettings());
    const after = elementFromHtml(RECYCLED_NODE_AFTER_HTML);
    card.replaceChildren(...[...after.childNodes]);
    expect(identityStillMatches(card, '')).toBe(false);
  });
});

describe('Audit Finding 3: session-recovery restore semantics for validated restores', () => {
  it('a stale entry whose card now holds a DIFFERENT video must not be revealed or whitelisted', () => {
    const card = cardWith(RECYCLED_NODE_BEFORE_HTML);
    const cand = parseOf(card);
    applyDecision(card, decision(), cand, collapseSettings());
    sessionRecovery.record(card, cand, decision(), identityOf(cand));

    // YouTube recycles the node to a different video while hidden. The saved
    // identity now describes video A; the element holds video B.
    const after = elementFromHtml(RECYCLED_NODE_AFTER_HTML);
    card.replaceChildren(...[...after.childNodes]);

    const entry = sessionRecovery.list()[0]!;
    expect(entry.signature).toBe(identityOf(cand));
    const showOnceOverride = vi.fn();
    const plainRestore = vi.fn();
    if (identityStillMatches(card, entry.signature)) {
      showOnceOverride(card, entry.signature);
    } else {
      plainRestore(card);
      sessionRecovery.removeByElement(card);
    }
    // The stale entry must NOT grant the identity-specific override; the new
    // content is restored plainly (visible, re-evaluated normally) and the
    // phantom recovery row is dropped.
    expect(showOnceOverride).not.toHaveBeenCalled();
    expect(plainRestore).toHaveBeenCalledTimes(1);
    expect(sessionRecovery.list()).toHaveLength(0);
  });

  it('a verified entry still grants the show-once override on restore', () => {
    const card = cardWith(RECYCLED_NODE_BEFORE_HTML);
    const cand = parseOf(card);
    applyDecision(card, decision(), cand, collapseSettings());
    sessionRecovery.record(card, cand, decision(), identityOf(cand));

    const entry = sessionRecovery.list()[0]!;
    const showOnceOverride = vi.fn();
    const plainRestore = vi.fn();
    if (identityStillMatches(card, entry.signature)) {
      showOnceOverride(card, entry.signature);
    } else {
      plainRestore(card);
    }
    expect(showOnceOverride).toHaveBeenCalledTimes(1);
    expect(plainRestore).not.toHaveBeenCalled();
  });
});
