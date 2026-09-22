import type { Surface } from '@/domain/video';

/** Page context derived from the current URL. */
export interface PageContext {
  surface: Surface;
  isWatch: boolean;
  isShorts: boolean;
}

/** Parse a YouTube URL into a surface context. Unknown URLs fail open as 'unknown'. */
export function pageContextFromUrl(url: string): PageContext {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { surface: 'unknown', isWatch: false, isShorts: false };
  }
  const path = parsed.pathname.replace(/\/+$/, '');
  const segments = path.split('/').filter(Boolean);

  if (segments[0] === 'shorts') {
    return { surface: 'shorts-feed', isWatch: false, isShorts: true };
  }
  if (segments[0] === 'watch') {
    return { surface: 'watch-sidebar', isWatch: true, isShorts: false };
  }
  if (segments[0] === 'results') {
    return { surface: 'search', isWatch: false, isShorts: false };
  }
  if (segments[0] === 'feed' && segments[1] === 'subscriptions') {
    return { surface: 'subscriptions', isWatch: false, isShorts: false };
  }
  if (segments[0] === 'feed' && segments[1] === 'history') {
    return { surface: 'history', isWatch: false, isShorts: false };
  }
  if (segments[0] === 'feed' && segments[1] === 'storefront') {
    return { surface: 'channel', isWatch: false, isShorts: false };
  }
  if (segments[0] === 'playlist') {
    // `playlist?list=WL` IS the Watch Later list (audit A21).
    if (parsed.searchParams.get('list') === 'WL') {
      return { surface: 'watch-later', isWatch: false, isShorts: false };
    }
    return { surface: 'playlist', isWatch: false, isShorts: false };
  }
  if (
    segments[0] === 'channel' ||
    segments[0]?.startsWith('@') ||
    segments[0] === 'user' ||
    segments[0] === 'c'
  ) {
    return { surface: 'channel', isWatch: false, isShorts: false };
  }
  if (segments.length === 0 || segments[0] === '') {
    return { surface: 'home', isWatch: false, isShorts: false };
  }
  return { surface: 'unknown', isWatch: false, isShorts: false };
}

/** Current page context for the content script environment. */
export function currentPageContext(): PageContext {
  return pageContextFromUrl(location.href);
}

/** Extract the video id from a YouTube watch/shorts URL string. */
export function videoIdFromUrl(url: string): string | undefined {
  try {
    const parsed = new URL(url, location.origin);
    if (parsed.pathname === '/watch') {
      return parsed.searchParams.get('v') ?? undefined;
    }
    const shorts = parsed.pathname.match(/^\/shorts\/([\w-]{5,})/);
    if (shorts) return shorts[1];
    const live = parsed.pathname.match(/^\/live\/([\w-]{5,})/);
    if (live) return live[1];
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * Canonical channel id (`UC...`) from a channel URL path segment, e.g.
 * `/channel/UCxyz` → `UCxyz`. `/@name`, `/user/name`, `/c/name` are returned
 * as handles — legacy aliases are tagged via `legacyAlias` because they may
 * not equal the current handle (audit A21: never conflate with @handles).
 */
export function channelIdentityFromHref(href: string): {
  channelId?: string;
  handle?: string;
  legacyAlias?: string;
} {
  try {
    const parsed = new URL(href, location.origin);
    // Reject cross-origin identity extraction: only same-origin or protocol-
    // relative YouTube paths may produce identities.
    if (parsed.origin !== location.origin && parsed.origin !== 'null') {
      if (
        parsed.hostname !== 'www.youtube.com' &&
        parsed.hostname !== 'youtube.com' &&
        parsed.hostname !== 'm.youtube.com' &&
        parsed.hostname !== 'music.youtube.com'
      ) {
        return {};
      }
    }
    const segments = parsed.pathname.split('/').filter(Boolean);
    const first = segments[0];
    if (first === 'channel' && segments[1]) {
      return { channelId: segments[1] };
    }
    if (first?.startsWith('@')) {
      return { handle: first.slice(1).toLowerCase() };
    }
    if ((first === 'user' || first === 'c') && segments[1]) {
      return { legacyAlias: segments[1].toLowerCase() };
    }
    return {};
  } catch {
    return {};
  }
}

/**
 * SPA navigation detection: YouTube pushes history entries without unload.
 * Compare location signals to the last processed value.
 */
export function navigationSignature(): string {
  return `${location.pathname}${location.search}`;
}
