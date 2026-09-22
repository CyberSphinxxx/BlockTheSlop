import type { EvidenceCategory } from './evidence';

/**
 * Feedback payload sent to a remote reputation provider, only when the user
 * has explicitly enabled the provider AND submitting feedback. Contains the
 * minimum identifiers required by the provider contract — never page content,
 * history, cookies, or account identity.
 */
export interface CommunityFeedback {
  kind: 'confirm-ai' | 'not-ai' | 'confirm-slop' | 'not-slop';
  videoId: string;
  channelId?: string | undefined;
  category?: EvidenceCategory | undefined;
  submittedAt: number;
}
