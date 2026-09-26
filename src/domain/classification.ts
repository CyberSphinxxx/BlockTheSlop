import type { Evidence, EvidenceCategory } from './evidence';

/**
 * Classification output of the detection engine.
 * AI and slop likelihoods are deliberately separate dimensions.
 */
export interface Classification {
  /** 0..1 estimated probability the content is AI-generated/materially synthetic. */
  aiLikelihood: number;
  /** 0..1 estimated probability the content matches the user's slop concept. */
  slopLikelihood: number;

  /** Per-category aggregated likelihood 0..1 (opposing evidence reduces it). */
  categories: Partial<Record<EvidenceCategory, number>>;

  confidence: 'low' | 'medium' | 'high' | 'very-high';
  evidence: Evidence[];

  classifierVersion: string;
  rulesVersion: string;
  evaluatedAt: number;
}

/**
 * N08 audit: the cache-relevant projection of a classification. The evidence
 * array is DIAGNOSTIC (re-derived per candidate, never consumed from cache —
 * decisions come from `categories`, the Why overlay from `decision
 * .explanation`), unbounded in count, and would let a single rich batch
 * exceed the 512KB message cap and silently disable cache writes. The
 * whitelist also drops any junk fields a compromised content side added.
 */
export function classificationForCache(c: Classification): Classification {
  return {
    aiLikelihood: c.aiLikelihood,
    slopLikelihood: c.slopLikelihood,
    // Shallow copy: never alias the live classification's category map.
    categories: { ...c.categories },
    confidence: c.confidence,
    evidence: [],
    classifierVersion: c.classifierVersion,
    rulesVersion: c.rulesVersion,
    evaluatedAt: c.evaluatedAt,
  };
}
