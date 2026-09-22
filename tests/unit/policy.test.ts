import { describe, expect, it } from 'vitest';
import { decide, MODE_THRESHOLDS, DECISION_PRECEDENCE_DOC } from '@/policy/decide';
import { defaultSettings, type UserSettings } from '@/domain/settings';
import { defaultRules, applyRuleMutation } from '@/domain/rules';
import type { Classification } from '@/domain/classification';

function classification(overrides: Partial<Classification> = {}): Classification {
  return {
    aiLikelihood: 0.9,
    slopLikelihood: 0.1,
    categories: { 'ai-visual': 0.9 },
    confidence: 'very-high',
    evidence: [
      {
        id: 'e1',
        origin: 'first-party',
        category: 'ai-visual',
        detector: 'official-disclosure',
        strength: 0.9,
        polarity: 'supports',
        reasonCode: 'yt-label',
        reasonText: 'YouTube labels this video as altered or synthetic.',
      },
    ],
    classifierVersion: '1',
    rulesVersion: '1',
    evaluatedAt: Date.now(),
    ...overrides,
  };
}

function settings(overrides: Partial<UserSettings> = {}): UserSettings {
  return { ...defaultSettings(), ...overrides };
}

const baseCandidate = { videoId: 'v1', channelId: 'UC1' };

describe('precedence', () => {
  it('disabled always allows, even for blocked channels and strong classification', () => {
    const rules = applyRuleMutation(defaultRules(), { kind: 'block-channel', channelId: 'UC1' });
    const decision = decide({
      settings: settings({ enabled: false }),
      rules,
      candidate: baseCandidate,
      classification: classification(),
    });
    expect(decision.action).toBe('allow');
    expect(decision.reason).toBe('disabled');
  });

  it('exact video allow beats automatic hide and channel block', () => {
    let r = applyRuleMutation(defaultRules(), { kind: 'block-channel', channelId: 'UC1' });
    r = applyRuleMutation(r, { kind: 'allow-video', videoId: 'v1' });
    const decision = decide({
      settings: settings(),
      rules: r,
      candidate: baseCandidate,
      classification: classification(),
    });
    expect(decision.action).toBe('allow');
    expect(decision.reason).toBe('user-rule');
  });

  it('exact video block hides and overrides channel allow', () => {
    let r = applyRuleMutation(defaultRules(), { kind: 'allow-channel', channelId: 'UC1' });
    r = applyRuleMutation(r, { kind: 'block-video', videoId: 'v1' });
    const decision = decide({
      settings: settings(),
      rules: r,
      candidate: baseCandidate,
      classification: classification(),
    });
    expect(decision.action).toBe('hide');
    expect(decision.reason).toBe('user-rule');
  });

  it('allowed channel prevents automatic hide', () => {
    const r = applyRuleMutation(defaultRules(), { kind: 'allow-channel', channelId: 'UC1' });
    const decision = decide({
      settings: settings(),
      rules: r,
      candidate: baseCandidate,
      classification: classification(),
    });
    expect(decision.action).toBe('allow');
    expect(decision.reason).toBe('channel-rule');
  });

  it('blocked channel hides even with weak classification', () => {
    const r = applyRuleMutation(defaultRules(), { kind: 'block-channel', channelId: 'UC1' });
    const decision = decide({
      settings: settings(),
      rules: r,
      candidate: baseCandidate,
      classification: classification({ aiLikelihood: 0.1, confidence: 'low' }),
    });
    expect(decision.action).toBe('hide');
    expect(decision.reason).toBe('channel-rule');
  });

  it('blocked channel matches by handle fallback', () => {
    const r = applyRuleMutation(defaultRules(), {
      kind: 'block-channel-by-handle',
      handle: 'sloplord',
    });
    const decision = decide({
      settings: settings(),
      rules: r,
      candidate: { handle: '@SlopLord' },
      classification: classification({ aiLikelihood: 0.1, confidence: 'low' }),
    });
    expect(decision.action).toBe('hide');
    expect(decision.reason).toBe('channel-rule');
  });

  it('personal correction (Not AI) allows despite high automatic score', () => {
    const decision = decide({
      settings: settings(),
      rules: defaultRules(),
      candidate: baseCandidate,
      classification: classification(),
      correctedNotAi: true,
    });
    expect(decision.action).toBe('allow');
    expect(decision.reason).toBe('correction');
  });

  it('documented precedence is present', () => {
    expect(DECISION_PRECEDENCE_DOC).toContain('video block');
  });
});

