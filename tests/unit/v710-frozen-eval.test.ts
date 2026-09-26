import { describe, expect, it } from 'vitest';
import { classifyCandidate } from '@/detection/engine';
import { decide, MODE_THRESHOLDS } from '@/policy/decide';
import { defaultSettings } from '@/domain/settings';
import { defaultRules } from '@/domain/rules';
import { AI_CATEGORIES, SLOP_CATEGORIES } from '@/domain/evidence';
import type { Classification } from '@/domain/classification';
import type { NormalizedVideoCandidate } from '@/domain/video';

/**
 * V7-10 — frozen evaluation sets for the detector, per the kit contract:
 *
 * - DEV SET: frozen labeled cases that rule/detector changes ARE tuned
 *   against. Committed frozen so every change claiming an improvement is
 *   measured against the same denominators (no per-run thresholds).
 * - HOLDOUT: a separate frozen list that NO rule change in this version may
 *   be tuned against. The leakage guard fails loudly if a holdout title/id
 *   leaks into the dev set; holdout metrics are REPORTED, and only the
 *   product's hard no-false-hide floor is enforced there.
 * - Metrics: confusion matrix (TP/FP/FN/TN) per MODE and per AXIS
 *   (AI-production vs slop/low-quality, never merged), with explicit
 *   denominators printed and bucket sums pinned to N.
 *   Prediction semantics: "would this AXIS ALONE hide at this MODE's
 *   operating point" — the other axis's score and categories are zeroed and
 *   the real decide() runs. This is mode-aware by construction and never
 *   compares across axes.
 * - Provenance: every deciding evidence item carries its rule id /
 *   reason code, so changed rules can name exactly what they matched.
 * - No "perfect detector" claims: floors below are floors, and the slop
 *   axis is expected to be weak; that honesty is part of the contract.
 */

type Axis = 'ai' | 'slop';
type Mode = 'safe' | 'balanced' | 'strict';

interface EvalEntry {
  /** Frozen id — provenance ledger keys reference these. */
  id: string;
  title: string;
  description?: string | undefined;
  /** Label for the AI-production axis. */
  aiPositive: boolean;
  /** Label for the slop/low-quality axis. */
  slopPositive: boolean;
}

/**
 * FROZEN DEV SET (V7-10). Extends the R18/DET-30 corpus with the
 * multilingual disclosure (V7-08) and whole-word rule (V7-09) additions;
 * labels are part of the freeze. Do not edit in place: add dated addenda.
 */
