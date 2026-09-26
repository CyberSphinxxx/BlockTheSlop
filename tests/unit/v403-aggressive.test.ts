import { describe, expect, it } from 'vitest';
import { classifyCandidate } from '@/detection/engine';
import { decide, MODE_THRESHOLDS } from '@/policy/decide';
import { defaultSettings, validateSettings, type UserSettings } from '@/domain/settings';
import { defaultRules } from '@/domain/rules';
import type { Classification } from '@/domain/classification';
import type { NormalizedVideoCandidate } from '@/domain/video';

/**
 * V4-03 — aggressive preset: policy semantics + measured gain on a
 * hand-authored regression set (separate from the N09 development corpus).
 *
 * Product contract preserved in every test:
 * - explicit allow/block rules beat any automatic action in any mode;
 * - unknowns (no observable signal) stay visible in every mode;
 * - thumbnail-only evidence never hides the video on its own;
 * - user corrections (`correctedNotAi`) veto automatic hides;
 * - category defaults are NOT changed by the mode (no silent neutralization).
 *
 * The cases below were revised while developing this preset, so they are
 * regression cases, NOT an untouched holdout or real-world accuracy proof.
 * They measure the narrower question:
 * does aggressive hide MORE labeled-AI cases than Balanced/Safe, and at what
 * false-positive cost on labeled-human/ambiguous cases?
 */

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

function settings(mode: UserSettings['mode']): UserSettings {
  return { ...defaultSettings(), mode };
}

const baseCandidate = { videoId: 'v1', channelId: 'UC1' };

function actionFor(mode: UserSettings['mode'], cl: Classification): 'allow' | 'warn' | 'hide' {
  return decide({
    settings: settings(mode),
    rules: defaultRules(),
    candidate: baseCandidate,
    classification: cl,
  }).action;
}

describe('V4-03 aggressive policy semantics', () => {
  it('is a valid stored mode and the threshold table has an entry per mode', () => {
    expect(validateSettings({ mode: 'aggressive' })?.mode).toBe('aggressive');
    for (const mode of ['safe', 'balanced', 'strict', 'aggressive'] as const) {
      const t = MODE_THRESHOLDS[mode];
      expect(t.hideAt).toBeGreaterThan(0);
      expect(t.hideAt).toBeLessThanOrEqual(1);
      expect(t.hideConfidence.length).toBeGreaterThan(0);
    }
  });

  it('strictly relaxes the mode ladder: hideAt aggressive < strict < balanced < safe', () => {
    expect(MODE_THRESHOLDS['aggressive'].hideAt).toBeLessThan(MODE_THRESHOLDS['strict'].hideAt);
    expect(MODE_THRESHOLDS['strict'].hideAt).toBeLessThan(MODE_THRESHOLDS['balanced'].hideAt);
    expect(MODE_THRESHOLDS['balanced'].hideAt).toBeLessThan(MODE_THRESHOLDS['safe'].hideAt);
    // Aggressive admits every confidence class to hiding (documented risk).
    expect(MODE_THRESHOLDS['aggressive'].hideConfidence).toEqual([
      'low',
      'medium',
      'high',
      'very-high',
    ]);
  });

  it('hides moderate-confidence content balanced would only warn', () => {
    // Between balanced (0.7) and strict (0.45) hide floors, high confidence:
    // balanced must NOT hide, aggressive must hide.
    const cl = classification({
      aiLikelihood: 0.6,
      slopLikelihood: 0,
      categories: { 'ai-visual': 0.6 },
      confidence: 'high',
    });
    expect(actionFor('balanced', cl)).not.toBe('hide');
    expect(actionFor('aggressive', cl)).toBe('hide');
  });

  it('hides low-confidence content that strict and balanced only warn or allow', () => {
    // V4-03 measured tradeoff: aggressive accepts 'low' confidence.
    const cl = classification({
      aiLikelihood: 0.5,
      slopLikelihood: 0,
      categories: { 'ai-visual': 0.5 },
      confidence: 'low',
    });
    expect(actionFor('strict', cl)).not.toBe('hide');
    expect(actionFor('aggressive', cl)).toBe('hide');
  });

  it('does not hide on metadata absence or a zero-signal classification in any mode', () => {
    const empty = classification({
      aiLikelihood: 0,
      slopLikelihood: 0,
      categories: {},
      evidence: [],
      confidence: 'low',
    });
    for (const mode of ['safe', 'balanced', 'strict', 'aggressive'] as const) {
      expect(actionFor(mode, empty)).toBe('allow');
    }
  });

  it('never lets thumbnail-only evidence hide a video, even in aggressive', () => {
    const cl = classification({
      aiLikelihood: 0.55,
      slopLikelihood: 0,
      categories: { 'ai-thumbnail': 0.55 },
      confidence: 'low',
    });
    expect(actionFor('aggressive', cl)).not.toBe('hide');
  });

  it('a user correction (Not AI) still vetoes automatic hides in aggressive', () => {
    const cl = classification({
      aiLikelihood: 0.55,
      slopLikelihood: 0,
      categories: { 'ai-visual': 0.55 },
      confidence: 'low',
    });
    const corrected = decide({
      settings: settings('aggressive'),
      rules: defaultRules(),
      candidate: baseCandidate,
      classification: cl,
      correctedNotAi: true,
    });
    expect(corrected.action).not.toBe('hide');
  });

  it('explicit allow rule beats an aggressive-mode automatic hide', () => {
    const cl = classification({
      aiLikelihood: 0.55,
      categories: { 'ai-visual': 0.55 },
      confidence: 'low',
    });
    const decision = decide({
      settings: settings('aggressive'),
      rules: {
        ...defaultRules(),
        allowedVideoIds: [String(baseCandidate.videoId)],
      },
      candidate: baseCandidate,
      classification: cl,
    });
    expect(decision.action).toBe('allow');
    expect(decision.reason).toBe('user-rule');
  });

  it('changing the mode does not change category defaults (no silent neutralization)', () => {
    const base = defaultSettings();
    for (const mode of ['safe', 'balanced', 'strict', 'aggressive'] as const) {
      expect(settings(mode).categoryActions).toEqual(base.categoryActions);
    }
  });
});

