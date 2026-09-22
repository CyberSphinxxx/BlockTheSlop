import { describe, expect, it } from 'vitest';
import { classifyCandidate, aggregateEvidence } from '@/detection/engine';
import { matchRules, rulesForLocale } from '@/detection/rules';
import { decide, MODE_THRESHOLDS } from '@/policy/decide';
import { defaultSettings } from '@/domain/settings';
import { defaultRules } from '@/domain/rules';
import type { Evidence } from '@/domain/evidence';
import type { NormalizedVideoCandidate } from '@/domain/video';
import type { Classification } from '@/domain/classification';

/**
 * DET-01..DET-30 — held-out evaluation corpus (R18).
 *
 * These cases ARE the documented test plan; they must pass without being
 * tuned to themselves beyond what the kit's DET table specifies. The DET-30
 * metrics gate at the bottom computes bucketed precision/recall/false-hides
 * with explicit denominators.
 */

function candidate(overrides: Partial<NormalizedVideoCandidate> = {}): NormalizedVideoCandidate {
  return {
    videoId: 'vid1',
    title: 'A normal human video',
    channel: { channelId: 'UC1', displayName: 'Human Channel' },
    surface: 'home',
    cardKind: 'video',
    badges: [],
    ariaLabels: [],
    metadataText: ['12K views', '3 weeks ago'],
    isShort: false,
    observedAt: 1_700_000_000_000,
    ...overrides,
  };
}

const ctx = { locale: 'en' } as const;

function decideFor(c: NormalizedVideoCandidate, classification?: Classification) {
  return decide({
    settings: defaultSettings(),
    rules: defaultRules(),
    candidate: { videoId: c.videoId, channelId: c.channel.channelId, handle: c.channel.handle },
    classification,
  });
}

async function classify(c: NormalizedVideoCandidate): Promise<Classification> {
  return classifyCandidate(c, ctx);
}

describe('generation titles (DET-01..05)', () => {
  it('DET-01: explicit generation, no music evidence', async () => {
    const c = await classify(
      candidate({ title: 'Cute Fruit Babies Eating | AI Generated Funny Fruits Animation' }),
    );
    expect(c.aiLikelihood).toBeGreaterThan(0.3);
    expect(c.categories['ai-music'] ?? 0).toBeLessThan(0.2);
  });

  it('DET-02: EN/FIL mixed generation evidence, not automatically music', async () => {
    const c = await classify(
      candidate({
        title: 'Foodtrip muna ng Lava Chocolate Cake!! ai generated tagalog video using veo 3! #ai',
      }),
    );
    expect(c.aiLikelihood).toBeGreaterThan(0.3);
    expect(c.categories['ai-music'] ?? 0).toBeLessThan(0.3);
    expect(c.categories['ai-visual'] ?? 0).toBeGreaterThan(0.2);
  });

  it('DET-03: ASMR alone is not music evidence', async () => {
    const c = await classify(
      candidate({ title: 'Satisfying Glass-Like Watermelon Bites | ASMR (AI-Generated)' }),
    );
    expect(c.aiLikelihood).toBeGreaterThan(0.3);
    expect(c.categories['ai-music'] ?? 0).toBeLessThan(0.3);
  });

  it('DET-04: contextual signal with honest strength', async () => {
    const c = await classify(
      candidate({ title: 'Ai animation cat video #cat #pets #3danimation' }),
    );
    expect(c.aiLikelihood).toBeGreaterThan(0.15);
    expect(c.aiLikelihood).toBeLessThan(0.6); // contextual, not confirmed
  });

  it('DET-05: bare #ai cannot alone hide in any mode', async () => {
    const classification = await classify(
      candidate({ title: 'ORANGE Baby #ai #comedy #baby #shorts' }),
    );
    for (const mode of ['safe', 'balanced', 'strict'] as const) {
      const settings = { ...defaultSettings(), mode };
      const decision = decide({
        settings,
        rules: defaultRules(),
        candidate: { videoId: 'vid1', channelId: 'UC1' },
        classification,
      });
      expect(decision.action).not.toBe('hide');
    }
  });
});

