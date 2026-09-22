import type { Surface } from '@/domain/video';
import { parseCardElement } from '@/youtube/parse/card';

/**
 * Deterministic HTML fixtures shaped like real YouTube card markup.
 * These mirror the two layout generations we support: legacy
 * `ytd-*` renderers and modern `yt-lockup-view-model` components.
 */

export const HUMAN_CARD_HTML = `
<yt-lockup-view-model class="style-scope ytd-rich-item-renderer">
  <a id="video-title-link" href="/watch?v=human123" aria-label="How pancakes were invented in 1832 by History Corner">
    <span id="video-title">How pancakes were invented in 1832</span>
  </a>
  <div class="yt-lockup-metadata-view-model__metadata" id="channel-name">
    <a href="/channel/UCHumanChannel1234567890ab" aria-label="History Corner">History Corner</a>
  </div>
  <span class="yt-lockup-metadata-view-model__text-wrapper">12K views</span>
  <span class="yt-lockup-metadata-view-model__text-wrapper">3 weeks ago</span>
</yt-lockup-view-model>
`;

export const AI_DISCLOSURE_CARD_HTML = `
<yt-lockup-view-model>
  <a id="video-title-link" href="/watch?v=disclose1" aria-label="The fall of Rome, retold by Past Reimagined">
    <span id="video-title">The fall of Rome, retold</span>
  </a>
  <div id="channel-name">
    <a href="/@pastreimagined" aria-label="Past Reimagined">Past Reimagined</a>
  </div>
  <div class="badges">
    <span class="badge badge-shape-wiz__text">Altered or synthetic content</span>
  </div>
</yt-lockup-view-model>
`;

export const AI_DISCUSSION_CARD_HTML = `
<yt-lockup-view-model>
  <a id="video-title" href="/watch?v=discuss2" aria-label="Why AI slop is taking over YouTube by Tech Explained">
    <span id="video-title">Why AI slop is taking over YouTube</span>
  </a>
  <div id="channel-name">
    <a href="/channel/UCTechChannel12345678901" aria-label="Tech Explained">Tech Explained</a>
  </div>
  <div id="snippet-text">An analysis of AI-generated content and how YouTube creators are responding.</div>
</yt-lockup-view-model>
`;

export const MISSING_FIELDS_CARD_HTML = `
<yt-lockup-view-model>
  <a href="/watch?v=partial9"></a>
</yt-lockup-view-model>
`;

export const UNICODE_CARD_HTML = `
<yt-lockup-view-model>
  <a id="video-title-link" href="/watch?v=unicode1" aria-label="Ang dokumentaryo ni Juana Dela Cruz">
    <span id="video-title">一ege ng kasaysayan — Ang huling leeg</span>
  </a>
  <div id="channel-name">
    <a href="/@JuanaDelaCruz" aria-label="Juana Dela Cruz">Juana Dela Cruz</a>
  </div>
</yt-lockup-view-model>
`;

export const SHORTS_SHELF_CARD_HTML = `
<ytm-shorts-lockup-view-model>
  <a href="/shorts/shortid01" aria-label="Quick recipe hack"></a>
  <span class="title">Quick recipe hack</span>
</ytm-shorts-lockup-view-model>
`;

export const MALFORMED_CARD_HTML = `
<yt-lockup-view-model>
  <div><span></span><a href=":::not-a-url"></a></div>
</yt-lockup-view-model>
`;

export const RECYCLED_NODE_BEFORE_HTML = `
<yt-lockup-view-model>
  <a id="video-title-link" href="/watch?v=before111" aria-label="Before title">
    <span id="video-title">Before title</span>
  </a>
  <div id="channel-name"><a href="/channel/UCbefore11111111111111">Before Channel</a></div>
</yt-lockup-view-model>
`;

export const RECYCLED_NODE_AFTER_HTML = `
<yt-lockup-view-model>
  <a id="video-title-link" href="/watch?v=after2222" aria-label="After title">
    <span id="video-title">After title</span>
  </a>
  <div id="channel-name"><a href="/channel/UCafter22222222222222">After Channel</a></div>
</yt-lockup-view-model>
`;

const NOW = 1_700_000_000_000;

/** Parse an HTML string as a card for a given surface. */
export function parseFixture(html: string, surface: Surface = 'home') {
  const template = document.createElement('template');
  template.innerHTML = html.trim();
  const el = template.content.firstElementChild;
  if (el === null) throw new Error('fixture produced no element');
  return { element: el, candidate: parseCardElement(el, surface, NOW) };
}

/** Parse raw HTML into a detached element (for observer tests). */
export function elementFromHtml(html: string): Element {
  const template = document.createElement('template');
  template.innerHTML = html.trim();
  const el = template.content.firstElementChild;
  if (el === null) throw new Error('fixture produced no element');
  return el;
}
