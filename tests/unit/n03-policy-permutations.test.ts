import { describe, expect, it } from 'vitest';
import { decide, MODE_THRESHOLDS } from '@/policy/decide';
import { defaultSettings, type UserSettings } from '@/domain/settings';
import { defaultRules, applyRuleMutation } from '@/domain/rules';
import type { Classification } from '@/domain/classification';

type ConfidenceLevel = Classification['confidence'];

/**
 * N03 policy independence — table-driven permutations.
 *
 * Precedence (documented + enforced):
 *   disabled < show-once/session < video allow < video block < channel rules
 *   < literal phrases < dimensional corrections < category policy x mode
 *
 * Invariants under test:
 * - an allow on ONE category never erases independent matched categories;
 * - a warn on one category cannot cap an independent forced hide from another
 *   category that meets its own evidence floor;
 * - a forced category hide requires THAT category's own score to meet the
 *   mode's warning floor (global confidence alone is not enough);
 * - corrections are dimensional (Not-AI leaves slop evidence intact);
 * - missing metadata (no videoId/channelId) degrades gracefully.
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

const CONFIDENCES: readonly ConfidenceLevel[] = ['low', 'medium', 'high', 'very-high'];

/** Table 1: two independent categories with independent user actions. */
describe.each([
  ['ai-visual', 'content-farm'],
  ['ai-music', 'repetitive'],
  ['ai-visual', 'repetitive'],
] as const)('independent category actions: %s vs %s', (catA, catB) => {
  it('allow on one category does not erase the other matched category', () => {
    const s = settings();
    s.categoryActions[catA] = 'allow';
    s.categoryActions[catB] = 'hide';
    const c = classification({
      aiLikelihood: 0.8,
      slopLikelihood: 0.8,
      confidence: 'high',
      categories: { [catA]: 0.8, [catB]: 0.8 } as Record<string, number>,
    });
    const decision = decide({
      settings: s,
      rules: defaultRules(),
      candidate: { videoId: 'v1' },
      classification: c,
    });
    expect(decision.action).toBe('hide');
  });

  it('warn on one category does not cap an independent forced hide with real evidence', () => {
    const s = settings();
    s.categoryActions[catA] = 'warn';
    s.categoryActions[catB] = 'hide';
    const c = classification({
      aiLikelihood: 0.8,
      slopLikelihood: 0.8,
      confidence: 'high',
      categories: { [catA]: 0.8, [catB]: 0.8 } as Record<string, number>,
    });
    const decision = decide({
      settings: s,
      rules: defaultRules(),
      candidate: { videoId: 'v1' },
      classification: c,
    });
    expect(decision.action).toBe('hide');
  });
});

/** Table 2: forced-hide floor across confidences and category scores. */
describe('forced category hide requires its own evidence floor', () => {
  const CASES: Array<{
    score: number;
    confidence: ConfidenceLevel;
    hides: boolean;
    expected: string;
  }> = [
    { score: 0.8, confidence: 'medium', hides: true, expected: 'hide' }, // strong category evidence
    // exactly at the forced-hide floor (0.7 × balanced hideAt 0.7 = 0.49):
    { score: 0.49, confidence: 'medium', hides: true, expected: 'hide' },
    { score: 0.1, confidence: 'very-high', hides: false, expected: 'allow' },
    { score: 0.0, confidence: 'high', hides: false, expected: 'allow' },
  ];
  it.each(CASES)(
    'score $score / confidence $confidence → $expected',
    ({ score, confidence, expected }) => {
      const s = settings({ mode: 'balanced' });
      s.categoryActions['content-farm'] = 'hide';
      // Global scores are deliberately LOW so the ONLY route to hide is the
      // forced category backed by its own evidence score.
      const c = classification({
        aiLikelihood: 0.3,
        slopLikelihood: 0.1,
        confidence,
        categories: { 'content-farm': score } as Record<string, number>,
      });
      const decision = decide({
        settings: s,
        rules: defaultRules(),
        candidate: { videoId: 'v1' },
        classification: c,
      });
      expect(decision.action).toBe(expected);
    },
  );
});

