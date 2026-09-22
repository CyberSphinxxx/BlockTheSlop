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
