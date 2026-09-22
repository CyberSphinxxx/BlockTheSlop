import type { CommunityFeedback } from '@/domain/feedback';

export interface VideoReputation {
  aiLikelihood: number;
  slopLikelihood: number;
  /** Sample size backing this reputation value. */
  sampleSize: number;
}

export interface ChannelReputation {
  aiPrior: number;
  sampleSize: number;
}

export type ProviderHealth = 'unknown' | 'healthy' | 'degraded' | 'down';

/**
 * Remote/community reputation provider contract (ARCHITECTURE.md §11).
 *
 * Implementations MUST: fail to `null` (unknown) rather than block, apply
 * timeouts and abort signals, validate response schemas strictly, cache with
 * TTL, and never execute returned data. The core extension never requires a
 * provider; this is an optional, default-OFF feature.
 */
export interface ReputationProvider {
  getVideoReputation(videoId: string): Promise<VideoReputation | null>;
  getChannelReputation(channelId: string): Promise<ChannelReputation | null>;
  submitFeedback?(feedback: CommunityFeedback): Promise<void>;
  healthCheck?(): Promise<ProviderHealth>;
}

/** The default provider: does nothing, reports unknown, never blocks. */
export const disabledProvider: ReputationProvider = {
  async getVideoReputation(): Promise<null> {
    return null;
  },
  async getChannelReputation(): Promise<null> {
    return null;
  },
};