const DEV_SET: readonly EvalEntry[] = [
  // — AI-axis positives (generation evidence in title/description) —
  {
    id: 'dev-ai-01',
    title: 'Cute Fruit Babies Eating | AI Generated Funny Fruits Animation',
    aiPositive: true,
    slopPositive: false,
  },
  {
    id: 'dev-ai-02',
    title: 'Foodtrip muna ng Lava Chocolate Cake!! ai generated tagalog video using veo 3! #ai',
    aiPositive: true,
    slopPositive: false,
  },
  {
    id: 'dev-ai-03',
    title: 'Satisfying Glass-Like Watermelon Bites | ASMR (AI-Generated)',
    aiPositive: true,
    slopPositive: false,
  },
  {
    id: 'dev-ai-04',
    title: 'Ai animation cat video #cat #pets #3danimation',
    aiPositive: true,
    slopPositive: false,
  },
  {
    id: 'dev-ai-05',
    title: 'Tutorial: painting technique walkthrough',
    description: 'All footage in this video was generated with Sora.',
    aiPositive: true,
    slopPositive: false,
  },
  { id: 'dev-ai-06', title: 'Music generated using Suno', aiPositive: true, slopPositive: false },
  {
    id: 'dev-ai-07',
    title: 'Official disclosure: altered or synthetic content',
    aiPositive: true,
    slopPositive: false,
  },
  {
    id: 'dev-ai-08',
    title: 'Cómo hice este video',
    description: 'Este video fue generado con IA.',
    aiPositive: true,
    slopPositive: false,
  },
  {
    id: 'dev-ai-09',
    title: '私の旅行vlog',
    description: 'この動画はAIで生成されました。',
    aiPositive: true,
    slopPositive: false,
  },
  {
    id: 'dev-ai-10',
    title: 'Mein neues Album',
    description: 'Dieses Video wurde KI-generiert.',
    aiPositive: true,
    slopPositive: false,
  },
  {
    id: 'dev-ai-11',
    title: 'Receita de bolo caseiro',
    description: 'Este vídeo foi criado com IA.',
    aiPositive: true,
    slopPositive: false,
  },
  {
    id: 'dev-ai-12',
    title: 'Ma routine du matin',
    description: 'Cette vidéo a été créée avec l’IA.',
    aiPositive: true,
    slopPositive: false,
  },
  {
    id: 'dev-ai-13',
    title: 'La mia estate in Italy',
    description: 'Questo video è stato creato con l’IA.',
    aiPositive: true,
    slopPositive: false,
  },
  {
    id: 'dev-ai-14',
    title: 'Reseña del nuevo editor',
    description: 'Este vídeo ha sido generado con inteligencia artificial.',
    aiPositive: true,
    slopPositive: false,
  },
  {
    id: 'dev-ai-15',
    title: 'Sunset timelapse (AI generated)',
    aiPositive: true,
    slopPositive: false,
  },

  // — Slop-axis positives (low-quality/repetitive/clickbait slop) —
  {
    id: 'dev-slop-01',
    title: 'You WON’T BELIEVE What Happened Next!! (GONE WRONG) (GONE SEXY) #shorts',
    aiPositive: false,
    slopPositive: true,
  },
  {
    id: 'dev-slop-02',
    title: 'Top 10 Shocking Facts That Will BLOW YOUR MIND!!!',
    aiPositive: false,
    slopPositive: true,
  },
  {
    id: 'dev-slop-03',
    title: '10 Photos Taken SECONDS Before Disaster',
    aiPositive: false,
    slopPositive: true,
  },
  {
    id: 'dev-slop-04',
    title: 'This One Weird Trick Doctors HATE',
    aiPositive: false,
    slopPositive: true,
  },

  // — Negatives: human content that must survive every mode —
  {
    id: 'dev-neg-01',
    title: 'Best AI video generator review',
    aiPositive: false,
    slopPositive: false,
  },
  {
    id: 'dev-neg-02',
    title: 'How to spot AI-generated videos',
    aiPositive: false,
    slopPositive: false,
  },
  {
    id: 'dev-neg-03',
    title: 'This is NOT AI-generated; practical effects only',
    aiPositive: false,
    slopPositive: false,
  },
  {
    id: 'dev-neg-04',
    title: 'Handmade clay fruit baby stop motion',
    aiPositive: false,
    slopPositive: false,
  },
  {
    id: 'dev-neg-05',
    title: 'Why AI Slop Is Ruining YouTube',
    aiPositive: false,
    slopPositive: false,
  },
  {
    id: 'dev-neg-06',
    title: 'ORANGE Baby #ai #comedy #baby #shorts',
    aiPositive: false,
    slopPositive: false,
  },
  { id: 'dev-neg-07', title: 'Thai railway painting', aiPositive: false, slopPositive: false },
  { id: 'dev-neg-08', title: 'daily rain', aiPositive: false, slopPositive: false },
  {
    id: 'dev-neg-09',
    title: 'My grandmother’s 90th birthday party',
    aiPositive: false,
    slopPositive: false,
  },
  {
    id: 'dev-neg-10',
    title: 'Satisfying Glass-Like Watermelon Bites | ASMR',
    aiPositive: false,
    slopPositive: false,
  },

  // — Distractor negatives: AI-adjacent human work (tutorials/thumbnails) —
  { id: 'dev-neg-11', title: 'I tested Veo for a month', aiPositive: false, slopPositive: false },
  { id: 'dev-neg-12', title: 'Sora game guide', aiPositive: false, slopPositive: false },
  { id: 'dev-neg-13', title: 'AI regulation hearing', aiPositive: false, slopPositive: false },
  {
    id: 'dev-neg-14',
    title: 'How I design thumbnails that get clicked',
    aiPositive: false,
    slopPositive: false,
  },
  {
    id: 'dev-neg-15',
    title: 'My honest review of AI thumbnail tools',
    aiPositive: false,
    slopPositive: false,
  },
  { id: 'dev-neg-16', title: 'Cute AI Baby Reciting Papa', aiPositive: false, slopPositive: false },
];

/**
 * FROZEN HOLDOUT (V7-10). Never tuned to in this version. Deliberately
 * harder: indirect disclosure wording, whole-word boundary cases, and
 * human/tutorial/thumbnail negatives.
 */
