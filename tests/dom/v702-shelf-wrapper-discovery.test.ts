import { describe, expect, it } from 'vitest';
import { discoverCards } from '@/youtube/discover';
import { parseShortsShelfCard } from '@/youtube/parse/shorts';
import { validateMessageRequest } from '@/background/message-validation';

/**
 * V7-02 regression: the whole-shelf wrapper (ytd-rich-item-renderer around an
 * entire Shorts shelf) must NOT be discovered as a card. It contains many
 * Shorts lockups; treating it as one card made it inherit the FIRST /shorts/
 * link's videoId with an empty title, producing:
 *  - an invalid history:record payload (title required) → fail-open noise,
 *  - an invalid rawInput that got the WHOLE classification:getMany batch
 *    rejected (cache degradation for every card on the page),
 *  - an early-gate collapse pre-mark that could hide the ENTIRE shelf
 *    (visible Shorts included) when any contained video was rule-blocked.
 */

const SHELF_HTML = `
<div id="contents">
  <ytd-rich-item-renderer data-testid="shelf-item">
    <div id="content">
      <ytd-rich-shelf-renderer>
        <div id="contents">
          <ytm-shorts-lockup-view-model data-testid="short-1">
            <a href="/shorts/shelfvid01" aria-label="Short one by Quick Bites"></a>
            <span class="title">Short one</span>
          </ytm-shorts-lockup-view-model>
          <ytm-shorts-lockup-view-model data-testid="short-2">
            <a href="/shorts/shelfvid02" aria-label="Short two by Quick Bites"></a>
            <span class="title">Short two</span>
          </ytm-shorts-lockup-view-model>
        </div>
      </ytd-rich-shelf-renderer>
    </div>
  </ytd-rich-item-renderer>
</div>
`;

describe('V7-02: shelf wrappers are containers, not cards', () => {
  it('discoverCards returns exactly the Shorts lockups — never the shelf wrapper', () => {
    const root = document.createElement('div');
    root.innerHTML = SHELF_HTML.trim();
    document.body.appendChild(root);

    const cards = discoverCards(root, 'home');
    const elements = cards.map((c) => c.element);
    expect(elements).toHaveLength(2);
    for (const el of elements) {
      expect(el.tagName.toLowerCase()).toBe('ytm-shorts-lockup-view-model');
    }
    expect(elements.some((el) => el.matches('[data-testid="shelf-item"]'))).toBe(false);
  });

  it('every discovered shelf card parses to a recordable candidate (valid payload)', () => {
    const root = document.createElement('div');
    root.innerHTML = SHELF_HTML.trim();
    document.body.appendChild(root);

    for (const card of discoverCards(root, 'shorts-shelf')) {
      const candidate = parseShortsShelfCard(card.element, 'shorts-shelf', 1_700_000_000_000);
      // A hide of this candidate must produce a payload the background accepts
      // (non-empty title, bounded fields) — otherwise the hide fails open.
      const validation = validateMessageRequest({
        type: 'history:record',
        payload: {
          videoId: candidate.videoId,
          title: candidate.title,
          channelId: candidate.channel.channelId,
          channelName: candidate.channel.displayName,
          surface: candidate.surface,
          decision: {
            action: 'hide',
            reason: 'user-rule',
            ruleId: `video-block:${candidate.videoId ?? ''}`,
            explanation: ['Hidden by your rule.'],
          },
          occurredAt: candidate.observedAt,
          operationId: `c:hide:${candidate.videoId ?? ''}:123`,
          sessionKey: 'sessionkey',
        },
      });
      expect(validation.ok).toBe(true);
    }
  });
});
