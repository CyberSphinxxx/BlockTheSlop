import { describe, expect, it } from 'vitest';
import { decide } from '@/policy/decide';
import { defaultSettings, type UserSettings } from '@/domain/settings';
import { defaultRules } from '@/domain/rules';
import type { Classification } from '@/domain/classification';
import type { FilterMode } from '@/domain/settings';

/**
 * N03 blocker-6 — exact precedence semantics under mixed category actions:
 *
 * 1. A category set to WARN caps only ITS OWN category's evidence. It must
 *    never cap an independent hide driven by another (uncapped) category or
 *    dimension that meets the mode's hide bar.
 * 2. A user-forced category hide requires THAT category's own evidence to
 *    meet the mode-scaled floor; unrelated high confidence alone never hides.
 * 3. Thumbnail-only evidence never hides the VIDEO (a thumbnail result is not
 *    a video result) — but it can warn.
 * 4. A truly unknown video stays visible in every mode regardless of a
 *    synthetic-looking thumbnail or an AI-mentioning search query: search-box
 *    text and thumbnail looks are never video evidence.
 * 5. Every warn decision explains WHY it warned instead of hid.
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

describe('N03b: warn caps only its own category', () => {
  it('warn on an AI category does not cap an independent slop hide (strict)', () => {
    const s = settings({ mode: 'strict' });
    s.categoryActions['ai-visual'] = 'warn';
    const c = classification({
      aiLikelihood: 0.2,
      slopLikelihood: 0.9,
      categories: { 'ai-visual': 0.9, 'content-farm': 0.9 },
      confidence: 'high',
    });
    const decision = decide({
      settings: s,
      rules: defaultRules(),
      candidate: { videoId: 'v1' },
      classification: c,
    });
    expect(decision.action).toBe('hide');
  });

  it('warn on an AI category does not cap a mode-threshold hide from other evidence', () => {
    const s = settings({ mode: 'strict' });
    s.categoryActions['ai-visual'] = 'warn';
    const c = classification({
      aiLikelihood: 0.8,
      slopLikelihood: 0.85,
      categories: { 'ai-visual': 0.8, repetitive: 0.85 },
      confidence: 'high',
    });
    const decision = decide({
      settings: s,
      rules: defaultRules(),
      candidate: { videoId: 'v1' },
      classification: c,
    });
    expect(decision.action).toBe('hide');
  });

  it('warn still warns when no independent hide evidence exists (cap honored)', () => {
    const s = settings({ mode: 'balanced' });
    s.categoryActions['ai-visual'] = 'warn';
    const c = classification({
      aiLikelihood: 0.8,
      slopLikelihood: 0.1,
      categories: { 'ai-visual': 0.8 },
      confidence: 'high',
    });
    const decision = decide({
      settings: s,
      rules: defaultRules(),
      candidate: { videoId: 'v1' },
      classification: c,
    });
    expect(decision.action).toBe('warn');
  });
});

describe('N03b: forced category hide requires its own evidence', () => {
  it('very-high confidence from an unrelated dimension cannot hide a weak forced category', () => {
    const s = settings({ mode: 'balanced' });
    s.categoryActions['content-farm'] = 'hide';
    const c = classification({
      aiLikelihood: 0.95,
      slopLikelihood: 0.05,
      categories: { 'content-farm': 0.05 },
      confidence: 'very-high',
    });
    const decision = decide({
      settings: s,
      rules: defaultRules(),
      candidate: { videoId: 'v1' },
      classification: c,
    });
    expect(decision.action).not.toBe('hide');
  });

  it('a forced hide with real own evidence (0.8) hides at high confidence', () => {
    const s = settings({ mode: 'balanced' });
    s.categoryActions['content-farm'] = 'hide';
    const c = classification({
      aiLikelihood: 0.3,
      slopLikelihood: 0.1,
      categories: { 'content-farm': 0.8 },
      confidence: 'high',
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

describe('N03b: thumbnail-only evidence never hides the video', () => {
  const CASES: readonly FilterMode[] = ['safe', 'balanced', 'strict'];
  it.each(CASES)('in %s mode', (mode) => {
    const s = settings({ mode });
    s.categoryActions['ai-thumbnail'] = 'inherit';
    const c = classification({
      aiLikelihood: 0.8,
      confidence: 'high',
      categories: { 'ai-thumbnail': 0.8 },
    });
    const decision = decide({
      settings: s,
      rules: defaultRules(),
      candidate: { videoId: 'v1' },
      classification: c,
    });
    expect(decision.action).not.toBe('hide');
  });

  it('thumbnail-only evidence can still warn (a warning explains itself)', () => {
    const s = settings({ mode: 'balanced' });
    const c = classification({
      aiLikelihood: 0.8,
      confidence: 'high',
      categories: { 'ai-thumbnail': 0.8 },
    });
    const decision = decide({
      settings: s,
      rules: defaultRules(),
      candidate: { videoId: 'v1' },
      classification: c,
    });
    // Default ai-thumbnail action is warn.
    expect(decision.action).toBe('warn');
    expect(decision.explanation.length).toBeGreaterThan(0);
  });
});

describe('N03b: unknown videos stay visible in every mode', () => {
  it.each(['safe', 'balanced', 'strict'] as const)(
    'no classification at all → allow in %s',
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

  it('an AI-mentioning title alone (ai-discussion context) does not hide', () => {
    // 'Best AI video generator review' — discussion about AI, not generated
    // content. The detection engine classifies it with discussion evidence;
    // policy must never hide on discussion/title-mention evidence alone.
    const s = settings({ mode: 'strict' });
    const c = classification({
      aiLikelihood: 0.2,
      slopLikelihood: 0.1,
      categories: { 'ai-discussion': 0.6 },
      confidence: 'medium',
    });
    const decision = decide({
      settings: s,
      rules: defaultRules(),
      candidate: { videoId: 'v1', title: 'Best AI video generator review' },
      classification: c,
    });
    expect(decision.action).not.toBe('hide');
  });
});
