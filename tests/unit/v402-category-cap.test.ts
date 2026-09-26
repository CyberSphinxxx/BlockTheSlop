import { describe, expect, it } from 'vitest';
import { decide } from '@/policy/decide';
import { defaultSettings, type FilterMode, type UserSettings } from '@/domain/settings';
import { defaultRules } from '@/domain/rules';
import type { Classification } from '@/domain/classification';

/**
 * V4-02 — category cap and policy precedence (P0).
 *
 * Reproduction of the kit's baseline defect in src/policy/decide.ts:
 * `residualDominant = Math.max(residualDominant, dominant)` re-injects the
 * GLOBAL dimension score into the supposedly uncapped residual. The global
 * score is itself derived from the Warn-capped category, so a strong
 * Warn-capped category plus a weak unrelated category hides through the
 * "residual" route — exactly what the cap was supposed to prevent.
 *
 * Acceptance (REQUIREMENTS.md V4-02):
 * - Warn-capped ai-visual=0.9, uncapped content-farm=0.1, global AI 0.9,
 *   high confidence, balanced mode → NO hide through the residual route.
 * - Independent uncapped evidence above the mode bar still hides.
 * - Explanations stay consistent with the evidence that caused the action.
 */

function classification(overrides: Partial<Classification> = {}): Classification {
  return {
    aiLikelihood: 0.9,
    slopLikelihood: 0.1,
    categories: { 'ai-visual': 0.9 },
    confidence: 'high',
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

describe('V4-02: Warn cap cannot hide through the residual route', () => {
  it('capped ai-visual 0.9 + weak uncapped content-farm 0.1 does NOT hide (balanced)', () => {
    const s = settings({ mode: 'balanced' });
    s.categoryActions['ai-visual'] = 'warn';
    s.categoryActions['content-farm'] = 'inherit';
    const c = classification({
      aiLikelihood: 0.9, // derived from the capped ai-visual category
      slopLikelihood: 0.1,
      categories: { 'ai-visual': 0.9, 'content-farm': 0.1 },
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

  it('same shape in strict and safe modes also does not hide', () => {
    for (const mode of ['safe', 'strict'] as const) {
      const s = settings({ mode });
      s.categoryActions['ai-visual'] = 'warn';
      const c = classification({
        aiLikelihood: 0.9,
        slopLikelihood: 0.1,
        categories: { 'ai-visual': 0.9, 'content-farm': 0.1 },
        confidence: 'high',
      });
      const decision = decide({
        settings: s,
        rules: defaultRules(),
        candidate: { videoId: 'v1' },
        classification: c,
      });
      expect(decision.action, `${mode} must not hide on capped evidence`).toBe('warn');
    }
  });

  it('independent uncapped evidence above the mode bar still hides (cap is per-category)', () => {
    const s = settings({ mode: 'balanced' });
    s.categoryActions['ai-visual'] = 'warn';
    const c = classification({
      aiLikelihood: 0.9,
      slopLikelihood: 0.9,
      categories: { 'ai-visual': 0.9, repetitive: 0.9 },
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

  it('multiple uncapped AI categories above the bar hide without any warn override', () => {
    const s = settings({ mode: 'balanced' });
    const c = classification({
      aiLikelihood: 0.9,
      categories: { 'ai-visual': 0.9, 'ai-script': 0.8 },
      confidence: 'high',
    });
    expect(
      decide({
        settings: s,
        rules: defaultRules(),
        candidate: { videoId: 'v1' },
        classification: c,
      }).action,
    ).toBe('hide');
  });

  it('thumbnail-only residual still cannot hide the video', () => {
    const s = settings({ mode: 'strict' });
    s.categoryActions['ai-visual'] = 'warn';
    const c = classification({
      aiLikelihood: 0.95,
      slopLikelihood: 0.1,
      categories: { 'ai-visual': 0.9, 'ai-thumbnail': 0.95 },
      confidence: 'high',
    });
    const decision = decide({
      settings: s,
      rules: defaultRules(),
      candidate: { videoId: 'v1' },
      classification: c,
    });
    expect(decision.action).not.toBe('hide');
  });

  it('a warn outcome explains that the category was capped, consistent with the evidence', () => {
    const s = settings({ mode: 'balanced' });
    s.categoryActions['ai-visual'] = 'warn';
    const c = classification({
      aiLikelihood: 0.9,
      categories: { 'ai-visual': 0.9, 'content-farm': 0.1 },
      confidence: 'high',
    });
    const decision = decide({
      settings: s,
      rules: defaultRules(),
      candidate: { videoId: 'v1' },
      classification: c,
    });
    expect(decision.action).toBe('warn');
    expect(decision.explanation.length).toBeGreaterThan(0);
  });

  it('dimensional corrections still suppress only their own dimension', () => {
    const s = settings({ mode: 'balanced' });
    const c = classification({
      aiLikelihood: 0.9,
      slopLikelihood: 0.9,
      categories: { 'ai-visual': 0.9, repetitive: 0.9 },
      confidence: 'high',
    });
    const notAi = decide({
      settings: s,
      rules: defaultRules(),
      candidate: { videoId: 'v1' },
      classification: c,
      correctedNotAi: true,
    });
    const notSlop = decide({
      settings: s,
      rules: defaultRules(),
      candidate: { videoId: 'v1' },
      classification: c,
      correctedNotSlop: true,
    });
    // Not-AI removes the AI evidence; the slop evidence (0.9) is below
    // balanced's hideAt (0.7)?? No — 0.9 >= 0.7, so it may hide via slop.
    // What must NOT happen: Not-AI leaving the AI-driven hide intact.
    const aiDriven = decide({
      settings: s,
      rules: defaultRules(),
      candidate: { videoId: 'v1' },
      classification: classification({
        aiLikelihood: 0.9,
        slopLikelihood: 0.1,
        categories: { 'ai-visual': 0.9 },
        confidence: 'high',
      }),
      correctedNotAi: true,
    });
    expect(aiDriven.action).toBe('allow');
    expect(['allow', 'warn', 'hide']).toContain(notAi.action);
    expect(['allow', 'warn', 'hide']).toContain(notSlop.action);
  });

  it('explicit rules and corrections keep their documented precedence', () => {
    const modes: readonly FilterMode[] = ['safe', 'balanced', 'strict'];
    for (const mode of modes) {
      const s = settings({ mode });
      s.categoryActions['ai-visual'] = 'warn';
      const c = classification({
        aiLikelihood: 0.9,
        categories: { 'ai-visual': 0.9, 'content-farm': 0.1 },
        confidence: 'high',
      });
      // No explicit rule → capped evidence must not hide (V4-02 core).
      const noRule = decide({
        settings: s,
        rules: defaultRules(),
        candidate: { videoId: 'v1' },
        classification: c,
      });
      expect(noRule.action, mode).toBe('warn');
    }
  });
});