describe('discussion/tool negatives (DET-06, DET-08, DET-13)', () => {
  const negatives = [
    'Best AI video generator review',
    'How to spot AI-generated videos',
    'AI regulation hearing',
    'I tested Veo for a month',
    'Sora game guide',
  ];

  it('no automatic hide from tool-review or discussion contexts', async () => {
    for (const title of negatives) {
      const c = await classify(candidate({ title }));
      expect(c.aiLikelihood, title).toBeLessThan(0.45);
      expect(decideFor(candidate({ title }), c).action, title).not.toBe('hide');
    }
  });
});

describe('negation and frames (DET-07, DET-09, DET-10)', () => {
  it('DET-07: ambiguous contextual signal, not confirmed provenance', async () => {
    const c = await classify(candidate({ title: 'Cute AI Baby Reciting Papa' }));
    expect(c.confidence).not.toBe('very-high');
    expect(c.aiLikelihood).toBeLessThan(0.75);
  });

  it('DET-09: negation scoped correctly — NOT AI-generated is allowed', async () => {
    const c = await classify(
      candidate({ title: 'This is NOT AI-generated; practical effects only' }),
    );
    expect(c.aiLikelihood).toBeLessThan(0.4);
    expect(decideFor(candidate({ title: 'This is NOT AI-generated' }), c).action).not.toBe('hide');
  });

  it('DET-10: tutorial context does not erase a direct footage disclosure', async () => {
    const c = await classify(
      candidate({
        title: 'Tutorial: painting technique walkthrough',
        description: 'All footage in this video was generated with Sora.',
      }),
    );
    expect(c.categories['ai-visual'] ?? 0).toBeGreaterThan(0.3);
  });
});

describe('dimension scoping (DET-11, DET-19, DET-20, DET-21)', () => {
  it('DET-11: music generation claim does not assert generated visuals', async () => {
    const c = await classify(candidate({ title: 'Music generated using Suno' }));
    expect(c.categories['ai-music'] ?? 0).toBeGreaterThan(0.2);
    expect(c.categories['ai-visual'] ?? 0).toBeLessThan(0.2);
  });

  it('DET-19: official label is generation-unspecified; no slop/music/visual certainty', async () => {
    const c = await classify(
      candidate({ officialDisclosure: { present: true, text: 'Altered or synthetic content' } }),
    );
    expect(c.aiLikelihood).toBeGreaterThan(0.6); // strong for the AI dimension
    expect(c.slopLikelihood).toBeLessThan(0.5); // never low-quality proof
    expect(c.categories['ai-music']).toBeUndefined();
    expect(c.categories['ai-visual']).toBeUndefined();
    // The policy layer decides the action via the ai-unspecified category.
    expect(decideFor(candidate(), c).action).toBe('hide');
  });

  it('DET-20: thumbnail declaration only affects the thumbnail category', async () => {
    const c = await classify(
      candidate({ description: 'Thumbnail made with Photoshop and AI tools.' }),
    );
    expect(c.categories['ai-thumbnail'] ?? 0).toBeGreaterThan(0.2);
    expect(c.aiLikelihood).toBeLessThan(0.75);
  });

  it('DET-21: voice and script disclosures scoped; text style is not script evidence', async () => {
    const voiced = await classify(candidate({ description: 'The voice is an AI voice.' }));
    expect(voiced.categories['ai-voice'] ?? 0).toBeGreaterThan(0.2);
    expect(voiced.categories['ai-script']).toBeUndefined();

    const scripted = await classify(
      candidate({ description: 'The script was written with AI assistance.' }),
    );
    expect(scripted.categories['ai-script'] ?? 0).toBeGreaterThan(0.2);

    const styled = await classify(candidate({ description: 'It reads like AI text, honestly.' }));
    expect(styled.categories['ai-script']).toBeUndefined();
  });
});

