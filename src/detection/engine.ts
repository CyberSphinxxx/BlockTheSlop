import type { Classification } from '@/domain/classification';
import type { DetectionContext, Evidence, EvidenceCategory } from '@/domain/evidence';
import { EVIDENCE_CATEGORIES, isAiCategory, isSlopCategory } from '@/domain/evidence';
import type { NormalizedVideoCandidate } from '@/domain/video';
import { CLASSIFIER_VERSION } from '@/domain/versions';
import { RULES_VERSION } from '../domain/versions';
import { officialDisclosureDetector } from './detectors/official-disclosure';
import { textRulesDetector } from './detectors/text-rules';
import { hashtagContextDetector } from './detectors/hashtags';
import { creatorDisclosureDetector } from './detectors/creator-disclosure';
import { aiDiscussionDetector } from './detectors/ai-discussion';
import { contentFarmDetector } from './detectors/content-farm';
import { channelReputationDetector } from './detectors/channel-reputation';
import { AI_UNSPECIFIED_DIMENSION_CAP } from '@/domain/evidence';

/** A detector produces evidence from a normalized candidate. DOM-free. */
export interface Detector {
  id: string;
  detect(
    candidate: NormalizedVideoCandidate,
    context: DetectionContext,
  ): Evidence[] | Promise<Evidence[]>;
}

export const CLASSIFIER_DETECTORS: readonly Detector[] = [
  officialDisclosureDetector,
  textRulesDetector,
  hashtagContextDetector,
  creatorDisclosureDetector,
  aiDiscussionDetector,
  contentFarmDetector,
  channelReputationDetector,
];

/** Aggregation tuning constants — documented, not magic. */
export const AGGREGATION = {
  /**
   * Per-category evidence is combined with probabilistic-or. Damping scales
   * with strength: weak heuristics are damped hard (many keyword matches must
   * accumulate), strong first-party evidence carries most of its weight.
   */
  dampingBase: 0.6,
  dampingStrengthScale: 0.4,
  /** Bonus for evidence from independent origins (diversity). */
  diversityBonusPerOrigin: 0.06,
  diversityCap: 0.18,
  /** Contradictory (opposing) evidence cuts confidence, not just score. */
  contradictionPenalty: 0.25,
} as const;

/** Effective damping for a piece of evidence (see AGGREGATION docs). */
function dampingFor(strength: number): number {
  return AGGREGATION.dampingBase + AGGREGATION.dampingStrengthScale * strength;
}

type ConfidenceLevel = Classification['confidence'];

/**
 * Correlation dedupe (DET-17): evidence items describing the SAME underlying
 * claim (shared correlationKey, e.g. three detectors matching one creator
 * disclosure phrase) are reduced to the strongest item BEFORE aggregation, so
 * overlapping matches are never counted as independent sources. Items without
 * a correlationKey are independent by definition and never merged.
 */
export function dedupeCorrelatedEvidence(evidence: Evidence[]): Evidence[] {
  const byKey = new Map<string, Evidence>();
  const out: Evidence[] = [];
  for (const item of evidence) {
    if (item.correlationKey === undefined) {
      out.push(item);
      continue;
    }
    const existing = byKey.get(item.correlationKey);
    if (existing === undefined || item.strength > existing.strength) {
      byKey.set(item.correlationKey, item);
    }
  }
  return [...out, ...byKey.values()];
}

/**
 * Aggregate evidence into a classification.
 *
 * Model (DETECTION_ENGINE.md §5):
 * - evidence maps to category likelihood (probabilistic OR with damping),
 * - AI and slop likelihood are computed independently,
 * - confidence depends on evidence diversity and reliability,
 * - contradictory evidence reduces confidence.
 */
export function aggregateEvidence(
  rawEvidence: Evidence[],
  candidate: NormalizedVideoCandidate,
  context: DetectionContext,
  now: number = Date.now(),
): Classification {
  const evidence = dedupeCorrelatedEvidence(rawEvidence);
  const categories: Partial<Record<EvidenceCategory, number>> = {};

  for (const category of EVIDENCE_CATEGORIES) {
    const supporting = evidence.filter((e) => e.category === category && e.polarity === 'supports');
    const opposing = evidence.filter((e) => e.category === category && e.polarity === 'opposes');
    let score = 0;
    for (const item of supporting) {
      score = score + (1 - score) * item.strength * dampingFor(item.strength);
    }
    for (const item of opposing) {
      score *= 1 - item.strength * AGGREGATION.dampingBase;
    }
    if (supporting.length > 0 || opposing.length > 0) {
      categories[category] = clamp01(score);
    }
  }

  const aiLikelihood = computeDimensionScore(categories, isAiCategory, evidence);
  const slopLikelihood = computeDimensionScore(categories, isSlopCategory, evidence);
  const confidence = computeConfidence(evidence, aiLikelihood, slopLikelihood, context);

  return {
    aiLikelihood,
    slopLikelihood,
    categories,
    confidence,
    evidence,
    classifierVersion: CLASSIFIER_VERSION,
    rulesVersion: RULES_VERSION,
    evaluatedAt: now,
  };
}

