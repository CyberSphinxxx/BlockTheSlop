import type { Evidence } from '@/domain/evidence';
import type { NormalizedVideoCandidate } from '@/domain/video';
import type { DetectionContext } from '@/domain/evidence';
import type { Detector } from '../engine';

/**
 * Official YouTube disclosure detector.
 *
 * First-party "altered or synthetic content" labels are the strongest
 * available AI evidence. Per spec (DET-19): the label declares generation
 * with UNSPECIFIED modality — it must not prove generated visuals, music,
 * or low quality on its own. The dedicated `ai-unspecified` category carries
 * this claim; whole-video AI likelihood from it is capped in aggregation.
 */
export const officialDisclosureDetector: Detector = {
  id: 'official-disclosure',
  detect(candidate: NormalizedVideoCandidate, _context: DetectionContext): Evidence[] {
    if (!candidate.officialDisclosure?.present) return [];
    return [
      {
        id: 'disclosure:yt-badge',
        origin: 'first-party',
        category: 'ai-unspecified',
        detector: 'official-disclosure',
        strength: 0.9,
        polarity: 'supports',
        reasonCode: 'yt-altered-synthetic-label',
        reasonText: 'YouTube labels this video as containing altered or synthetic content.',
        sourceKind: 'badge',
        matchedField: 'badge',
        matchedExcerpt: candidate.officialDisclosure.text?.slice(0, 120),
        claimScope: 'unspecified-generation',
        correlationKey: 'disclosure:official',
      },
    ];
  },
};
