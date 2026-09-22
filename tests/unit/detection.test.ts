import { describe, expect, it } from 'vitest';
import { aggregateEvidence, classifyCandidate } from '@/detection/engine';
import { explainClassification } from '@/detection/explain';
import { officialDisclosureDetector } from '@/detection/detectors/official-disclosure';
import { aiDiscussionDetector } from '@/detection/detectors/ai-discussion';
import { contentFarmDetector } from '@/detection/detectors/content-farm';
import { rulesForLocale, matchRules } from '@/detection/rules';
import type { Evidence, EvidenceCategory } from '@/domain/evidence';
import type { NormalizedVideoCandidate } from '@/domain/video';
import { matchRule } from '@/detection/rules/types';

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

function ev(overrides: Partial<Evidence> = {}): Evidence {
  return {
    id: 'e1',
    origin: 'local-rule',
    category: 'ai-visual',
    detector: 'test',
    strength: 0.5,
    polarity: 'supports',
    reasonCode: 'test',
    reasonText: 'test reason',
    ...overrides,
  };
}

const emptyContext = {};

/** Helper: run a detector synchronously (all built-in detectors are sync). */
function syncDetect(
  detector: {
    detect(c: NormalizedVideoCandidate, ctx: typeof emptyContext): Evidence[] | Promise<Evidence[]>;
  },
  c: NormalizedVideoCandidate,
  ctx: typeof emptyContext = emptyContext,
): Evidence[] {
  const result = detector.detect(c, ctx);
  return Array.isArray(result) ? result : [];
}

function closeParens(code: string): string {
  void code;
  return code;
}
void closeParens;

describe('rule matching safety', () => {
  const rules = rulesForLocale('en');

  it('never matches raw "ai" substrings inside words', () => {
    expect(matchRule(rules[0]!, 'main street food tour', undefined)).toBe(false);
    // Run every rule against words containing "ai" as substring.
    const tricky = [
      'Sailing the main coast',
      'David repairs chairs',
      'A fair day in Spain',
      'Brain training',
    ];
    for (const rule of rules) {
      for (const title of tricky) {
        expect(matchRule(rule, title, undefined)).toBe(false);
      }
    }
  });

  it('does not match product names containing AI-adjacent letters', () => {
    const title = 'Painting a chair with milk paint';
    for (const rule of rules) {
      expect(matchRule(rule, title, undefined)).toBe(false);
    }
  });

  it('matches explicit creator disclosure phrases', () => {
    expect(matchRules(rules, 'I made this film with AI', undefined).length).toBeGreaterThan(0);
    expect(
      matchRules(rules, '', 'This video was generated using Veo and Sora.').length,
    ).toBeGreaterThan(0);
  });
});

describe('official disclosure detector', () => {
  it('produces strong AI evidence', () => {
    const evidence: Evidence[] = syncDetect(
      officialDisclosureDetector,
      candidate({ officialDisclosure: { present: true, text: 'Altered or synthetic content' } }),
      emptyContext,
    );
    expect(evidence).toHaveLength(1);
    expect(evidence[0]?.strength).toBeGreaterThanOrEqual(0.8);
    expect(evidence[0]?.polarity).toBe('supports');
  });

  it('is neutral when disclosure is missing', () => {
    expect(syncDetect(officialDisclosureDetector, candidate(), emptyContext)).toHaveLength(0);
  });

  it('disclosure alone does not produce a high slop score', () => {
    const classification = classifyCandidateSync(
      candidate({ officialDisclosure: { present: true, text: 'Altered or synthetic content' } }),
    );
    expect(classification.aiLikelihood).toBeGreaterThan(0.6);
    expect(classification.slopLikelihood).toBeLessThan(0.5);
  });
});

function classifyCandidateSync(c: NormalizedVideoCandidate) {
  // Aggregate the disclosure detector only for determinism in this suite.
  const evidence = syncDetect(officialDisclosureDetector, c, {});
  return aggregateEvidence(evidence, c, {});
}

describe('AI discussion protection', () => {
  const discussionTitles = [
    'Why AI Slop Is Taking Over YouTube',
    'How AI Works',
    'AI regulation hearing concludes',
    'Gemini explained',
    'Sora tutorial for beginners',
    'I tested Sora for a month',
    'The dangers of artificial intelligence',
  ];

  it('opposing evidence is produced for discussion titles', () => {
    for (const title of discussionTitles) {
      const evidence: Evidence[] = syncDetect(
        aiDiscussionDetector,
        candidate({ title }),
        emptyContext,
      );
      expect(evidence.some((e) => e.polarity === 'opposes')).toBe(true);
    }
  });

  it('a keyword match plus discussion context cannot reach very-high confidence', () => {
    const evidence: Evidence[] = [
      ev({ category: 'ai-visual', strength: 0.45 }),
      {
        id: 'd1',
        origin: 'local-rule',
        category: 'ai-discussion',
        detector: 'ai-discussion',
        strength: 0.6,
        polarity: 'opposes',
        reasonCode: 'discussion',
        reasonText: 'discussion',
      },
    ];
    const classification = aggregateEvidence(evidence, candidate(), emptyContext);
    expect(classification.confidence).not.toBe('very-high');
    expect(classification.aiLikelihood).toBeLessThan(0.4);
  });
});

