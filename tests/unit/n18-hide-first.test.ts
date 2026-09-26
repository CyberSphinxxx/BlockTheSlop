import { describe, expect, it } from 'vitest';
import { decide } from '@/policy/decide';
import { defaultSettings, type UserSettings } from '@/domain/settings';
import { defaultRules } from '@/domain/rules';
import type { Classification } from '@/domain/classification';

/**
 * N18 hide-first strict experience and recovery model.
 *
 * Invariants:
 * - Strict is MORE aggressive over SUPPORTED evidence (lower thresholds on
 *   observed signals), never on absence of metadata;
 * - a truly unknown video (no classification, no rules) stays visible in
 *   every mode;
 * - recovery affordances are scope-explicit (Reveal once = temporary,
 *   Always allow = persistent, Why hidden? = evidence);
 * - the strict false-positive tradeoff is measurable: strict hides strictly
 *   more of a labeled corpus than balanced, and every hide route keeps
 *   recovery (decision carries an explanation).
 */

function classification(overrides: Partial<Classification> = {}): Classification {
  return {
    aiLikelihood: 0.9,
    slopLikelihood: 0.1,
    categories: { 'ai-visual': 0.9 },
    confidence: 'very-high',
    evidence: [],
    classifierVersion: '1',
    rulesVersion: '1',
    evaluatedAt: 0,
    ...overrides,
  };
}

function settings(overrides: Partial<UserSettings> = {}): UserSettings {
  return { ...defaultSettings(), ...overrides };
}

describe('N18: strict is aggressive only over supported evidence', () => {
  const CORPUS: Array<{
    name: string;
    aiLikelihood: number;
    confidence: Classification['confidence'];
    categoryScore: number;
  }> = [
    {
      name: 'yt-label very-high',
      aiLikelihood: 0.95,
      confidence: 'very-high',
      categoryScore: 0.95,
    },
    { name: 'disclosure high', aiLikelihood: 0.75, confidence: 'high', categoryScore: 0.75 },
    { name: 'text-signal moderate', aiLikelihood: 0.55, confidence: 'medium', categoryScore: 0.55 },
    { name: 'weak-context low', aiLikelihood: 0.25, confidence: 'low', categoryScore: 0.25 },
  ];

  it('strict hides strictly more of the labeled corpus than balanced', () => {
    let balancedHides = 0;
    let strictHides = 0;
    for (const c of CORPUS) {
      const cl = classification({
        aiLikelihood: c.aiLikelihood,
        confidence: c.confidence,
        categories: { 'ai-visual': c.categoryScore },
      });
      const balanced = decide({
        settings: settings({ mode: 'balanced' }),
        rules: defaultRules(),
        candidate: { videoId: 'v1' },
        classification: cl,
      });
      const strict = decide({
        settings: settings({ mode: 'strict' }),
        rules: defaultRules(),
        candidate: { videoId: 'v1' },
        classification: cl,
      });
      balancedHides += balanced.action === 'hide' ? 1 : 0;
      strictHides += strict.action === 'hide' ? 1 : 0;
    }
    expect(strictHides).toBeGreaterThan(balancedHides);
    expect(strictHides).toBe(3); // 0.95/0.75/0.55 clear strict's 0.45 floor
    expect(balancedHides).toBe(2); // 0.95, 0.75 hide; 0.55 medium warns; 0.25 allows
  });

  it('a weak-context video is never hidden in strict (fails open below the warn floor)', () => {
    const cl = classification({
      aiLikelihood: 0.25,
      confidence: 'low',
      categories: { 'ai-visual': 0.25 },
    });
    const decision = decide({
      settings: settings({ mode: 'strict' }),
      rules: defaultRules(),
      candidate: { videoId: 'v1' },
      classification: cl,
    });
    // 0.25 sits below strict's warn score floor (0.7 * 0.6 = 0.42): the
    // honest outcome is allow, never hide.
    expect(decision.action).toBe('allow');
  });

  it.each(['safe', 'balanced', 'strict'] as const)(
    'a truly unknown video stays visible in %s (absence is not evidence)',
    (mode) => {
      const decision = decide({
        settings: settings({ mode }),
        rules: defaultRules(),
        candidate: { videoId: 'v1' },
        classification: undefined,
      });
      expect(decision.action).toBe('allow');
    },
  );

  it.each(['safe', 'balanced', 'strict'] as const)(
    'thumbnail-only evidence cannot hide the VIDEO in %s (a thumbnail result is not a video result)',
    (mode) => {
      // The ONLY signal is a thumbnail-scoped creator disclosure; the video
      // itself carries no implicated evidence. Even with high global
      // confidence, policy must not hide the video on this alone.
      const cl = classification({
        aiLikelihood: 0.8,
        confidence: 'high',
        categories: { 'ai-thumbnail': 0.8 },
      });
      const decision = decide({
        settings: settings({ mode }),
        rules: defaultRules(),
        candidate: { videoId: 'v1' },
        classification: cl,
      });
      expect(decision.action).not.toBe('hide');
    },
  );
});

describe('N18: recovery affordances keep every hide explainable', () => {
  it('every hide decision carries a non-empty explanation for Why hidden?', () => {
    for (const mode of ['safe', 'balanced', 'strict'] as const) {
      const decision = decide({
        settings: settings({ mode }),
        rules: defaultRules(),
        candidate: { videoId: 'v1' },
        classification: classification(),
      });
      if (decision.action === 'hide') {
        expect(decision.explanation.length).toBeGreaterThan(0);
      }
    }
  });
});