const HOLDOUT: readonly EvalEntry[] = [
  // — AI positives, indirect or cross-lingual —
  {
    id: 'hold-ai-01',
    title: 'Making ASMR with ElevenLabs voices',
    aiPositive: true,
    slopPositive: false,
  },
  {
    id: 'hold-ai-02',
    title: 'Neue Folge jeder Woche',
    description: 'Die Stimme in diesem Video wurde mit KI erzeugt.',
    aiPositive: true,
    slopPositive: false,
  },
  {
    id: 'hold-ai-03',
    title: 'Testando o editor de vídeo',
    description: 'Partes deste vídeo foram criadas com IA.',
    aiPositive: true,
    slopPositive: false,
  },
  {
    id: 'hold-ai-04',
    title: 'Reacting to fake movie trailers',
    description: 'This video contains synthetic media.',
    aiPositive: true,
    slopPositive: false,
  },
  {
    id: 'hold-ai-05',
    title: 'Operación limpia | corto de IA',
    aiPositive: true,
    slopPositive: false,
  },

  // — Slop positives (kept scarce in the holdout on purpose) —
  {
    id: 'hold-slop-01',
    title: '13 Nerve-Racking Photos That Will Haunt You Forever',
    aiPositive: false,
    slopPositive: true,
  },
  {
    id: 'hold-slop-02',
    title: '15 Little-Known Facts That Will Change How You See the World',
    aiPositive: false,
    slopPositive: true,
  },

  // — Negatives: the hard human cases —
  {
    id: 'hold-neg-01',
    title: 'Whole-word rule test: the word gene alone must not hide this',
    aiPositive: false,
    slopPositive: false,
  },
  {
    id: 'hold-neg-02',
    title: 'I built my own AI detector (open source)',
    aiPositive: false,
    slopPositive: false,
  },
  {
    id: 'hold-neg-03',
    title: 'How to make AI thumbnails people actually click',
    aiPositive: false,
    slopPositive: false,
  },
  {
    id: 'hold-neg-04',
    title: 'Universal Studios Japan trip vlog',
    aiPositive: false,
    slopPositive: false,
  },
  {
    id: 'hold-neg-05',
    title: 'The AI Act, one year later',
    aiPositive: false,
    slopPositive: false,
  },
  { id: 'hold-neg-06', title: 'Mi perro no es un robot', aiPositive: false, slopPositive: false },
  {
    id: 'hold-neg-07',
    title: 'Photographing the Milky Way with a 10-year-old lens',
    aiPositive: false,
    slopPositive: false,
  },
];

const ALL_SETS: readonly { name: 'dev' | 'holdout'; entries: readonly EvalEntry[] }[] = [
  { name: 'dev', entries: DEV_SET },
  { name: 'holdout', entries: HOLDOUT },
];

function candidateFor(entry: EvalEntry): NormalizedVideoCandidate {
  return {
    videoId: `eval-${entry.id}`,
    title: entry.title,
    description: entry.description,
    channel: { channelId: 'UCEVAL', displayName: 'Eval Channel' },
    surface: 'home',
    cardKind: 'video',
    badges: [],
    ariaLabels: [],
    metadataText: ['120K views', '2 months ago'],
    isShort: false,
    observedAt: 1_700_000_000_000,
  };
}

const DETECTION_CONTEXT = { locale: 'en' } as const;

async function classify(entry: EvalEntry): Promise<Classification> {
  return classifyCandidate(candidateFor(entry), DETECTION_CONTEXT);
}

const AI_CATEGORY_SET = new Set<string>(AI_CATEGORIES);
const SLOP_CATEGORY_SET = new Set<string>(SLOP_CATEGORIES);

/**
 * Zero the OPPOSITE axis (score + its categories) and run the real decide()
 * — mirroring decide()'s own dimensional-correction semantics. Returns
 * whether this axis alone hides, and whether it warns, at this mode.
 */
function axisIsolatedDecision(
  classification: Classification,
  settings: ReturnType<typeof defaultSettings>,
  axis: Axis,
): { hides: boolean; warns: boolean } {
  const zeroedCategories: Partial<Record<string, number>> = {};
  for (const [category, score] of Object.entries(classification.categories)) {
    if (score === undefined) continue;
    const isAi = AI_CATEGORY_SET.has(category);
    const isSlop = SLOP_CATEGORY_SET.has(category);
    if (axis === 'ai' && isSlop) continue;
    if (axis === 'slop' && isAi) continue;
    zeroedCategories[category] = score;
  }
  const isolated: Classification = {
    ...classification,
    aiLikelihood: axis === 'ai' ? classification.aiLikelihood : 0,
    slopLikelihood: axis === 'slop' ? classification.slopLikelihood : 0,
    categories: zeroedCategories,
  };
  const decision = decide({
    settings,
    rules: defaultRules(),
    candidate: { videoId: 'eval-isolated', channelId: 'UCEVAL' },
    classification: isolated,
  });
  return { hides: decision.action === 'hide', warns: decision.action === 'warn' };
}

