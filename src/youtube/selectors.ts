/**
 * Centralized YouTube selectors.
 *
 * Rules (AGENTS.md §8): every concept lists multiple candidate selectors,
 * ordered from most stable/semantic to most structural. Parsers must treat
 * missing elements as normal. Never inline selectors elsewhere.
 */

/** Self-marker attribute so tests and cleanup can find extension UI. */
export const BTS_PREFIX = 'bts';
export const ATTR_STATE = 'data-bts-state';
export const ATTR_VIDEO_ID = 'data-bts-video-id';
export const ATTR_SURFACE = 'data-bts-surface';

export const SELECTORS = {
  /** Video link that identifies a card's primary target (works for watch, shorts). */
  videoLink: [
    'a#video-title-link',
    'a#video-title',
    'a.yt-lockup-metadata-view-model__title',
    'a[href*="/watch?v="]',
    'a[href*="/shorts/"]',
  ],

  /** Title text nodes. */
  title: [
    '#video-title',
    '#video-title-link',
    'yt-formatted-string#video-title',
    '.yt-lockup-metadata-view-model__title',
    'a.yt-lockup-metadata-view-model-wrapped__title',
    '.ytd-rich-grid-media h3',
  ],

  /** Channel name (several layouts). */
  channelName: [
    '#channel-name #text',
    '#channel-name a',
    'ytd-channel-name #text',
    'ytd-channel-name a',
    '.yt-lockup-metadata-view-model__metadata #text',
    'a.yt-lockup-metadata-view-model__metadata',
    '.ytd-video-meta-block #byline',
  ],

  /** Channel link containing the channel URL (id or handle). */
  channelLink: [
    '#channel-name a',
    'ytd-channel-name a',
    'a.yt-lockup-metadata-view-model__metadata[href*="/channel/"]',
    'a.yt-lockup-metadata-view-model__metadata[href*="/@"]',
    'a[href*="/channel/"]',
    'a[href^="/@"]',
    'a[href*="/user/"]',
    'a[href*="/c/"]',
  ],

  /** Long description/snippet on some surfaces. */
  descriptionSnippet: [
    '#snippet-text',
    '.yt-core-attributed-string.yt-lockup-metadata-view-model__descriptionSnippet',
    '.ytd-video-renderer #snippet-text',
  ],

  /** Metadata lines (views, age). */
  metadataLines: [
    '#metadata-line span',
    '.yt-lockup-metadata-view-model__text-wrapper span',
    '.ytd-video-meta-block #metadata span',
  ],

  /** Badges (4K, New, live, and the altered/synthetic disclosure). */
  badges: [
    'yt-content-badge-view .badge-style-type-live-now-alternate',
    '.badges .badge',
    'ytd-badge-supported-renderer .badge',
    '.badge-shape-wiz__text',
    'yt-badge-view-model.yt-badge-view-model span',
  ],

  /** Thumbnails (used to attach overlays). */
  thumbnail: [
    'ytd-thumbnail a',
    'a.yt-lockup-view-model__content-image',
    '.ytd-rich-grid-media #thumbnail',
    'a#thumbnail',
  ],

  /** Compact sidebar/watch-next cards. */
  compactCard: [
    'ytd-compact-video-renderer',
    'ytd-compact-playlist-renderer',
    'ytd-watch-next-secondary-results-renderer ytd-compact-video-renderer',
    'yt-lockup-view-model',
  ],

  /** Lockup-based modern layouts (home/search/channel). */
  lockup: ['yt-lockup-view-model', 'ytd-rich-item-renderer', 'ytd-video-renderer'],
} as const;

/** Try selectors in order; return the first element found (or null). */
export function queryFirst(root: ParentNode, selectors: readonly string[]): Element | null {
  for (const selector of selectors) {
    try {
      const el = root.querySelector(selector);
      if (el) return el;
    } catch {
      // Invalid selector on older browsers — skip it.
    }
  }
  return null;
}

export function queryAll(root: ParentNode, selectors: readonly string[]): Element[] {
  const out: Element[] = [];
  const seen = new Set<Element>();
  for (const selector of selectors) {
    try {
      for (const el of root.querySelectorAll(selector)) {
        if (!seen.has(el)) {
          seen.add(el);
          out.push(el);
        }
      }
    } catch {
      // Invalid selector — skip.
    }
  }
  return out;
}

/** Collect visible text from the first matching node(s), whitespace-normalized. */
export function textOf(root: ParentNode, selectors: readonly string[]): string | undefined {
  const el = queryFirst(root, selectors);
  if (!el) return undefined;
  const text = (el.textContent ?? '').replace(/\s+/g, ' ').trim();
  return text.length > 0 ? text : undefined;
}

export function textList(root: ParentNode, selectors: readonly string[], max = 8): string[] {
  return queryAll(root, selectors)
    .slice(0, max)
    .map((el) => (el.textContent ?? '').replace(/\s+/g, ' ').trim())
    .filter((t) => t.length > 0);
}
