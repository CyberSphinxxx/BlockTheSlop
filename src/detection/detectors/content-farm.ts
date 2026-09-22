import type { Evidence } from '@/domain/evidence';
import type { NormalizedVideoCandidate } from '@/domain/video';
import type { DetectionContext } from '@/domain/evidence';
import type { Detector } from '../engine';

/**
 * Conservative content-farm heuristics (DETECTION_ENGINE.md §3; audit R14).
 *
 * STRUCTURAL TEXT signals only. The previous "upload cadence" and "missing
 * channel identity" markers were fabricated inferences (DET-18: a brand-new
 * channel with an emoji title is not evidence of a farm) and were removed.
 * Multiple weak textual markers must accumulate to even reach medium evidence;
 * a single marker never produces a hide-worthy signal.
 */
export const contentFarmDetector: Detector = {
  id: 'content-farm',
  detect(candidate: NormalizedVideoCandidate, _context: DetectionContext): Evidence[] {
    const evidence: Evidence[] = [];
    let markers = 0;
    const reasons: string[] = [];

    // Marker 1: templated emoji-heavy titles typical of mass-produced content.
    const emojiCount = (candidate.title.match(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu) ?? [])
      .length;
    if (emojiCount >= 3) {
      markers += 1;
      reasons.push('The title uses repeated emoji decoration common in mass-produced content.');
    }

    // Marker 2: templated punctuation/shouting structure ("!!!" + ALL-CAPS
    // words) — a textual pattern, independent of emojis.
    const shoutyWords = (candidate.title.match(/\b[A-Z]{4,}\b/g) ?? []).length;
    const bangs = (candidate.title.match(/!{2,}/g) ?? []).length;
    if (bangs >= 2 || (shoutyWords >= 2 && bangs >= 1)) {
      markers += 1;
      reasons.push('The title follows templated shouting punctuation patterns.');
    }

    // Marker 3: listicle/compilation templating with counts in the title.
    if (/\b(top\s+\d+|\d+\s+(facts|things|moments|compilation))\b/i.test(candidate.title)) {
      markers += 1;
      reasons.push('The title follows templated listicle/compilation patterns.');
    }

    // Only emit evidence when several weak markers accumulate.
    if (markers >= 2) {
      evidence.push({
        id: 'farm:markers',
        origin: 'local-rule',
        category: 'content-farm',
        detector: 'content-farm',
        strength: Math.min(0.2 + markers * 0.1, 0.5),
        polarity: 'supports',
        reasonCode: 'content-farm-markers',
        reasonText: `Suspected automated content: ${reasons.slice(0, 2).join(' ')}`,
        sourceKind: 'title',
        matchedField: 'title',
        claimScope: 'unspecified-generation',
        correlationKey: 'farm:structural',
      });
    }

    return evidence;
  },
};