interface Confusion {
  tp: number;
  fp: number;
  fn: number;
  tn: number;
  /**
   * This axis hid a video labeled positive on the OTHER axis only. The
   * product outcome is correct (the video is hidden), but attributing it
   * to this axis as a false positive would be wrong — these are counted
   * separately and excluded from precision/recall denominators.
   */
  crossAxisHide: number;
  warnOnPositive: number;
  n: number;
  falseHideTitles: string[];
}

function emptyConfusion(): Confusion {
  return {
    tp: 0,
    fp: 0,
    fn: 0,
    tn: 0,
    crossAxisHide: 0,
    warnOnPositive: 0,
    n: 0,
    falseHideTitles: [],
  };
}

function renderMatrix(name: string, m: Confusion): string {
  const precision = m.tp + m.fp === 0 ? 'n/a' : (m.tp / (m.tp + m.fp)).toFixed(3);
  const recall = m.tp + m.fn === 0 ? 'n/a' : (m.tp / (m.tp + m.fn)).toFixed(3);
  return [
    `${name}: n=${m.n} TP=${m.tp} FP=${m.fp} FN=${m.fn} TN=${m.tn} crossAxis=${m.crossAxisHide} warn+=${m.warnOnPositive} P=${precision} R=${recall}`,
    `  false hides: ${m.falseHideTitles.length === 0 ? '(none)' : m.falseHideTitles.join(' | ')}`,
  ].join('\n');
}

describe('V7-10: frozen-set integrity (no leakage by construction)', () => {
  it('holdout shares no titles or ids with the dev set', () => {
    const devTitles = new Set(DEV_SET.map((e) => e.title.toLowerCase()));
    const devIds = new Set(DEV_SET.map((e) => e.id));
    for (const entry of HOLDOUT) {
      expect(devTitles.has(entry.title.toLowerCase()), `leaked title: ${entry.title}`).toBe(false);
      expect(devIds.has(entry.id), `leaked id: ${entry.id}`).toBe(false);
    }
    // Both sets must be non-trivial.
    expect(DEV_SET.length).toBeGreaterThanOrEqual(24);
    expect(HOLDOUT.length).toBeGreaterThanOrEqual(12);
  });

  it('labels are coherent booleans and ids are unique across both sets', () => {
    const ids = new Set<string>();
    for (const set of ALL_SETS) {
      for (const entry of set.entries) {
        expect(typeof entry.aiPositive).toBe('boolean');
        expect(typeof entry.slopPositive).toBe('boolean');
        expect(ids.has(entry.id), `duplicate id ${entry.id}`).toBe(false);
        ids.add(entry.id);
      }
    }
  });

  it('prediction is mode-aware: a zero-score axis can never hide in any mode', () => {
    const empty: Classification = {
      aiLikelihood: 0,
      slopLikelihood: 0,
      categories: {},
      confidence: 'low',
      evidence: [],
      classifierVersion: '0',
      rulesVersion: '0',
      evaluatedAt: 0,
    };
    for (const mode of ['safe', 'balanced', 'strict'] as const) {
      const settings = { ...defaultSettings(), mode };
      expect(axisIsolatedDecision(empty, settings, 'ai').hides).toBe(false);
      expect(axisIsolatedDecision(empty, settings, 'slop').hides).toBe(false);
    }
  });
});

