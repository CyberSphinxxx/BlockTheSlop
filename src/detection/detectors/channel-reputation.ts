import type { Evidence } from '@/domain/evidence';
import type { NormalizedVideoCandidate } from '@/domain/video';
import type { DetectionContext } from '@/domain/evidence';
import type { Detector } from '../engine';

/**
 * Channel reputation detector.
 *
 * Reputation is context, never proof for every video (AGENTS.md §9). It
 * produces medium contextual evidence that scales with sample size, and it
 * must not single-handedly create the highest confidence — the aggregator
 * caps origin weight accordingly.
 */
export const channelReputationDetector: Detector = {
  id: 'channel-reputation',
  detect(candidate: NormalizedVideoCandidate, context: DetectionContext): Evidence[] {
    const reputation = context.channelReputation;
    if (!reputation || reputation.sampleSize < 3) return [];

    // Negatively associated channels (prior near 0) provide opposing evidence.
    const supports = reputation.aiPrior >= 0.5;
    const strength =
      Math.min(0.6, 0.3 + reputation.sampleSize * 0.05) * Math.abs(reputation.aiPrior - 0.5) * 2;

    const name = candidate.channel.displayName ?? candidate.channel.handle ?? 'This channel';
    return [
      {
        id: `reputation:${candidate.channel.channelId ?? candidate.channel.handle ?? 'unknown'}`,
        origin: reputation.origin,
        category: reputation.aiPrior >= 0.5 ? 'ai-visual' : 'ai-discussion',
        detector: 'channel-reputation',
        strength,
        polarity: supports ? 'supports' : 'opposes',
        reasonCode: 'channel-reputation-prior',
        reasonText: supports
          ? `${name} recently published content that was confirmed to be AI-generated.`
          : `${name} recently published content that was confirmed to be human-made.`,
      },
    ];
  },
};
