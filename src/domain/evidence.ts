/**
 * Evidence model — every automatic decision must be explainable.
 *
 * Evidence items are produced by detectors, aggregated into a classification,
 * and rendered as human-readable explanations. Evidence never mutates the DOM
 * and never persists a final decision.
 */

/** Where a piece of evidence came from. */
export type EvidenceOrigin = 'first-party' | 'local-rule' | 'user' | 'community' | 'experimental';

/** Filterable content categories. */
export type EvidenceCategory =
  | 'ai-visual'
  | 'ai-voice'
  | 'ai-script'
  | 'ai-music'
  | 'ai-thumbnail'
  | 'deepfake' /** Generation evidence with unspecified modality (04 §8): an official
   *   altered/synthetic label or a bare generation disclosure. Supports
   *   the AI dimension with a cap; never proves visuals/music/slop. */
  | 'ai-unspecified'
  | 'content-farm'
  | 'repetitive'
  | 'clickbait'
  | 'ai-discussion'
  | 'creator-disclosure';

export const EVIDENCE_CATEGORIES: readonly EvidenceCategory[] = [
  'ai-visual',
  'ai-voice',
  'ai-script',
  'ai-music',
  'ai-thumbnail',
  'deepfake',
  'ai-unspecified',
  'content-farm',
  'repetitive',
  'clickbait',
  'ai-discussion',
  'creator-disclosure',
];

/** How a category evidence value affects overall likelihoods. */
export type EvidencePolarity = 'supports' | 'opposes';

/** What aspect of the content a claim is about (04 §8 claimScope). */
export type ClaimScope =
  | 'visual'
  | 'audio'
  | 'script'
  | 'music'
  | 'thumbnail' /** Generation declared without naming a modality. */
  | 'unspecified-generation';

export interface Evidence {
  /** Stable identifier, e.g. `disclosure:yt-badge`. */
  id: string;
  origin: EvidenceOrigin;
  category: EvidenceCategory;
  /** Detector identifier that produced this evidence. */
  detector: string;
  /** 0..1 weight within the category. */
  strength: number;
  polarity: EvidencePolarity;
  /** Machine-readable reason code, e.g. `yt-altered-synthetic-label`. */
  reasonCode: string;
  /** Human-readable sentence; safe to render as text. */
  reasonText: string;
  /** Provenance (04 §8): the rule/regex that matched, when rule-based. */
  ruleId?: string | undefined;
  /** Kind of source the match came from. */
  sourceKind?: 'title' | 'description' | 'badge' | 'aria' | 'metadata' | 'channel';
  /** Which field the match was found in. */
  matchedField?: 'title' | 'description' | 'badge' | 'aria' | 'metadata';
  /** Bounded (≤120 chars) excerpt of the matched text; display-safe. */
  matchedExcerpt?: string | undefined;
  /** What the claim scopes to (visual/audio/script/... or unspecified). */
  claimScope?: ClaimScope | undefined;
  /**
   * Correlation group: evidence describing the SAME underlying claim from
   * different detectors/rules shares a key, so overlapping matches are not
   * counted as independent sources (DET-17).
   */
  correlationKey?: string | undefined;
}

/** Categories that contribute to the AI dimension (vs. slop dimension). */
export const AI_CATEGORIES: readonly EvidenceCategory[] = [
  'ai-visual',
  'ai-voice',
  'ai-script',
  'ai-music',
  'ai-thumbnail',
  'deepfake',
  'ai-unspecified',
];

/** Categories that contribute to the slop dimension. */
export const SLOP_CATEGORIES: readonly EvidenceCategory[] = [
  'content-farm',
  'repetitive',
  'clickbait',
];

/**
 * Categories with special handling:
 * - `ai-unspecified` supports the AI dimension WITH A CAP (0.6): an official
 *   altered/synthetic label or bare generation disclosure proves generation
 *   but not the modality — it must never fully drive visual/music certainty
 *   nor slop (DET-19).
 * - `ai-discussion` evidence opposes AI classification (false-positive guard).
 * - `creator-disclosure` supports AI evidence strongly (see detectors).
 */
export const SPECIAL_CATEGORIES: readonly EvidenceCategory[] = [
  'ai-unspecified',
  'ai-discussion',
  'creator-disclosure',
];

/** Cap applied when ONLY unspecified-generation evidence is present. */
export const AI_UNSPECIFIED_DIMENSION_CAP = 0.75;

export function isAiCategory(category: EvidenceCategory): boolean {
  return (AI_CATEGORIES as readonly string[]).includes(category);
}

export function isSlopCategory(category: EvidenceCategory): boolean {
  return (SLOP_CATEGORIES as readonly string[]).includes(category);
}

/** Detection input provided to detectors alongside the normalized candidate. */
export interface DetectionContext {
  /** Locally cached channel reputation, if any (from providers or corrections). */
  channelReputation?: ChannelReputationSignal | undefined;
  /** Previous user corrections relevant to this video/channel. */
  corrections?: UserCorrectionSignals | undefined;
  /** Locale hint extracted from the page/document (BCP-47). */
  locale?: string | undefined;
  /** Optional remote/community reputation for this video (default OFF in v1). */
  videoReputation?: VideoReputationSignal | undefined;
  /** User-selected additive rule packs (CFG-09); undefined = defaults. */
  enabledRulePacks?: { fil: boolean } | undefined;
}

/** Aggregated channel-level reputation used as contextual (never decisive) evidence. */
export interface ChannelReputationSignal {
  /** 0..1 prior probability that recent uploads are AI-generated/slop. */
  aiPrior: number;
  /** Number of observations backing the prior. */
  sampleSize: number;
  /** Where this signal came from. */
  origin: EvidenceOrigin;
}

export interface VideoReputationSignal {
  /** 0..1 likelihood assigned by the remote provider. */
  aiLikelihood: number;
  slopLikelihood: number;
  origin: EvidenceOrigin;
}

/** Personal correction signals derived from review-queue actions. */
export interface UserCorrectionSignals {
  /** User marked this exact video as Not AI / Not slop. */
  notAiVideoIds: readonly string[];
  notSlopVideoIds: readonly string[];
  /** Channels the user allowed/blocked explicitly. */
  allowedChannelIds: readonly string[];
  blockedChannelIds: readonly string[];
}
