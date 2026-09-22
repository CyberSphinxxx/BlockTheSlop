import type { Evidence } from '@/domain/evidence';
import type { NormalizedVideoCandidate } from '@/domain/video';
import type { DetectionContext } from '@/domain/evidence';
import type { Detector } from '../engine';

/**
 * Contextual hashtag/generation-phrase detector (audit R14; DET-04/05/07).
 *
 * A bare "#ai" hashtag is AMBIENT CONTEXT, not provenance: it must never, in
 * any mode, push a video past hide thresholds on its own (DET-05). Combined
 * with generation-adjacent phrasing it becomes an honest, still-contextual
 * signal (DET-04: "Ai animation cat video #cat #pets #3danimation") —
 * without ever claiming pixel-level analysis.
 */
const BARE_AI_TAGS = /(?:^|\s)#(?:ai|a\.i\.?|artificialintelligence)(?=\s|$)/gi;

const GENERATION_CONTEXT =
  /\b(animation|animated|video|shorts?|film|voice|song|music|art|story)\b/i;

const FARM_TAGS = /(?:^|\s)#(?:shorts|fyp|foryou|viral|trending)(?=\s|$)/gi;

export const hashtagContextDetector: Detector = {
  id: 'hashtag-context',
  detect(candidate: NormalizedVideoCandidate, _context: DetectionContext): Evidence[] {
    const haystack = `${candidate.title} ${candidate.description ?? ''}`;
    const aiTags = (haystack.match(BARE_AI_TAGS) ?? []).length;

    if (aiTags === 0) return [];

    const generationWord = GENERATION_CONTEXT.test(haystack);
    const farmTags = (haystack.match(FARM_TAGS) ?? []).length;

    // Bare tag alone: honest weak context — capped well below hide territory.
    let strength = 0.18;
    let reason =
      'The text carries an #ai hashtag, which is context only and not proof of generated content.';

    // Tag + generation-adjacent wording: a real contextual signal, still
    // hedged (no pixel claims).
    if (generationWord) {
      strength = 0.4;
      reason =
        'The text combines an #ai hashtag with generation-adjacent wording, suggesting possible AI-generated content.';
    }
    // Farm-tag pile-ons (multiple spam tags) nudge toward slop, not AI proof.
    if (farmTags >= 2 && !generationWord) {
      strength = 0.22;
      reason =
        'The text pairs an #ai hashtag with spam-tag patterns common in mass-produced uploads.';
    }

    return [
      {
        id: 'hashtags:ai-context',
        origin: 'local-rule',
        category: generationWord ? 'ai-visual' : 'ai-unspecified',
        detector: 'hashtag-context',
        strength,
        polarity: 'supports',
        reasonCode: 'hashtag-ai-context',
        reasonText: reason,
        matchedField: candidate.title.match(BARE_AI_TAGS) ? 'title' : 'description',
        matchedExcerpt: (haystack.match(BARE_AI_TAGS) ?? ['#ai'])[0] ?? '#ai',
        claimScope: 'unspecified-generation',
        correlationKey: 'context:ai-hashtag',
      },
    ];
  },
};
