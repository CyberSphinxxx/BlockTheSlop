import type { NormalizedVideoCandidate, Surface } from '@/domain/video';
import { SELECTORS, textList, textOf } from '../selectors';
import {
  extractChannelIdentity,
  extractOfficialDisclosure,
  extractVideoLink,
  looksLikeShorts,
} from './common';

/**
 * Parse any grid/search/sidebar card into a normalized candidate.
 * All fields are best-effort; a card missing metadata still yields a partial
 * candidate so detection can run on whatever text exists (fail open).
 */
export function parseCardElement(
  el: Element,
  surface: Surface,
  now: number,
): NormalizedVideoCandidate {
  const link = extractVideoLink(el, SELECTORS.videoLink);
  const channel = extractChannelIdentity(el, SELECTORS.channelLink, SELECTORS.channelName);
  const title = textOf(el, SELECTORS.title) ?? '';
  const description = textOf(el, SELECTORS.descriptionSnippet);
  const badges = textList(el, SELECTORS.badges);
  const metadataText = textList(el, SELECTORS.metadataLines);
  const ariaLabels = collectAriaLabels(el);
  const officialDisclosure = extractOfficialDisclosure(el, SELECTORS.badges);
  const isShort = looksLikeShorts(el);

  return {
    ...(link.videoId !== undefined ? { videoId: link.videoId } : {}),
    ...(link.url !== undefined ? { url: link.url } : {}),
    title,
    ...(description !== undefined ? { description } : {}),
    channel,
    surface,
    cardKind: isShort ? 'shorts-video' : 'video',
    badges,
    ariaLabels,
    metadataText,
    ...(officialDisclosure !== undefined ? { officialDisclosure } : {}),
    isShort,
    observedAt: now,
  };
}

/** aria-labels often carry title/channel info on modern lockup layouts. */
function collectAriaLabels(el: Element): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const node of el.querySelectorAll('[aria-label]')) {
    const label = node.getAttribute('aria-label');
    if (!label) continue;
    const normalized = label.replace(/\s+/g, ' ').trim();
    if (normalized.length === 0 || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
    if (out.length >= 6) break;
  }
  return out;
}
