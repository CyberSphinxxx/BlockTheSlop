import type { NormalizedVideoCandidate, Surface } from '@/domain/video';
import { SELECTORS, textList, textOf } from '../selectors';
import { videoIdFromUrl } from '../routes';
import { extractChannelIdentity, extractOfficialDisclosure } from './common';

/**
 * Parse a Shorts feed item (the full-screen player container in `/shorts/<id>`).
 * The active video id comes from the URL; title/description live in the
 * engagement panel below the player.
 */
export function parseShortsFeedItem(
  el: ParentNode,
  surface: Surface,
  now: number,
  currentUrl: string,
): NormalizedVideoCandidate {
  const videoId = videoIdFromUrl(currentUrl);
  // Active Shorts title lives in the player-side h1; fall back through
  // engagement-panel description. Sibling feed lockups are never consulted.
  const title = textOf(el, ['h1', '.yt-shortsshortscineytd-player-container', 'h2']) ?? '';
  const description = textOf(el, [
    '#description-text',
    'yt-shortsshortscine-engagement-panel-description',
  ]);
  const channel = extractChannelIdentity(el, SELECTORS.channelLink, SELECTORS.channelName);
  const badges = textList(el, SELECTORS.badges);
  const officialDisclosure = extractOfficialDisclosure(el, SELECTORS.badges);
  const ariaLabels = collectAriaLabels(el);

  return {
    ...(videoId !== undefined ? { videoId } : {}),
    title,
    ...(description !== undefined ? { description } : {}),
    channel,
    surface,
    cardKind: 'shorts-video',
    badges,
    ariaLabels,
    metadataText: [],
    ...(officialDisclosure !== undefined ? { officialDisclosure } : {}),
    isShort: true,
    observedAt: now,
  };
}

/** Parse a Shorts card inside a shelf on a regular page. */
export function parseShortsShelfCard(
  el: Element,
  surface: Surface,
  now: number,
): NormalizedVideoCandidate {
  const link = el.querySelector('a[href*="/shorts/"]');
  let videoId: string | undefined;
  if (link instanceof HTMLAnchorElement) {
    videoId = videoIdFromUrl(link.getAttribute('href') ?? '');
  }
  const title =
    textOf(el, ['video-title', '.title', 'h3', 'span[aria-label]']) ??
    (link instanceof HTMLElement ? (link.getAttribute('aria-label') ?? '').trim() : '') ??
    '';
  const channel = extractChannelIdentity(el, SELECTORS.channelLink, SELECTORS.channelName);
  const badges = textList(el, SELECTORS.badges);
  const officialDisclosure = extractOfficialDisclosure(el, SELECTORS.badges);
  const ariaLabels = collectAriaLabels(el);

  return {
    ...(videoId !== undefined ? { videoId } : {}),
    title,
    channel,
    surface,
    cardKind: 'shorts-video',
    badges,
    ariaLabels,
    metadataText: [],
    ...(officialDisclosure !== undefined ? { officialDisclosure } : {}),
    isShort: true,
    observedAt: now,
  };
}

function collectAriaLabels(el: ParentNode): string[] {
  const out: string[] = [];
  for (const node of el.querySelectorAll('[aria-label]')) {
    const label = node.getAttribute('aria-label');
    if (!label) continue;
    const normalized = label.replace(/\s+/g, ' ').trim();
    if (normalized.length > 0) out.push(normalized);
    if (out.length >= 4) break;
  }
  return out;
}