describe('content-farm heuristics', () => {
  it('never produces high confidence alone', () => {
    const evidence: Evidence[] = syncDetect(
      contentFarmDetector,
      candidate({
        title: '🔥🔥🔥 You won’t believe number 7 😱😱',
        metadataText: ['1,000 views', '5 minutes ago'],
        channel: {},
      }),
      emptyContext,
    );
    const classification = aggregateEvidence(evidence, candidate(), emptyContext);
    expect(classification.confidence).not.toBe('very-high');
    expect(classification.confidence).not.toBe('high');
  });

  it('a single weak marker produces no evidence', () => {
    const evidence: Evidence[] = syncDetect(
      contentFarmDetector,
      candidate({ title: '🔥 one emoji only' }),
      emptyContext,
    );
    expect(evidence).toHaveLength(0);
  });
});

describe('aggregation', () => {
  it('keeps ai and slop likelihoods independent', () => {
    const slopOnly = aggregateEvidence(
      [ev({ category: 'clickbait', strength: 0.6 })],
      candidate(),
      emptyContext,
    );
    expect(slopOnly.slopLikelihood).toBeGreaterThan(0.2);
    expect(slopOnly.aiLikelihood).toBe(0);

    const aiOnly = aggregateEvidence(
      [ev({ category: 'ai-visual', strength: 0.6 })],
      candidate(),
      emptyContext,
    );
    expect(aiOnly.aiLikelihood).toBeGreaterThan(0.2);
    expect(aiOnly.slopLikelihood).toBe(0);
  });

  it('diverse origins raise confidence more than repeated same-origin matches', () => {
    const sameOrigin = aggregateEvidence(
      [ev({ strength: 0.5 }), ev({ id: 'e2', strength: 0.5 }), ev({ id: 'e3', strength: 0.5 })],
      candidate(),
      emptyContext,
    );
    const diverse = aggregateEvidence(
      [
        ev({ strength: 0.5 }),
        ev({ id: 'e2', origin: 'first-party', detector: 'disclosure', strength: 0.5 }),
        ev({ id: 'e3', detector: 'other', strength: 0.5 }),
      ],
      candidate(),
      emptyContext,
    );
    expect(diverse.confidence).toBe('very-high');
    expect(sameOrigin.confidence).not.toBe('very-high');
  });

  it('contradictory evidence lowers confidence', () => {
    const withoutContradiction = aggregateEvidence(
      [
        ev({ strength: 0.9 }),
        ev({ id: 'e2', origin: 'first-party', detector: 'disclosure', strength: 0.9 }),
      ],
      candidate(),
      emptyContext,
    );
    const withContradiction = aggregateEvidence(
      [
        ev({ strength: 0.9 }),
        ev({ id: 'e2', origin: 'first-party', detector: 'disclosure', strength: 0.9 }),
        {
          ...ev({ id: 'e3' }),
          category: 'ai-discussion' as EvidenceCategory,
          polarity: 'opposes' as const,
          strength: 0.6,
        },
      ],
      candidate(),
      emptyContext,
    );
    expect(withoutContradiction.confidence).toBe('very-high');
    expect(withContradiction.confidence).not.toBe('very-high');
  });

  it('channel reputation alone cannot be very-high', () => {
    const classification = aggregateEvidence(
      [ev({ detector: 'channel-reputation', origin: 'community', strength: 0.9 })],
      candidate(),
      emptyContext,
    );
    expect(classification.confidence).not.toBe('very-high');
  });
});

describe('explanations', () => {
  it('always yields at least one human-readable line', () => {
    const classification = aggregateEvidence([], candidate(), emptyContext);
    const lines = explainClassification(classification);
    expect(lines.length).toBeGreaterThan(0);
  });

  it('uses hedged language for weak evidence', () => {
    const classification = aggregateEvidence([ev({ strength: 0.3 })], candidate(), emptyContext);
    const lines = explainClassification(classification);
    expect(lines.join(' ')).toMatch(/heuristic|may be wrong/i);
  });

  it('reports likely AI for strong disclosure', () => {
    const classification = classifyCandidateSync(
      candidate({ officialDisclosure: { present: true, text: 'Altered or synthetic content' } }),
    );
    const lines = explainClassification(classification);
    expect(lines[0]).toBe('Likely AI-generated');
    expect(lines.join(' ')).toContain('YouTube labels this video');
  });
});

describe('end-to-end classifyCandidate', () => {
  it('classifies a disclosure card as likely AI', async () => {
    const classification = await classifyCandidate(
      candidate({
        title: 'The fall of Rome, retold',
        officialDisclosure: { present: true, text: 'Altered or synthetic content' },
      }),
      emptyContext,
    );
    expect(classification.aiLikelihood).toBeGreaterThan(0.6);
    expect(classification.evidence.length).toBeGreaterThan(0);
  });

  it('classifies an AI discussion video as low likelihood', async () => {
    const classification = await classifyCandidate(
      candidate({ title: 'Why AI Slop Is Ruining YouTube' }),
      emptyContext,
    );
    expect(classification.aiLikelihood).toBeLessThan(0.3);
    expect(classification.confidence).toBe('low');
  });

  it('survives a detector that throws', async () => {
    const explodingDetector = {
      id: 'explodes',
      detect(): Evidence[] {
        throw new Error('detector exploded');
      },
    };
    const classification = await classifyCandidate(candidate(), emptyContext, [explodingDetector]);
    expect(classification.aiLikelihood).toBe(0);
  });
});