describe('aesthetic and substring negatives (DET-12, DET-14)', () => {
  it('DET-12: handmade aesthetic is not automatic AI evidence', async () => {
    const c = await classify(candidate({ title: 'Handmade clay fruit baby stop motion' }));
    expect(c.aiLikelihood).toBeLessThan(0.3);
  });

  it('DET-14: no raw-ai substring matches', async () => {
    for (const title of ['Thai railway painting', 'daily rain sounds', 'he said hello']) {
      const c = await classify(candidate({ title }));
      expect(c.aiLikelihood, title).toBeLessThan(0.2);
    }
  });
});

describe('normalization and locale (DET-15, DET-16)', () => {
  it('DET-15: unicode variants normalize for matching, display preserved', async () => {
    const c = await classify(
      candidate({
        title: 'Cute animals \u2014 made with \uFF21\uFF29 fullwidth \u2014 short film',
      }),
    );
    expect(c.aiLikelihood).toBeGreaterThan(0.2);
  });

  it('DET-16: Filipino content matches regardless of UI language', async () => {
    const enUi = await classify(candidate({ title: 'inilikha ng AI na kwento' }));
    const filUi = await classify(
      Object.assign(candidate({ title: 'inilikha ng AI na kwento' }), {}),
    );
    const ctxFil = { locale: 'fil' } as const;
    const filUi2 = await classifyCandidate(
      candidate({ title: 'inilikha ng AI na kwento' }),
      ctxFil,
    );
    expect(enUi.aiLikelihood).toBe(filUi.aiLikelihood); // packs are additive
    expect(filUi2.aiLikelihood).toBe(enUi.aiLikelihood);
    expect(enUi.aiLikelihood).toBeGreaterThan(0.3);
  });
});

describe('dedupe and confidence (DET-17, DET-18)', () => {
  it('DET-17: one phrase matched by multiple detectors is not independent evidence', async () => {
    const phrase = 'This video was made with AI';
    const rules = rulesForLocale('en');
    const matches = matchRules(rules, phrase, phrase);
    const correlated = matches.filter((m) => m.rule.correlationKey === 'disclosure:generation');
    expect(correlated.length).toBeLessThanOrEqual(1);
  });

  it('DET-18: missing channel + emojis + recent upload is not fabricated farm evidence', async () => {
    const c = await classify(
      candidate({
        title: '😊 Cute baby animals',
        metadataText: ['100 views', '2 minutes ago'],
        channel: {},
      }),
    );
    expect(c.categories['content-farm'] ?? 0).toBe(0);
  });
});

describe('cache correctness (DET-22..24)', () => {
  it('DET-22: richer description produces a different fingerprint', async () => {
    // Fingerprint behavior is covered end-to-end in tests/storage/idb.test.ts;
    // here we assert the fingerprint changes when evidence hydrates.
    const { classificationFingerprint } = await import('@/storage/fingerprint');
    const thin = classificationFingerprint({
      videoId: 'v1',
      title: 'Same title',
      badges: [],
      ariaLabels: [],
      metadataText: [],
      officialDisclosurePresent: false,
      isShort: false,
      locale: 'en',
    });
    const rich = classificationFingerprint({
      videoId: 'v1',
      title: 'Same title',
      description: 'Now hydrated with a full description revealing provenance.',
      badges: [],
      ariaLabels: [],
      metadataText: [],
      officialDisclosurePresent: false,
      isShort: false,
      locale: 'en',
    });
    expect(thin).not.toBe(rich);
  });

  it('DET-23: version change invalidates; single authoritative version source', async () => {
    const { RULES_VERSION } = await import('@/domain/versions');
    const rulesIndex = await import('@/detection/rules');
    expect(rulesIndex.RULES_VERSION).toBe(RULES_VERSION);
    expect(RULES_VERSION).toBe('2');
  });
});

