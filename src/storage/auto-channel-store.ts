import {
  type AutoChannelBlockEntry,
  type AutoChannelState,
  cleanAutoChannelState,
  defaultAutoChannelState,
  isCanonicalChannelId,
  isQualifyingAiVideo,
  countRecentPromotions,
  AUTO_CHANNEL_DEFAULT_TTL_MS,
  AUTO_CHANNEL_MIN_DISTINCT_VIDEOS,
} from '@/domain/auto-channel';
import type { Classification } from '@/domain/classification';
import type { UserRules } from '@/domain/rules';
import type { UserSettings } from '@/domain/settings';
import type { KVStore } from './db';
import { STORAGE_KEYS } from './keys';

export class AutoChannelStore {
  private mutationQueue: Promise<unknown> = Promise.resolve();

  constructor(private readonly kv: KVStore) {}

  async load(): Promise<AutoChannelState> {
    const raw = await this.kv.get<unknown>(STORAGE_KEYS.autoChannel);
    if (raw === undefined) return defaultAutoChannelState();
    return cleanAutoChannelState(raw);
  }

  async save(state: AutoChannelState): Promise<void> {
    await this.kv.set(STORAGE_KEYS.autoChannel, cleanAutoChannelState(state));
  }

  /**
   * Return a set of channel IDs that currently have an active automatic block.
   */
  async getActiveBlockedChannelIds(now = Date.now()): Promise<Set<string>> {
    const state = await this.load();
    const active = new Set<string>();
    for (const [id, entry] of Object.entries(state.entries)) {
      if (entry.status === 'active' && entry.expiresAt > now) {
        active.add(id);
      }
    }
    return active;
  }

  /**
   * Record a video observation for a channel and evaluate for suggestion or auto-promotion (V5-08).
   *
   * Constraints:
   * - Must have canonical UC... channel ID.
   * - Cannot be an explicit user allow/block rule.
   * - Classification must represent strong video-production AI evidence (isQualifyingAiVideo).
   * - Avoids feedback loops: cannot count a video already hidden due to channel block.
   * - Deduplicates: repeated sightings of the same video ID do NOT increment count.
   * - If threshold is met:
   *   - If autoChannel.enabled && daily cap not exceeded -> promotes to 'active'.
   *   - Else -> records as 'suggested'.
   */
  async recordCandidateVideo(options: {
    channelId?: string | undefined;
    handle?: string | undefined;
    displayName?: string | undefined;
    videoId?: string | undefined;
    classification?: Classification | undefined;
    settings: UserSettings;
    rules: UserRules;
    now?: number | undefined;
  }): Promise<{
    promoted: boolean;
    suggested: boolean;
    entry?: AutoChannelBlockEntry | undefined;
  }> {
    const now = options.now ?? Date.now();
    const channelId = options.channelId;
    const videoId = options.videoId;

    // 1. Must have canonical channel ID and video ID
    if (!channelId || !isCanonicalChannelId(channelId) || !videoId) {
      return { promoted: false, suggested: false };
    }

    // 2. Reject if explicitly allowed or blocked by user
    if (
      options.rules.allowedChannelIds.includes(channelId) ||
      options.rules.blockedChannelIds.includes(channelId) ||
      options.rules.allowedVideoIds.includes(videoId) ||
      options.rules.blockedVideoIds.includes(videoId)
    ) {
      return { promoted: false, suggested: false };
    }

    // 3. Must be strong video-production AI evidence
    if (!isQualifyingAiVideo(options.classification)) {
      return { promoted: false, suggested: false };
    }

    const run = async (): Promise<{
      promoted: boolean;
      suggested: boolean;
      entry?: AutoChannelBlockEntry | undefined;
    }> => {
      const state = await this.load();

      // Clean expired
      this.sweepExpiredInternal(state, now);

      let entry = state.entries[channelId];
      if (!entry) {
        entry = {
          channelId,
          handle: options.handle,
          displayName: options.displayName,
          qualifyingVideoIds: [videoId],
          evidenceCategories: options.classification!.evidence.map((e) => e.category),
          recordedAt: now,
          expiresAt: now + AUTO_CHANNEL_DEFAULT_TTL_MS,
          status: 'candidate',
        };
        state.entries[channelId] = entry;
      } else {
        // If already revoked by user, do not resurrect automatically
        if (entry.status === 'revoked') {
          return { promoted: false, suggested: false, entry };
        }

        // Distinct video check (no repeated sightings count as new evidence)
        if (!entry.qualifyingVideoIds.includes(videoId)) {
          entry.qualifyingVideoIds.push(videoId);
          // Union new evidence categories
          for (const ev of options.classification!.evidence) {
            if (!entry.evidenceCategories.includes(ev.category)) {
              entry.evidenceCategories.push(ev.category);
            }
          }
        }
        if (options.displayName && !entry.displayName) {
          entry.displayName = options.displayName;
        }
        if (options.handle && !entry.handle) {
          entry.handle = options.handle;
        }
      }

      const minVideos =
        options.settings.autoChannel?.minDistinctVideos ?? AUTO_CHANNEL_MIN_DISTINCT_VIDEOS;
      const meetsThreshold = entry.qualifyingVideoIds.length >= minVideos;

      let promoted = false;
      let suggested = false;

      if (meetsThreshold) {
        const autoChannelEnabled = options.settings.autoChannel?.enabled ?? false;
        const maxPerDay = options.settings.autoChannel?.maxPromotionsPerDay ?? 5;
        const recentCount = countRecentPromotions(state.promotionTimestamps, now);

        if (autoChannelEnabled && recentCount < maxPerDay) {
          if (entry.status !== 'active') {
            entry.status = 'active';
            entry.recordedAt = now;
            entry.expiresAt = now + AUTO_CHANNEL_DEFAULT_TTL_MS;
            entry.reason = `Auto-blocked: ${entry.qualifyingVideoIds.length} qualifying AI videos detected`;
            state.promotionTimestamps.push(now);
            promoted = true;
          }
        } else {
          // If autoChannel is disabled or cap reached, keep as suggested
          if (entry.status !== 'active') {
            entry.status = 'suggested';
            entry.reason = `Suggested: ${entry.qualifyingVideoIds.length} qualifying AI videos detected`;
            suggested = true;
          }
        }
      }

      await this.save(state);
      return { promoted, suggested, entry };
    };

    const nextPromise = this.mutationQueue.then(run, run);
    this.mutationQueue = nextPromise.catch(() => {});
    return nextPromise;
  }