function computeDimensionScore(
  categories: Partial<Record<EvidenceCategory, number>>,
  belongs: (category: EvidenceCategory) => boolean,
  evidence: Evidence[],
): number {
  let score = 0;
  for (const [category, value] of Object.entries(categories)) {
    if (!belongs(category as EvidenceCategory) || value === undefined) continue;
    // DET-19: unspecified-generation evidence supports the AI dimension with
    // a cap — it proves generation happened but not the modality, and must
    // never fully drive visual/music/slop certainty on its own. Concrete
    // category evidence (ai-visual etc.) is uncapped and dominates.
    const effective =
      category === 'ai-unspecified' ? Math.min(value, AI_UNSPECIFIED_DIMENSION_CAP) : value;
    score = Math.max(score, effective);
  }
  // The creator-disclosure category supports the AI dimension via its
  // original evidence categories, not through its own bucket.
  const disclosureSupport = evidence
    .filter((e) => e.category === 'creator-disclosure' && e.polarity === 'supports')
    .reduce((acc, e) => Math.max(acc, e.strength), 0);
  if (belongs('ai-visual')) {
    score = Math.max(score, disclosureSupport);
  }
  return clamp01(score);
}

function computeConfidence(
  evidence: Evidence[],
  aiLikelihood: number,
  slopLikelihood: number,
  context: DetectionContext,
): ConfidenceLevel {
  const supporting = evidence.filter((e) => e.polarity === 'supports');
  const opposing = evidence.filter((e) => e.polarity === 'opposes');
  const hasFirstParty = supporting.some((e) => e.origin === 'first-party');
  const origins = new Set(supporting.map((e) => e.origin)).size;
  const detectors = new Set(supporting.map((e) => e.detector)).size;
  const bestScore = Math.max(aiLikelihood, slopLikelihood);

  // Contradictions reduce confidence (spec §5, §7).
  const contradictionFactor = opposing.length > 0 ? 1 - AGGREGATION.contradictionPenalty : 1;

  let level: ConfidenceLevel;
  if (bestScore >= 0.85 && (hasFirstParty || (origins >= 2 && detectors >= 2))) {
    level = 'very-high';
  } else if (bestScore >= 0.65 && origins >= 1 && detectors >= 1) {
    level = 'high';
  } else if (bestScore >= 0.4) {
    level = 'medium';
  } else {
    level = 'low';
  }

  // Diversity bonus: independent origins/detectors raise confidence one step
  // when several support the same conclusion (DETECTION_ENGINE.md §6).
  const diverse = origins >= 2 && detectors >= 2;
  if (diverse) {
    level = upgrade(level);
  }

  if (opposing.length > 0) {
    // Contradictory evidence always reduces confidence (spec §5): even strong
    // first-party signals lose a step when independent context disagrees.
    level = downgrade(level);
  }

  // Channel reputation alone cannot produce the highest confidence.
  const onlyReputation =
    supporting.length > 0 && supporting.every((e) => e.detector === 'channel-reputation');
  if (onlyReputation && level === 'very-high') {
    level = 'high';
  }

  void context;
  void contradictionFactor;
  return level;
}

function upgrade(level: ConfidenceLevel): ConfidenceLevel {
  switch (level) {
    case 'high':
      return 'very-high';
    case 'medium':
      return 'high';
    case 'low':
      return 'medium';
    default:
      return 'very-high';
  }
}

function downgrade(level: ConfidenceLevel): ConfidenceLevel {
  switch (level) {
    case 'very-high':
      return 'high';
    case 'high':
      return 'medium';
    case 'medium':
      return 'low';
    default:
      return 'low';
  }
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/** Convenience: run all detectors then aggregate. */
export async function classifyCandidate(
  candidate: NormalizedVideoCandidate,
  context: DetectionContext,
  detectors: readonly Detector[] = CLASSIFIER_DETECTORS,
): Promise<Classification> {
  const evidence: Evidence[] = [];
  for (const detector of detectors) {
    try {
      const produced = await detector.detect(candidate, context);
      evidence.push(...produced);
    } catch {
      // A broken detector must never break filtering (fail open).
    }
  }
  return aggregateEvidence(evidence, candidate, context, Date.now());
}