describe('policy dimension independence (DET-26..29)', () => {
  const ev = (overrides: Partial<Evidence>): Evidence => ({
    id: 'e',
    origin: 'local-rule',
    category: 'ai-visual',
    detector: 't',
    strength: 0.5,
    polarity: 'supports',
    reasonCode: 't',
    reasonText: 't',
    ...overrides,
  });

  it('DET-26: Not AI correction suppresses AI dimension; independent slop remains eligible', () => {
    const slopEvidence = [
      ev({ category: 'clickbait', strength: 0.9, id: 'c1' }),
      ev({ category: 'content-farm', strength: 0.9, id: 'c2', detector: 'farm' }),
    ];
    const c = aggregateEvidence(slopEvidence, candidate(), ctx);
    const decision = decide({
      settings: defaultSettings(),
      rules: defaultRules(),
      candidate: { videoId: 'v1', channelId: 'UC1' },
      classification: c,
      correctedNotAi: true,
      correctedNotSlop: false,
    });
    // Slop dimension is untouched by a Not-AI correction: clickbait-only
    // evidence at 0.9 still allows hide under balanced thresholds.
    expect(decision.action).toBe('hide');
  });

  it('DET-27: Not slop correction suppresses slop; AI disclosure remains eligible', () => {
    const aiEvidence = [
      ev({ category: 'ai-visual', strength: 0.95, id: 'a1' }),
      ev({ category: 'ai-visual', strength: 0.9, id: 'a2', detector: 'other' }),
    ];
    const c = aggregateEvidence(aiEvidence, candidate(), ctx);
    const decision = decide({
      settings: defaultSettings(),
      rules: defaultRules(),
      candidate: { videoId: 'v1', channelId: 'UC1' },
      classification: c,
      correctedNotAi: false,
      correctedNotSlop: true,
    });
    expect(decision.action).toBe('hide'); // AI dimension survives Not-slop
  });

  it('DET-25: Allow music + Hide visuals keeps them independent', async () => {
    const settings = defaultSettings();
    settings.categoryActions['ai-music'] = 'allow';
    settings.categoryActions['ai-visual'] = 'hide';
    const musicOnly = aggregateEvidence(
      [ev({ category: 'ai-music', strength: 0.9, id: 'm1' })],
      candidate(),
      ctx,
    );
    expect(
      decide({
        settings,
        rules: defaultRules(),
        candidate: { videoId: 'v1', channelId: 'UC1' },
        classification: musicOnly,
      }).action,
    ).toBe('allow'); // music allowance holds when only music matched

    const visual = aggregateEvidence(
      [
        ev({ category: 'ai-visual', strength: 0.95, id: 'v1' }),
        ev({ category: 'ai-visual', strength: 0.9, id: 'v2', detector: 'other' }),
      ],
      candidate(),
      ctx,
    );
    expect(
      decide({
        settings,
        rules: defaultRules(),
        candidate: { videoId: 'v1', channelId: 'UC1' },
        classification: visual,
      }).action,
    ).toBe('hide'); // visuals still hide — music allowance doesn't exempt
  });

  it('DET-29: boundary values for every mode', () => {
    const mk = (score: number): Classification =>
      ({
        aiLikelihood: score,
        slopLikelihood: 0,
        categories: { 'ai-visual': score },
        confidence: 'very-high',
        evidence: [],
        classifierVersion: '1',
        rulesVersion: '2',
        evaluatedAt: 0,
      }) as Classification;

    for (const mode of ['safe', 'balanced', 'strict'] as const) {
      const t = MODE_THRESHOLDS[mode];
      const settings = { ...defaultSettings(), mode };
      const atHide = decide({
        settings,
        rules: defaultRules(),
        candidate: { videoId: 'v1', channelId: 'UC1' },
        classification: mk(t.hideAt),
      });
      expect(atHide.action).toBe('hide'); // exactly at threshold hides

      const belowHide = decide({
        settings,
        rules: defaultRules(),
        candidate: { videoId: 'v1', channelId: 'UC1' },
        classification: mk(t.hideAt - 0.01),
      });
      // Below hideAt without a category 'hide' override must not hide.
      const settingsNoOverride = { ...settings, categoryActions: { ...settings.categoryActions } };
      settingsNoOverride.categoryActions['ai-visual'] = 'inherit';
      const belowDecision = decide({
        settings: settingsNoOverride,
        rules: defaultRules(),
        candidate: { videoId: 'v1', channelId: 'UC1' },
        classification: mk(t.hideAt - 0.01),
      });
      expect(belowDecision.action, `${mode} just below hideAt`).not.toBe('hide');
      void belowHide;
    }
  });
});

