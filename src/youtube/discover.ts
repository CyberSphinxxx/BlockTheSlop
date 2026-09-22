import type { Surface } from '@/domain/video';
import { queryAll, SELECTORS } from './selectors';
import { parseCardElement } from './parse/card';
import { parseShortsShelfCard, parseShortsFeedItem } from './parse/shorts';

export interface DiscoveredCard {
  element: Element;
  kind: 'card' | 'shorts-card';
}

/** All selectors that identify a card-like container. */
const CARD_SELECTORS: readonly string[] = [
  ...SELECTORS.lockup,
  'ytd-compact-video-renderer',
  'ytd-grid-video-renderer',
  'ytd-playlist-video-renderer',
];

const SHORTS_SELECTORS: readonly string[] = [
  'ytm-shorts-lockup-view-model',
  'ytd-reel-item-renderer',
];

function matchesAny(el: Element, selectors: readonly string[]): boolean {
  return selectors.some((selector) => {
    try {
      return el.matches(selector);
    } catch {
      return false;
    }
  });
}

/**
 * Discover candidate video cards within a root (the document, an added
 * mutation subtree, or a card element itself). Handles the common YouTube
 * cases where the added root IS the card, contains cards, or sits INSIDE a
 * card whose metadata just changed. Bounded ancestor walk — never a
 * whole-document rescan.
 */
export function discoverCards(root: ParentNode, _surface: Surface): DiscoveredCard[] {
  const out: DiscoveredCard[] = [];
  const seen = new Set<Element>();

  const consider = (el: Element): void => {
    if (seen.has(el)) return;
    seen.add(el);
    if (matchesAny(el, SHORTS_SELECTORS)) {
      out.push({ element: el, kind: 'shorts-card' });
      return;
    }
    if (matchesAny(el, CARD_SELECTORS)) {
      // Skip containers whose children are the real cards.
      if (el.querySelector(CARD_SELECTORS.join(',')) === null) {
        out.push({ element: el, kind: 'card' });
      }
    }
  };

  // Case 1: the root itself is (or contains) cards.
  if (root instanceof Element) {
    consider(root);
    // Case 2: the root sits inside a card whose metadata was appended/changed.
    // Bounded walk keeps this O(depth) not O(document).
    let ancestor: Element | null = root.parentElement;
    for (let depth = 0; ancestor !== null && depth < 4; depth++) {
      if (matchesAny(ancestor, CARD_SELECTORS) || matchesAny(ancestor, SHORTS_SELECTORS)) {
        consider(ancestor);
        break;
      }
      ancestor = ancestor.parentElement;
    }
  }

  // Case 3: cards anywhere below the root.
  for (const el of queryAll(root, CARD_SELECTORS)) {
    consider(el);
  }
  for (const el of queryAll(root, SHORTS_SELECTORS)) {
    consider(el);
  }

  return out;
}

/** Parse a discovered card into a normalized candidate. */
export function parseDiscovered(card: DiscoveredCard, surface: Surface, now: number) {
  return card.kind === 'shorts-card'
    ? parseShortsShelfCard(card.element, surface, now)
    : parseCardElement(card.element, surface, now);
}

/**
 * Parse the ACTIVE Shorts feed item from the current document (R09/DOM-03).
 * The video identity comes from the URL only; sibling lockups in the feed
 * never inherit it.
 */
export function parseDiscoveredFeedItem(
  root: ParentNode,
  surface: Surface,
  now: number,
  currentUrl: string,
) {
  return parseShortsFeedItem(root, surface, now, currentUrl);
}
