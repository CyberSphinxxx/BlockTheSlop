import type { OfficialDisclosure } from '@/domain/video';
import { queryFirst, textList, textOf } from '../selectors';
import { channelIdentityFromHref, videoIdFromUrl } from '../routes';

/**
 * YouTube's official altered/synthetic content disclosure labels (en + common
 * variants). First-party disclosure is strong evidence for the AI dimension.
 * Matching is case-insensitive phrase containment on badge text only.
 */
const DISCLOSURE_PHRASES: readonly string[] = [
  'altered or synthetic content',
  'altered/synthetic content',
  'synthetic content',
  'altered content',
];

/**
 * Some legacy badges are unrelated (e.g. "CC"); only treat matched phrases as
 * disclosure. Returns undefined when no badge matches a disclosure phrase.
 */
export function extractOfficialDisclosure(
  root: ParentNode,
  badgeSelectors: readonly string[],
): OfficialDisclosure | undefined {
  const badges = textList(root, badgeSelectors, 12);
  for (const badge of badges) {
    const lower = badge.toLowerCase();
    for (const phrase of DISCLOSURE_PHRASES) {
      if (lower.includes(phrase)) {
        return { present: true, text: badge };
      }
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