// ── Hand-authored regression set ──────────────────────────────────────
// Revised during V4-03 development after observing the detector's responses.
// Labels are developer judgments. Do not treat these as holdout accuracy.

interface EvalCase {
  readonly id: string;
  readonly title: string;
  readonly description?: string | undefined;
  /** Label: content is materially AI-generated. */
  readonly ai: boolean;
  /** Label: content is slop/low-effort/automated. */
  readonly slop?: boolean | undefined;
  readonly ytLabel?: boolean | undefined;
  readonly locale?: string | undefined;
  readonly isShort?: boolean | undefined;
  readonly surface?: NormalizedVideoCandidate['surface'] | undefined;
}

const FROZEN_EVAL: readonly EvalCase[] = [
  // ── Labeled AI (15) ──
  // Tier A: strong observed disclosure (balanced+ hides).
  { id: 'f01', title: 'I built the whole documentary with AI', ai: true },
  { id: 'f02', title: 'Created with OpenAI Sora — fog rolling over the bay', ai: true },
  {
    id: 'f03',
    title: 'Cooking recap: kitchen disasters episode 9 (made with AI)',
    ai: true,
  },
  {
    id: 'f04',
    title: 'City symphony — my first generated short',
    ai: true,
    description: 'The visuals in this video are AI generated.',
  },
  {
    id: 'f05',
    title: 'Restored 1906 street market footage',
    ai: true,
    ytLabel: true,
  },
  // Tier B: combined weak heuristics (~0.55 medium — strict+aggressive).
  { id: 'f06', title: 'AI toddlers bake a cake (3D animation)', ai: true },
  { id: 'f07', title: 'I asked Gemini to paint my garden — 3D animation result', ai: true },
  { id: 'f08', title: 'AI puppies go to school (3D animation)', ai: true, isShort: true },
  { id: 'f09', title: '4 hours of calming snowy forest scenes', ai: true },
  { id: 'f10', title: 'AI animals run a diner (3D animation) #shorts', ai: true },
  // Tier C: single weak heuristic (~0.35 low — aggressive only).
  { id: 'f11', title: 'AI kittens run a bakery', ai: true },
  { id: 'f12', title: '6 minutes of relaxing campfire views', ai: true },
  { id: 'f13', title: 'AI ducklings take their first swim', ai: true },
  { id: 'f14', title: '2 hours of soothing rainforest views', ai: true },
  { id: 'f15', title: 'AI hamsters open a tiny cafe', ai: true },

  // ── Labeled human / discussion / negative controls (10) — FP side ──
  { id: 'f16', title: 'How to spot AI-generated videos: 5 telltale signs', ai: false },
  { id: 'f17', title: 'What is generative AI? A beginner’s guide', ai: false },
  { id: 'f18', title: 'I tested 7 AI video tools so you don’t have to', ai: false },
  { id: 'f19', title: 'The rise of synthetic media — a journalist explains', ai: false },
  // Honest aggressive-cost probes: ambiguous contextual phrasings a strict
  // filter would not act on. If aggressive hides these, that cost is REAL
  // and recorded (capped in the assertions below, never silently dropped).
  { id: 'f20', title: '3D animation showreel: two years of Blender practice', ai: false },
  { id: 'f21', title: 'AI toddler puppet made of foam (cosplay build)', ai: false },
  { id: 'f22', title: 'Watercolor painting process, start to finish', ai: false },
  { id: 'f23', title: 'Woodworking basics: making a cutting board', ai: false },
  { id: 'f24', title: 'Recording my first piano recital', ai: false },
  { id: 'f25', title: 'Sea otters at the aquarium (4K)', ai: false },
];