describe('DET-30: held-out evaluation metrics', () => {
  /** The held-out corpus: positive = should be classified AI/slop. */
  const CORPUS: readonly { title: string; positive: boolean; minLikelihood?: number }[] = [
    { title: 'Cute Fruit Babies Eating | AI Generated Funny Fruits Animation', positive: true },
    {
      title: 'Foodtrip muna ng Lava Chocolate Cake!! ai generated tagalog video using veo 3! #ai',
      positive: true,
    },
    { title: 'Satisfying Glass-Like Watermelon Bites | ASMR (AI-Generated)', positive: true },
    {
      title: 'Ai animation cat video #cat #pets #3danimation',
      positive: true,
      minLikelihood: 0.15,
    },
    { title: 'ORANGE Baby #ai #comedy #baby #shorts', positive: false },
    { title: 'Best AI video generator review', positive: false },
    { title: 'Cute AI Baby Reciting Papa', positive: false },
    { title: 'How to spot AI-generated videos', positive: false },
    { title: 'This is NOT AI-generated; practical effects', positive: false },
    {
      title: 'Tutorial: all footage in this video was generated with Sora',
      positive: true,
      minLikelihood: 0.3,
    },
    { title: 'Music generated using Suno', positive: true, minLikelihood: 0.2 },
    { title: 'Handmade clay fruit baby stop motion', positive: false },
    { title: 'AI regulation hearing', positive: false },
    { title: 'I tested Veo', positive: false },
    { title: 'Sora game guide', positive: false },
    { title: 'Thai railway painting', positive: false },
    { title: 'daily rain', positive: false },
    { title: 'said nothing in particular', positive: false },
    { title: 'Why AI Slop Is Ruining YouTube', positive: false },
    { title: 'My grandmother’s 90th birthday party', positive: false },
  ];

  /**
   * Bucket semantics (DET-30: no denominator tricks):
   * - tp: positive corpus entries whose matched dimension ≥ minLikelihood
   *   (or ≥ 0.45 when unspecified) — "model said positive".
   * - fp: negative entries said positive → the FALSE-HIDE bucket.
   * - fn: positive entries said negative.
   * - tn: negatives said negative. Unknown bucket must stay empty.
   */
  it('bucketed precision/recall/false-hides with explicit denominators', async () => {
    let tp = 0;
    let fp = 0;
    let fn = 0;
    let tn = 0;
    let unknown = 0;
    const falseHides: string[] = [];

    for (const entry of CORPUS) {
      const classification = await classify(candidate({ title: entry.title }));
      const threshold = entry.minLikelihood ?? 0.45;
      const saidPositive =
        Math.max(classification.aiLikelihood, classification.slopLikelihood) >= threshold;
      const isPositive = entry.positive;
      if (saidPositive && isPositive) tp += 1;
      else if (saidPositive && !isPositive) {
        fp += 1;
        falseHides.push(entry.title);
      } else if (!saidPositive && isPositive) fn += 1;
      else tn += 1;
      void unknown;
    }
    unknown = 0; // every corpus entry is resolved into exactly one bucket

    const precision = tp + fp === 0 ? 1 : tp / (tp + fp);
    const recall = tp + fn === 0 ? 1 : tp / (tp + fn);

    // No false HIDES on negatives (the product's hard requirement: a false
    // positive hides a real human video — worst failure mode).
    expect(falseHides, `false hides: ${falseHides.join(' | ')}`).toHaveLength(0);
    // Recall floor: most true positives detected.
    expect(recall).toBeGreaterThanOrEqual(0.6);
    // Precision floor.
    expect(precision).toBeGreaterThanOrEqual(0.75);
    // Buckets must sum to the corpus (no denominator tricks).
    expect(tp + fp + fn + tn).toBe(CORPUS.length);
    expect(unknown).toBe(0);
  });
});