describe('V7-10: dev-set confusion matrices by mode and axis (tuning set)', () => {
  for (const mode of ['safe', 'balanced', 'strict'] as const) {
    it(`mode=${mode}: AI and slop axes are measured separately with denominators`, async () => {
      const settings = { ...defaultSettings(), mode };
      const ai = emptyConfusion();
      const slop = emptyConfusion();
      const provenance = new Map<string, Set<string>>();

      for (const entry of DEV_SET) {
        const classification = await classify(entry);

        for (const axis of ['ai', 'slop'] as const) {
          const label = axis === 'ai' ? entry.aiPositive : entry.slopPositive;
          const otherLabel = axis === 'ai' ? entry.slopPositive : entry.aiPositive;
          const outcome = axisIsolatedDecision(classification, settings, axis);
          const m = axis === 'ai' ? ai : slop;
          m.n += 1;
          if (outcome.hides && label) m.tp += 1;
          else if (outcome.hides && !label && otherLabel) {
            // Video IS hidden overall (correct product outcome) — the OTHER
            // axis owns the true positive, not this one.
            m.crossAxisHide += 1;
          } else if (outcome.hides && !label) {
            m.fp += 1;
            m.falseHideTitles.push(`${entry.id}: ${entry.title}`);
          } else if (!outcome.hides && label) {
            m.fn += 1;
            if (outcome.warns) m.warnOnPositive += 1;
          } else {
            m.tn += 1;
          }
        }

        // Rule provenance: which rule ids / reason codes produced evidence.
        const sources = provenance.get(entry.id) ?? new Set<string>();
        for (const e of classification.evidence) {
          sources.add(`${e.detector}:${e.ruleId ?? e.reasonCode}`);
        }
        if (sources.size > 0) provenance.set(entry.id, sources);
      }

      // Buckets must sum to the dev-set size — no denominator tricks.
      expect(ai.tp + ai.fp + ai.fn + ai.tn + ai.crossAxisHide).toBe(DEV_SET.length);
      expect(slop.tp + slop.fp + slop.fn + slop.tn + slop.crossAxisHide).toBe(DEV_SET.length);

      // Product hard floor on the tuning set: no AI-axis false hide of a
      // human video in safe/balanced; strict accepts more FPs by design
      // (measured and surfaced, not hidden).
      if (mode !== 'strict') {
        expect(ai.falseHideTitles, `mode=${mode} false hides`).toHaveLength(0);
      }

      // Provenance must exist (rule-based decisions must be attributable).
      expect(provenance.size).toBeGreaterThan(0);

      // Report the full table (visible in verbose output for the ledger).
      console.log(
        `[V7-10 dev mode=${mode}]\n${renderMatrix('ai', ai)}\n${renderMatrix('slop', slop)}`,
      );
    });
  }

  it('rule provenance ledger covers deciding evidence with rule ids', async () => {
    const entry = DEV_SET.find((e) => e.id === 'dev-ai-01');
    expect(entry).toBeDefined();
    const classification = await classify(entry!);
    const ruleBacked = classification.evidence.filter((e) => e.ruleId !== undefined);
    expect(ruleBacked.length).toBeGreaterThan(0);
    for (const e of ruleBacked) {
      expect(e.ruleId).toMatch(/^(en|fil):/);
      expect(e.matchedExcerpt).toBeTruthy();
    }
  });
});

describe('V7-10: untouched holdout (reported, not tuned)', () => {
  const results: { mode: Mode; ai: Confusion; slop: Confusion }[] = [];

  for (const mode of ['safe', 'balanced', 'strict'] as const) {
    it(`mode=${mode}: holdout metrics reported with explicit denominators`, async () => {
      const settings = { ...defaultSettings(), mode };
      const ai = emptyConfusion();
      const slop = emptyConfusion();

      for (const entry of HOLDOUT) {
        const classification = await classify(entry);
        for (const axis of ['ai', 'slop'] as const) {
          const label = axis === 'ai' ? entry.aiPositive : entry.slopPositive;
          const otherLabel = axis === 'ai' ? entry.slopPositive : entry.aiPositive;
          const outcome = axisIsolatedDecision(classification, settings, axis);
          const m = axis === 'ai' ? ai : slop;
          m.n += 1;
          if (outcome.hides && label) m.tp += 1;
          else if (outcome.hides && !label && otherLabel) {
            m.crossAxisHide += 1;
          } else if (outcome.hides && !label) {
            m.fp += 1;
            m.falseHideTitles.push(`${entry.id}: ${entry.title}`);
          } else if (!outcome.hides && label) {
            m.fn += 1;
            if (outcome.warns) m.warnOnPositive += 1;
          } else {
            m.tn += 1;
          }
        }
      }

      expect(ai.n).toBe(HOLDOUT.length);
      expect(slop.n).toBe(HOLDOUT.length);
      expect(ai.tp + ai.fp + ai.fn + ai.tn + ai.crossAxisHide).toBe(HOLDOUT.length);
      // Hard product floor everywhere (including strict): a false hide of a
      // labeled human video on the AI axis is the worst failure mode. The
      // holdout negatives include the deliberate hard cases (whole-word
      // boundary, tutorial/thumbnail discussion, negation).
      expect(ai.falseHideTitles, `mode=${mode} holdout false hides`).toHaveLength(0);

      results.push({ mode, ai, slop });
      console.log(
        `[V7-10 holdout mode=${mode}]\n${renderMatrix('ai', ai)}\n${renderMatrix('slop', slop)}`,
      );
    });
  }

  it('all three mode rows were measured (report completeness)', () => {
    expect(results.map((r) => r.mode)).toEqual(['safe', 'balanced', 'strict']);
  });

  it('threshold table is pinned: hideAt is monotonic across modes', () => {
    expect(MODE_THRESHOLDS.safe.hideAt).toBeGreaterThan(MODE_THRESHOLDS.balanced.hideAt);
    expect(MODE_THRESHOLDS.balanced.hideAt).toBeGreaterThan(MODE_THRESHOLDS.strict.hideAt);
  });
});