/** Table 3: dimensional corrections across confidences. */
describe('corrections stay dimensional', () => {
  // Expected outcome for the surviving dimension (0.8): high/very-high →
  // hide; medium/low → warn (a strong surviving category keeps a floor of
  // warn — the correction never whitewashes it to allow).
  const EXPECTED_NOT_AI: Record<ConfidenceLevel, string> = {
    low: 'allow', // surviving slop 0.8 < warnBelow 0.85, confidence low
    medium: 'warn',
    high: 'hide',
    'very-high': 'hide',
  };
  const EXPECTED_NOT_SLOP: Record<ConfidenceLevel, string> = {
    low: 'warn', // surviving AI 0.9 >= warnBelow 0.85
    medium: 'warn',
    high: 'hide',
    'very-high': 'hide',
  };
  it.each(CONFIDENCES)(
    'Not-AI at confidence %s keeps independent slop evidence active',
    (confidence) => {
      const s = settings({ mode: 'balanced' });
      const c = classification({
        aiLikelihood: 0.9,
        slopLikelihood: 0.8,
        confidence,
        categories: { 'ai-visual': 0.9, repetitive: 0.8 } as Record<string, number>,
      });
      const decision = decide({
        settings: s,
        rules: defaultRules(),
        candidate: { videoId: 'v1' },
        classification: c,
        correctedNotAi: true,
      });
      expect(decision.action).toBe(EXPECTED_NOT_AI[confidence]);
      expect(decision.explanation.some((line) => line.includes('false positive'))).toBe(true);
    },
  );

  it.each(CONFIDENCES)(
    'Not-slop at confidence %s keeps independent AI evidence active',
    (confidence) => {
      const s = settings({ mode: 'balanced' });
      const c = classification({
        aiLikelihood: 0.9,
        slopLikelihood: 0.8,
        confidence,
        categories: { 'ai-visual': 0.9, repetitive: 0.8 } as Record<string, number>,
      });
      const decision = decide({
        settings: s,
        rules: defaultRules(),
        candidate: { videoId: 'v1' },
        classification: c,
        correctedNotSlop: true,
      });
      expect(decision.action).toBe(EXPECTED_NOT_SLOP[confidence]);
    },
  );
});

/** Table 4: user rules dominate corrections, and metadata absence degrades safely. */
describe('rules beat corrections; missing metadata fails open', () => {
  it('an explicit video block hides even when the user also marked it Not AI', () => {
    const rules = applyRuleMutation(defaultRules(), { kind: 'block-video', videoId: 'v1' });
    const decision = decide({
      settings: settings(),
      rules,
      candidate: { videoId: 'v1' },
      classification: classification(),
      correctedNotAi: true,
    });
    expect(decision.action).toBe('hide');
    expect(decision.reason).toBe('user-rule');
  });

  it.each(CONFIDENCES)(
    'no videoId and no channelId (confidence %s) still reaches a decision',
    (confidence) => {
      const rules = applyRuleMutation(defaultRules(), { kind: 'block-channel', channelId: 'UCX' });
      const decision = decide({
        settings: settings(),
        rules,
        candidate: {},
        classification: classification({ confidence, aiLikelihood: 0.8 }),
      });
      expect(['allow', 'warn', 'hide']).toContain(decision.action);
      expect(decision.reason).toBe('automatic');
    },
  );
});

/** Table 5: mode thresholds are internally consistent. */
describe('mode threshold consistency', () => {
  it.each(Object.entries(MODE_THRESHOLDS))(
    '%s: hideAt <= warnBelow and floors align',
    (_mode, t) => {
      expect(t.hideAt).toBeLessThanOrEqual(t.warnBelow);
      expect(t.hideConfidence.length).toBeGreaterThan(0);
      expect(t.warnConfidence.length).toBeGreaterThanOrEqual(t.hideConfidence.length);
    },
  );
});