describe('modes and thresholds', () => {
  it('safe mode hides only very-high confidence', () => {
    const s = settings({ mode: 'safe' });
    const hide = decide({
      settings: s,
      rules: defaultRules(),
      candidate: baseCandidate,
      classification: classification({ confidence: 'very-high', aiLikelihood: 0.95 }),
    });
    const warn = decide({
      settings: s,
      rules: defaultRules(),
      candidate: baseCandidate,
      classification: classification({ confidence: 'high', aiLikelihood: 0.75 }),
    });
    const allow = decide({
      settings: s,
      rules: defaultRules(),
      candidate: baseCandidate,
      classification: classification({ confidence: 'medium', aiLikelihood: 0.5 }),
    });
    expect(hide.action).toBe('hide');
    expect(warn.action).toBe('warn');
    expect(allow.action).toBe('allow');
  });

  it('balanced mode hides high confidence, warns medium', () => {
    const s = settings({ mode: 'balanced' });
    const hide = decide({
      settings: s,
      rules: defaultRules(),
      candidate: baseCandidate,
      classification: classification({ confidence: 'high', aiLikelihood: 0.75 }),
    });
    const warn = decide({
      settings: s,
      rules: defaultRules(),
      candidate: baseCandidate,
      classification: classification({ confidence: 'medium', aiLikelihood: 0.5 }),
    });
    const allow = decide({
      settings: s,
      rules: defaultRules(),
      candidate: baseCandidate,
      classification: classification({ confidence: 'low', aiLikelihood: 0.2 }),
    });
    expect(hide.action).toBe('hide');
    expect(warn.action).toBe('warn');
    expect(allow.action).toBe('allow');
  });

  it('strict mode hides moderate confidence and warns low', () => {
    const s = settings({ mode: 'strict' });
    const hide = decide({
      settings: s,
      rules: defaultRules(),
      candidate: baseCandidate,
      classification: classification({ confidence: 'medium', aiLikelihood: 0.5 }),
    });
    const warn = decide({
      settings: s,
      rules: defaultRules(),
      candidate: baseCandidate,
      classification: classification({ confidence: 'low', aiLikelihood: 0.3 }),
    });
    expect(hide.action).toBe('hide');
    expect(warn.action).toBe('warn');
  });

  it('threshold boundaries behave exactly at cutoffs', () => {
    const balanced = MODE_THRESHOLDS.balanced;
    expect(balanced.hideAt).toBe(0.7);
    // exactly at hide threshold with eligible confidence → hide
    const at = decide({
      settings: settings({ mode: 'balanced' }),
      rules: defaultRules(),
      candidate: baseCandidate,
      classification: classification({ aiLikelihood: 0.7, confidence: 'high' }),
    });
    expect(at.action).toBe('hide');
    // just below → warn
    const below = decide({
      settings: settings({ mode: 'balanced' }),
      rules: defaultRules(),
      candidate: baseCandidate,
      classification: classification({ aiLikelihood: 0.69, confidence: 'medium' }),
    });
    expect(below.action).toBe('warn');
  });

  it('"AI" in title alone (weak evidence) cannot hide in Safe mode', () => {
    const s = settings({ mode: 'safe' });
    const weak = classification({
      aiLikelihood: 0.45,
      confidence: 'medium',
      evidence: [
        {
          id: 'weak',
          origin: 'local-rule',
          category: 'ai-visual',
          detector: 'text-rules',
          strength: 0.4,
          polarity: 'supports',
          reasonCode: 'weak',
          reasonText: 'weak',
        },
      ],
    });
    const decision = decide({
      settings: s,
      rules: defaultRules(),
      candidate: baseCandidate,
      classification: weak,
    });
    expect(decision.action).not.toBe('hide');
  });

  it('settings change updates decision without stale cached decision', () => {
    const c = classification({ confidence: 'high', aiLikelihood: 0.75 });
    const balanced = decide({
      settings: settings({ mode: 'balanced' }),
      rules: defaultRules(),
      candidate: baseCandidate,
      classification: c,
    });
    const safe = decide({
      settings: settings({ mode: 'safe' }),
      rules: defaultRules(),
      candidate: baseCandidate,
      classification: c,
    });
    expect(balanced.action).toBe('hide');
    expect(safe.action).toBe('warn');
  });
});

describe('category actions', () => {
  it('per-category allow downgrades automatic hide', () => {
    const s = settings();
    s.categoryActions['ai-visual'] = 'allow';
    const decision = decide({
      settings: s,
      rules: defaultRules(),
      candidate: baseCandidate,
      classification: classification({ categories: { 'ai-visual': 0.9 } }),
    });
    expect(decision.action).toBe('allow');
  });

  it('per-category warn caps a hide', () => {
    const s = settings();
    s.categoryActions['ai-visual'] = 'warn';
    const decision = decide({
      settings: s,
      rules: defaultRules(),
      candidate: baseCandidate,
      classification: classification(),
    });
    expect(decision.action).toBe('warn');
  });

  it('per-category hide forces hide at medium confidence or better', () => {
    const s = settings({ mode: 'safe' });
    s.categoryActions['ai-music'] = 'hide';
    const decision = decide({
      settings: s,
      rules: defaultRules(),
      candidate: baseCandidate,
      classification: classification({
        aiLikelihood: 0.5,
        confidence: 'medium',
        categories: { 'ai-music': 0.6 },
      }),
    });
    expect(decision.action).toBe('hide');
  });
});
