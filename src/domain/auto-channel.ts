import type { Classification } from './classification';
import type { EvidenceCategory } from './evidence';

export const AUTO_CHANNEL_DEFAULT_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
export const AUTO_CHANNEL_MIN_DISTINCT_VIDEOS = 3;
export const AUTO_CHANNEL_MIN_AI_LIKELIHOOD = 0.7;

/**
 * Strong video-production AI categories (V5-08).
 * Slop-only, clickbait, thumbnail-only, or general discussion do NOT qualify.
 */
export const STRONG_AI_PRODUCTION_CATEGORIES: ReadonlySet<EvidenceCategory> =
  new Set<EvidenceCategory>([
    'ai-visual',
    'ai-voice',
    'ai-script',
    'ai-music',
    'deepfake',
    'ai-unspecified',
  ]);

export interface AutoChannelBlockEntry {
  /** Canonical UC... ID of the channel. Required. */
  channelId: string;
  handle?: string | undefined;
  displayName?: string | undefined;
  /** Distinct qualifying video IDs that triggered this block/suggestion. */
  qualifyingVideoIds: string[];
  /** Summary of evidence categories found across qualifying videos. */
  evidenceCategories: EvidenceCategory[];
  /** When this block/suggestion was recorded. */
  recordedAt: number;
  /** When this auto-block expires. Swept on load/rescan. */
  expiresAt: number;
  /**
   * Status:
   * - 'candidate': tracking qualifying videos across visits, threshold (>=3) not yet reached.
   * - 'suggested': candidate meets threshold but auto-blocking is disabled or daily cap reached.
   * - 'active': promoted to active automatic block (opt-in enabled & under daily cap).
   * - 'revoked': user revoked / corrected / allowed, or threshold no longer met.
   */
  status: 'candidate' | 'suggested' | 'active' | 'revoked';
  /** Reason describing why it was created or revoked. */
  reason?: string | undefined;
}

export interface AutoChannelState {
  entries: Record<string, AutoChannelBlockEntry>;
  /** Timestamps (ms) of active promotions within the last 24h to enforce daily cap. */
  promotionTimestamps: number[];
}

export function defaultAutoChannelState(): AutoChannelState {
  return {
    entries: {},
    promotionTimestamps: [],
  };
}

/** Check if channel ID is canonical UC... format */
export function isCanonicalChannelId(id?: string): id is string {
  return typeof id === 'string' && id.startsWith('UC') && id.length >= 10;
}

/**
 * Check if a classification constitutes strong video-production AI evidence (V5-08).
 *
 * Requirements:
 * - Likelihood >= 0.70 (high/very-high confidence)
 * - Contains at least one strong video-production AI category (visual, voice, script, music, deepfake, altered/synthetic disclosure)
 * - Rejects thumbnail-only, discussion-only, or slop/clickbait-only evidence.
 */
export function isQualifyingAiVideo(classification?: Classification): boolean {
  if (!classification) return false;
  const aiLikelihood =
    typeof classification.aiLikelihood === 'number'
      ? classification.aiLikelihood
      : typeof (classification as unknown as { scores?: { ai?: number } }).scores?.ai === 'number'
        ? (classification as unknown as { scores: { ai: number } }).scores.ai
        : 0;

  // Likelihood & confidence check
  if (aiLikelihood < AUTO_CHANNEL_MIN_AI_LIKELIHOOD) return false;
  if (classification.confidence !== 'high' && classification.confidence !== 'very-high') {
    return false;
  }

  // Strong production category check: must have at least one genuine production category
  let hasStrongProductionCategory = false;
  if (classification.categories) {
    for (const cat of STRONG_AI_PRODUCTION_CATEGORIES) {
      if ((classification.categories[cat] ?? 0) >= 0.5) {
        hasStrongProductionCategory = true;
        break;
      }
    }
  }
  if (!hasStrongProductionCategory && Array.isArray(classification.evidence)) {
    hasStrongProductionCategory = classification.evidence.some((e) =>
      STRONG_AI_PRODUCTION_CATEGORIES.has(e.category),
    );
  }

  return hasStrongProductionCategory;
}

/**
 * Filter and count active promotions in the rolling 24-hour window.
 */
export function countRecentPromotions(
  timestamps: readonly number[],
  now = Date.now(),
  windowMs = 86_400_000,
): number {
  return timestamps.filter((ts) => now - ts < windowMs).length;
}

/** Structural validation for persisted auto-channel state. */
export function cleanAutoChannelState(raw: unknown): AutoChannelState {
  if (typeof raw !== 'object' || raw === null) return defaultAutoChannelState();
  const obj = raw as Record<string, unknown>;

  const entries: Record<string, AutoChannelBlockEntry> = {};
  if (typeof obj['entries'] === 'object' && obj['entries'] !== null) {
    const rawEntries = obj['entries'] as Record<string, unknown>;
    for (const [key, val] of Object.entries(rawEntries)) {
      if (typeof val === 'object' && val !== null) {
        const item = val as Record<string, unknown>;
        if (typeof item['channelId'] === 'string' && isCanonicalChannelId(item['channelId'])) {
          const status =
            item['status'] === 'active' ||
            item['status'] === 'suggested' ||
            item['status'] === 'candidate' ||
            item['status'] === 'revoked'
              ? item['status']
              : 'candidate';
          entries[key] = {
            channelId: item['channelId'],
            handle: typeof item['handle'] === 'string' ? item['handle'] : undefined,
            displayName: typeof item['displayName'] === 'string' ? item['displayName'] : undefined,
            qualifyingVideoIds: Array.isArray(item['qualifyingVideoIds'])
              ? item['qualifyingVideoIds'].filter((id): id is string => typeof id === 'string')
              : [],
            evidenceCategories: Array.isArray(item['evidenceCategories'])
              ? (item['evidenceCategories'].filter(
                  (c): c is EvidenceCategory => typeof c === 'string',
                ) as EvidenceCategory[])
              : [],
            recordedAt: typeof item['recordedAt'] === 'number' ? item['recordedAt'] : Date.now(),
            expiresAt:
              typeof item['expiresAt'] === 'number'
                ? item['expiresAt']
                : Date.now() + AUTO_CHANNEL_DEFAULT_TTL_MS,
            status,
            reason: typeof item['reason'] === 'string' ? item['reason'] : undefined,
          };
        }
      }
    }
  }

  const promotionTimestamps = Array.isArray(obj['promotionTimestamps'])
    ? obj['promotionTimestamps'].filter(
        (ts): ts is number => typeof ts === 'number' && Number.isFinite(ts),
      )
    : [];

  return {
    entries,
    promotionTimestamps,
  };
}