  /**
   * Demote / revoke automatic block on a channel (one-action Undo or user choice).
   */
  async revoke(channelId: string, reason = 'Manually revoked by user'): Promise<boolean> {
    const run = async (): Promise<boolean> => {
      const state = await this.load();
      const entry = state.entries[channelId];
      if (!entry) return false;

      entry.status = 'revoked';
      entry.reason = reason;
      await this.save(state);
      return true;
    };

    const nextPromise = this.mutationQueue.then(run, run);
    this.mutationQueue = nextPromise.catch(() => {});
    return nextPromise;
  }

  /**
   * Manually promote a suggested channel to an active user rule or active auto-block.
   */
  async promoteSuggestion(channelId: string): Promise<boolean> {
    const run = async (): Promise<boolean> => {
      const state = await this.load();
      const entry = state.entries[channelId];
      if (!entry) return false;

      entry.status = 'active';
      entry.recordedAt = Date.now();
      entry.expiresAt = Date.now() + AUTO_CHANNEL_DEFAULT_TTL_MS;
      entry.reason = 'Promoted from suggestion by user';
      await this.save(state);
      return true;
    };

    const nextPromise = this.mutationQueue.then(run, run);
    this.mutationQueue = nextPromise.catch(() => {});
    return nextPromise;
  }

  /**
   * When a user marks a video as Not AI (correction), revoke any auto-channel block
   * whose evidence relied on this video ID (V5-08).
   */
  async revokeForCorrection(videoId: string): Promise<string[]> {
    const run = async (): Promise<string[]> => {
      const state = await this.load();
      const revokedChannels: string[] = [];

      for (const [channelId, entry] of Object.entries(state.entries)) {
        if (entry.qualifyingVideoIds.includes(videoId)) {
          entry.status = 'revoked';
          entry.reason = `Revoked: video ${videoId} marked as Not AI by user`;
          revokedChannels.push(channelId);
        }
      }

      if (revokedChannels.length > 0) {
        await this.save(state);
      }
      return revokedChannels;
    };

    const nextPromise = this.mutationQueue.then(run, run);
    this.mutationQueue = nextPromise.catch(() => {});
    return nextPromise;
  }

  /**
   * Revoke auto-channel blocks when explicit user rules conflict (channel allow or video allow).
   */
  async revokeForRules(rules: UserRules): Promise<string[]> {
    const run = async (): Promise<string[]> => {
      const state = await this.load();
      const revokedChannels: string[] = [];

      for (const [channelId, entry] of Object.entries(state.entries)) {
        if (entry.status !== 'revoked') {
          // If channel is allowed
          if (rules.allowedChannelIds.includes(channelId)) {
            entry.status = 'revoked';
            entry.reason = 'Revoked: channel explicitly added to Allowlist';
            revokedChannels.push(channelId);
            continue;
          }
          // If any qualifying video is allowed
          if (entry.qualifyingVideoIds.some((vId) => rules.allowedVideoIds.includes(vId))) {
            entry.status = 'revoked';
            entry.reason = 'Revoked: qualifying video explicitly added to Allowlist';
            revokedChannels.push(channelId);
            continue;
          }
        }
      }

      if (revokedChannels.length > 0) {
        await this.save(state);
      }
      return revokedChannels;
    };

    const nextPromise = this.mutationQueue.then(run, run);
    this.mutationQueue = nextPromise.catch(() => {});
    return nextPromise;
  }

  /**
   * Purge expired entries and return number of entries swept.
   */
  async sweepExpired(now = Date.now()): Promise<number> {
    const run = async (): Promise<number> => {
      const state = await this.load();
      const swept = this.sweepExpiredInternal(state, now);
      if (swept > 0) {
        await this.save(state);
      }
      return swept;
    };

    const nextPromise = this.mutationQueue.then(run, run);
    this.mutationQueue = nextPromise.catch(() => {});
    return nextPromise;
  }

  private sweepExpiredInternal(state: AutoChannelState, now: number): number {
    let count = 0;
    for (const [key, entry] of Object.entries(state.entries)) {
      if (entry.expiresAt <= now) {
        delete state.entries[key];
        count++;
      }
    }
    // Clean old promotion timestamps (> 24h)
    state.promotionTimestamps = state.promotionTimestamps.filter((ts) => now - ts < 86_400_000);
    return count;
  }
}
