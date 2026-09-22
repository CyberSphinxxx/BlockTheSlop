/**
 * Normalized video candidate — the contract between YouTube DOM parsing
 * and the detection engine. Parsers produce these; detectors consume them.
 * Nothing in this file knows about the DOM.
 */

export type Surface =
  | 'home'
  | 'search'
  | 'subscriptions'
  | 'watch-sidebar'
  | 'channel'
  | 'playlist'
  | 'history'
  | 'watch-later'
  | 'shorts-shelf'
  | 'shorts-feed'
  | 'unknown';

/**
 * Logical card kind — deliberately distinct from page surface (audit A07):
 * a home page can embed a shorts shelf; the watch page shows compact cards.
 */
export type CardKind = 'video' | 'shorts-video';

export interface ChannelIdentity {
  /** Canonical `UC...` channel ID extracted from hrefs when available. */
  channelId?: string | undefined;
  /** `@handle` or legacy `/user/` or `/c/` name, without leading `@`. */
  handle?: string | undefined;
  /** Display name — unstable, used only as a last-resort fallback key. */
  displayName?: string | undefined;
}

export interface OfficialDisclosure {
  /** YouTube's altered/synthetic content label or equivalent first-party flag. */
  present: boolean;
  /** The matched label text, when present. */
  text?: string | undefined;
}

export interface NormalizedVideoCandidate {
  videoId?: string | undefined;
  url?: string | undefined;
  title: string;
  description?: string | undefined;

  channel: ChannelIdentity;

  surface: Surface;
  /** Logical card kind (video vs shorts), independent of the page surface. */
  cardKind: CardKind;

  badges: string[];
  ariaLabels: string[];
  metadataText: string[];

  officialDisclosure?: OfficialDisclosure | undefined;

  isShort: boolean;
  observedAt: number;
}

/**
 * Stable processing identity for a card. Two snapshots of the same DOM node
 * with different signatures must be re-processed (recycled node detection).
 * Includes description/description-bearing fields (audit A06): a card whose
 * description or badges hydrate later MUST re-evaluate.
 */
export interface CardIdentity {
  videoId?: string | undefined;
  title: string;
  channelId?: string | undefined;
  handle?: string | undefined;
  displayName?: string | undefined;
  disclosure: boolean;
  isShort: boolean;
}

export function identityOf(candidate: NormalizedVideoCandidate): string {
  return JSON.stringify([
    candidate.videoId ?? null,
    candidate.title,
    candidate.description ?? null,
    candidate.channel.channelId ?? null,
    candidate.channel.handle ?? null,
    candidate.channel.displayName ?? null,
    candidate.officialDisclosure?.present ?? false,
    candidate.badges.length,
    candidate.isShort,
    candidate.cardKind,
  ]);
}

/** Normalize a `UC...` channel id; returns undefined for non-canonical ids. */
export function canonicalChannelId(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim();
  return /^UC[\w-]{22}$/.test(trimmed) ? trimmed : undefined;
}

/** Strip `@` from handles and normalize case for fallback matching. */
export function normalizeHandle(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim().replace(/^@/, '').toLowerCase();
  return trimmed.length > 0 ? trimmed : undefined;
}