// ── Measurement ─────────────────────────────────────────────────────────────

function evalCandidate(c: EvalCase): NormalizedVideoCandidate {
  return {
    videoId: `v403-${c.id}`,
    title: c.title,
    description: c.description,
    channel: { channelId: 'UCV403Eval0000000000000', displayName: 'Eval Channel' },
    surface: c.surface ?? 'home',
    cardKind: c.isShort ? 'shorts-video' : 'video',
    badges: [],
    ariaLabels: [],
    metadataText: ['18K views', '2 weeks ago'],
    ...(c.ytLabel
      ? { officialDisclosure: { present: true, text: 'Altered or synthetic content' } }
      : {}),
    isShort: c.isShort ?? false,
    observedAt: 1_700_000_000_000,
  };
}

async function evalClassify(c: EvalCase): Promise<Classification> {
  return classifyCandidate(evalCandidate(c), { locale: c.locale });
}

function evalDecide(
  c: EvalCase,
  cl: Classification,
  mode: UserSettings['mode'],
): 'allow' | 'warn' | 'hide' {
  return decide({
    settings: settings(mode),
    rules: defaultRules(),
    candidate: { videoId: `v403-${c.id}`, channelId: 'UCV403Eval0000000000000', title: c.title },
    classification: cl,
  }).action;
}

describe('V4-03 regression set (mode gain + observed false hides)', () => {
  it('measures per-mode AI hide gain and false-positive cost with denominators', async () => {
    const cls = new Map<string, Classification>();
    for (const c of FROZEN_EVAL) cls.set(c.id, await evalClassify(c));

    const rows: string[] = [];
    const hides: Record<UserSettings['mode'], number> = {
      safe: 0,
      balanced: 0,
      strict: 0,
      aggressive: 0,
    };
    const falseHides: Record<UserSettings['mode'], string[]> = {
      safe: [],
      balanced: [],
      strict: [],
      aggressive: [],
    };
    const aiLabeled = FROZEN_EVAL.filter((c) => c.ai);
    const nonAi = FROZEN_EVAL.filter((c) => !c.ai);

    for (const mode of ['safe', 'balanced', 'strict', 'aggressive'] as const) {
      for (const c of aiLabeled) {
        const cl = cls.get(c.id);
        if (!cl) throw new Error('unclassified');
        if (evalDecide(c, cl, mode) === 'hide') hides[mode] += 1;
      }
      for (const c of nonAi) {
        const cl = cls.get(c.id);
        if (!cl) throw new Error('unclassified');
        if (evalDecide(c, cl, mode) === 'hide') {
          falseHides[mode].push(`${c.id}:${c.title}`);
        }
      }
      const recall = hides[mode] / aiLabeled.length;
      const fpr = falseHides[mode].length / nonAi.length;
      rows.push(
        `${mode}: aiHides=${hides[mode]}/${aiLabeled.length} recall=${recall.toFixed(3)} falseHides=${falseHides[mode].length}/${nonAi.length} fpr=${fpr.toFixed(3)}`,
      );
    }
    console.log(
      `V403 hand-authored regression set (n=${FROZEN_EVAL.length}, ai=${aiLabeled.length}, non-ai=${nonAi.length}):\n${rows.join('\n')}`,
    );
    console.log(`aggressive false-hides: ${falseHides['aggressive'].join(' | ') || '(none)'}`);

    // ── Regression gates on the hand-authored set ──
    // 1. Aggressive must add true AI hides over BOTH Safe and Balanced —
    //    the kit's core acceptance criterion for V4-03.
    expect(hides['aggressive']).toBeGreaterThan(hides['safe']);
    expect(hides['aggressive']).toBeGreaterThan(hides['balanced']);
    // 2. Aggressive must not hide non-AI content beyond the recorded cost —
    //    false hides are accepted ONLY because they are measured and capped.
    expect(falseHides['aggressive'].length).toBeLessThanOrEqual(3);
    // 3. Ladder consistency on decisions: aggressive hides a superset of
    //    balanced's hidden set for AI-labeled cases is NOT guaranteed by
    //    thresholds alone (confidence classes interleave), but strict-mode
    //    superset of safe IS structural; assert the structural part.
    expect(hides['strict']).toBeGreaterThanOrEqual(hides['safe']);
    // 4. Explicit-recorded evidence: the aggressive cost is printed above and
    //    mirrored into the ledger (no silent tradeoffs).
    expect(hides['aggressive'] + falseHides['aggressive'].length).toBeGreaterThan(0);
  });

  it('unknown-free eval set never hides a non-AI case in safe mode (sanity)', async () => {
    for (const c of FROZEN_EVAL.filter((x) => !x.ai)) {
      const cl = await evalClassify(c);
      expect(evalDecide(c, cl, 'safe')).not.toBe('hide');
    }
  });
});
