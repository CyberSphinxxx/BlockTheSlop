import type { OfficialDisclosure } from '@/domain/video';
import { queryFirst, textList, textOf } from '../selectors';
import { channelIdentityFromHref, videoIdFromUrl } from '../routes';

/**
 * YouTube's official altered/synthetic content disclosure labels. V7-08:
 * YouTube renders the label in the viewer's UI language, so the documented
 * per-locale variants are matched (diacritics/case-insensitively) — a Spanish
 * or Japanese viewer must get the same first-party evidence as an English
 * one. Matching stays scoped to badge text and the lockup's own aria-label
 * (never the title, description, or sibling cards), and absence of the label
 * is never evidence of anything.
 */
const DISCLOSURE_PHRASES: readonly string[] = [
  'altered or synthetic content',
  'altered/synthetic content',
  'synthetic content',
  'altered content',
  // es
  'contenido alterado o sintético',
  'contenido sintético',
  // fr
  'contenu modifié ou synthétique',
  'contenu synthétique',
  // de
  'verändertes oder synthetisches material',
  'synthetisches material',
  // ja
  '変更または合成コンテンツ',
  '合成コンテンツ',
  // pt
  'conteúdo alterado ou sintético',
  // it
  'contenuto alterato o sintetico',
];

/** Case/diacritics-insensitive containment (NFD strips combining marks). */
function containsDisclosurePhrase(text: string): string | undefined {
  const normalized = text.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '');
  for (const phrase of DISCLOSURE_PHRASES) {
    const target = phrase.normalize('NFD').replace(/\p{M}/gu, '');
    if (normalized.includes(target)) return phrase;
  }
  return undefined;
}

/**
 * Some legacy badges are unrelated (e.g. "CC"); only treat matched phrases as
 * disclosure. Returns undefined when no badge matches a disclosure phrase.
 * V7-08: falls back to the container's own aria-label when no badge element
 * carries the label (aria-label is the accessible name YouTube puts on the
 * disclosure anchor in lockup-based layouts).
 */
export function extractOfficialDisclosure(
  root: ParentNode,
  badgeSelectors: readonly string[],
): OfficialDisclosure | undefined {
  const badges = textList(root, badgeSelectors, 12);
  for (const badge of badges) {
    const matched = containsDisclosurePhrase(badge);
    if (matched !== undefined) {
      return { present: true, text: badge };
    }
  }
  // Aria-label fallback: the lockup's own accessible name (bounded list).
  for (const node of root.querySelectorAll('[aria-label]')) {
    const label = node.getAttribute('aria-label');
    if (!label) continue;
    const matched = containsDisclosurePhrase(label);
    if (matched !== undefined) {
      return { present: true, text: label.trim().slice(0, 200) };
    }
  }
  return undefined;
}

/** Pull the primary video link and derive video id + url. */
export function extractVideoLink(
  root: ParentNode,
  linkSelectors: readonly string[],
): { videoId?: string; url?: string } {
  const link = queryFirst(root, linkSelectors);
  if (!(link instanceof HTMLAnchorElement)) return {};
  const href = link.getAttribute('href');
  if (!href) return {};
  const videoId = videoIdFromUrl(href);
  if (videoId === undefined) {
    return { ...(href.startsWith('/') ? {} : { url: href }) };
  }
  return { videoId, url: href };
}

/**
 * Extract channel identity from channel links, preferring canonical IDs.
 * Legacy `/user/`, `/c/` aliases are surfaced as `legacyAlias`, never as a
 * verified handle (audit A21) — rules matching treats them as unresolved.
 */
export function extractChannelIdentity(
  root: ParentNode,
  channelLinkSelectors: readonly string[],
  channelNameSelectors: readonly string[],
): { channelId?: string; handle?: string; legacyAlias?: string; displayName?: string } {
  const link = queryFirst(root, channelLinkSelectors);
  let identity: { channelId?: string; handle?: string; legacyAlias?: string } = {};
  if (link instanceof HTMLAnchorElement) {
    const href = link.getAttribute('href');
    if (href) identity = channelIdentityFromHref(href);
  }
  const displayName = textOf(root, channelNameSelectors);
  return {
    ...(identity.channelId !== undefined ? { channelId: identity.channelId } : {}),
    ...(identity.handle !== undefined ? { handle: identity.handle } : {}),
    ...(identity.legacyAlias !== undefined ? { legacyAlias: identity.legacyAlias } : {}),
    ...(displayName !== undefined ? { displayName } : {}),
  };
}

/** True when the element looks like a Shorts card/feed item. */
export function looksLikeShorts(root: ParentNode): boolean {
  const link = root.querySelector('a[href*="/shorts/"]');
  return link !== null;
}

/** Safety wrapper: never let one malformed card break the loop. */
export function safeParse<T>(parse: () => T, fallback: T): T {
  try {
    return parse();
  } catch {
    return fallback;
  }
}
