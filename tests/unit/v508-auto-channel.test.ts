import { describe, it, expect, beforeEach } from 'vitest';
import {
  isCanonicalChannelId,
  isQualifyingAiVideo,
  countRecentPromotions,
  defaultAutoChannelState,
} from '@/domain/auto-channel';
import { AutoChannelStore } from '@/storage/auto-channel-store';
import { MemoryKVStore } from '@/storage/db';
import { defaultSettings } from '@/domain/settings';
import { defaultRules } from '@/domain/rules';
import type { Classification } from '@/domain/classification';

import type { Evidence, EvidenceCategory } from '@/domain/evidence';

function makeEvidence(category: EvidenceCategory): Evidence {
  return {
    id: `ev-${category}`,
    origin: 'first-party',
    category,
    detector: 'test-detector',
    strength: 0.9,
    polarity: 'supports',
    reasonCode: `code-${category}`,
    reasonText: `Evidence text for ${category}`,
  };
}

function makeClassification(options: {
  aiLikelihood: number;
  slopLikelihood?: number;
  confidence: 'low' | 'medium' | 'high' | 'very-high';
  category: EvidenceCategory;
}): Classification {
  return {
    aiLikelihood: options.aiLikelihood,
    slopLikelihood: options.slopLikelihood ?? 0.1,
    categories: { [options.category]: options.aiLikelihood },
    confidence: options.confidence,
    evidence: [makeEvidence(options.category)],
    classifierVersion: '1.0',
    rulesVersion: '1.0',
    evaluatedAt: Date.now(),
  };
}

describe('V5-08 Auto-Channel Qualification Domain', () => {
  it('identifies canonical channel IDs (UC... >= 10 chars)', () => {
    expect(isCanonicalChannelId('UC1234567890')).toBe(true);
    expect(isCanonicalChannelId('UC_some_channel_id_here')).toBe(true);

    // Rejects invalid/non-canonical identities
    expect(isCanonicalChannelId('@creator_handle')).toBe(false);
    expect(isCanonicalChannelId('Creator Name')).toBe(false);
    expect(isCanonicalChannelId('UC123')).toBe(false); // too short
    expect(isCanonicalChannelId(undefined)).toBe(false);
    expect(isCanonicalChannelId('')).toBe(false);
  });

  it('qualifies strong video-production AI evidence', () => {
    const strongVisual = makeClassification({
      aiLikelihood: 0.85,
      confidence: 'high',
      category: 'ai-visual',
    });
    expect(isQualifyingAiVideo(strongVisual)).toBe(true);

    const strongVoice = makeClassification({
      aiLikelihood: 0.9,
      confidence: 'very-high',
      category: 'ai-voice',
    });
    expect(isQualifyingAiVideo(strongVoice)).toBe(true);

    const alteredDisclosure = makeClassification({
      aiLikelihood: 0.95,
      confidence: 'very-high',
      category: 'ai-unspecified',
    });
    expect(isQualifyingAiVideo(alteredDisclosure)).toBe(true);
  });

  it('rejects thumbnail-only, discussion-only, and slop-only evidence', () => {
    // Thumbnail-only
    const thumbOnly = makeClassification({
      aiLikelihood: 0.95,
      confidence: 'high',
      category: 'ai-thumbnail',
    });
    expect(isQualifyingAiVideo(thumbOnly)).toBe(false);

    // Discussion / education
    const discussionOnly = makeClassification({
      aiLikelihood: 0.9,
      confidence: 'high',
      category: 'ai-discussion',
    });
    expect(isQualifyingAiVideo(discussionOnly)).toBe(false);

    // Slop / clickbait only (no video-production AI)
    const slopOnly = makeClassification({
      aiLikelihood: 0.1,
      slopLikelihood: 0.95,
      confidence: 'high',
      category: 'clickbait',
    });
    expect(isQualifyingAiVideo(slopOnly)).toBe(false);
  });

  it('rejects low confidence or low likelihood (< 0.70)', () => {
    const lowLikelihood = makeClassification({
      aiLikelihood: 0.65,
      confidence: 'high',
      category: 'ai-voice',
    });
    expect(isQualifyingAiVideo(lowLikelihood)).toBe(false);

    const lowConfidence = makeClassification({
      aiLikelihood: 0.85,
      confidence: 'low',
      category: 'ai-voice',
    });
    expect(isQualifyingAiVideo(lowConfidence)).toBe(false);
  });

  it('counts rolling 24h promotions correctly', () => {
    const now = 1_000_000_000;
    const timestamps = [
      now - 10_000, // 10s ago (within 24h)
      now - 3_600_000, // 1h ago (within 24h)
      now - 86_399_000, // 23h 59m ago (within 24h)
      now - 86_401_000, // 24h 1s ago (outside 24h)
      now - 100_000_000, // old
    ];
    expect(countRecentPromotions(timestamps, now)).toBe(3);
  });
});

describe('V5-08 AutoChannelStore', () => {
  let kv: MemoryKVStore;
  let store: AutoChannelStore;
  const canonicalChannelId = 'UC1234567890abcdef';
  const qualClassification = makeClassification({
    aiLikelihood: 0.88,
    confidence: 'high',
    category: 'ai-voice',
  });

  beforeEach(() => {
    kv = new MemoryKVStore();
    store = new AutoChannelStore(kv);
  });

  it('rejects non-canonical channel IDs or missing video ID', async () => {
    const settings = defaultSettings();
    const rules = defaultRules();

    const nonCanonical = await store.recordCandidateVideo({
      channelId: '@somehandle',
      videoId: 'v1',
      classification: qualClassification,
      settings,
      rules,
    });
    expect(nonCanonical.promoted).toBe(false);
    expect(nonCanonical.suggested).toBe(false);

    const missingVideo = await store.recordCandidateVideo({
      channelId: canonicalChannelId,
      videoId: undefined,
      classification: qualClassification,
      settings,
      rules,
    });
    expect(missingVideo.promoted).toBe(false);
  });

  it('rejects explicitly allowed or blocked channels/videos', async () => {
    const settings = defaultSettings();
    const rules = {
      ...defaultRules(),
      allowedChannelIds: [canonicalChannelId],
    };

    const res = await store.recordCandidateVideo({
      channelId: canonicalChannelId,
      videoId: 'v1',
      classification: qualClassification,
      settings,
      rules,
    });
    expect(res.promoted).toBe(false);
    expect(res.suggested).toBe(false);
  });

  it('records distinct qualifying videos and deduplicates repeated sightings', async () => {
    const settings = defaultSettings(); // default OFF
    const rules = defaultRules();

    // Sighting 1: video 1
    const r1 = await store.recordCandidateVideo({
      channelId: canonicalChannelId,
      videoId: 'video-1',
      classification: qualClassification,
      settings,
      rules,
    });
    expect(r1.promoted).toBe(false);
    expect(r1.suggested).toBe(false); // only 1 video (threshold is 3)

    // Repeat sighting 100 times: should NOT increase count!
    for (let i = 0; i < 10; i++) {
      await store.recordCandidateVideo({
        channelId: canonicalChannelId,
        videoId: 'video-1',
        classification: qualClassification,
        settings,
        rules,
      });
    }

    const stateAfterRepeats = await store.load();
    expect(stateAfterRepeats.entries[canonicalChannelId]?.qualifyingVideoIds).toEqual(['video-1']);

    // Sighting 2: video 2
    const r2 = await store.recordCandidateVideo({
      channelId: canonicalChannelId,
      videoId: 'video-2',
      classification: qualClassification,
      settings,
      rules,
    });
    expect(r2.promoted).toBe(false);
    expect(r2.suggested).toBe(false); // 2 videos < 3

    // Sighting 3: video 3 -> threshold met! Default OFF creates suggestion
    const r3 = await store.recordCandidateVideo({
      channelId: canonicalChannelId,
      videoId: 'video-3',
      classification: qualClassification,
      settings,
      rules,
    });
    expect(r3.promoted).toBe(false);
    expect(r3.suggested).toBe(true);
    expect(r3.entry?.status).toBe('suggested');
    expect(r3.entry?.qualifyingVideoIds).toHaveLength(3);

    // Active auto channels should be empty because it is suggested, not active
    const activeIds = await store.getActiveBlockedChannelIds();
    expect(activeIds.has(canonicalChannelId)).toBe(false);
  });

  it('promotes to active automatic block when opt-in enabled and under cap', async () => {
    const settings = {
      ...defaultSettings(),
      autoChannel: {
        enabled: true,
        maxPromotionsPerDay: 5,
        minDistinctVideos: 3,
      },
    };
    const rules = defaultRules();

    await store.recordCandidateVideo({
      channelId: canonicalChannelId,
      videoId: 'v1',
      classification: qualClassification,
      settings,
      rules,
    });
    await store.recordCandidateVideo({
      channelId: canonicalChannelId,
      videoId: 'v2',
      classification: qualClassification,
      settings,
      rules,
    });
    const r3 = await store.recordCandidateVideo({
      channelId: canonicalChannelId,
      videoId: 'v3',
      classification: qualClassification,
      settings,
      rules,
    });

    expect(r3.promoted).toBe(true);
    expect(r3.entry?.status).toBe('active');

    const activeIds = await store.getActiveBlockedChannelIds();
    expect(activeIds.has(canonicalChannelId)).toBe(true);
  });

  it('enforces daily promotion cap and falls back to suggestion', async () => {
    const settings = {
      ...defaultSettings(),
      autoChannel: {
        enabled: true,
        maxPromotionsPerDay: 2, // cap at 2 per day
        minDistinctVideos: 1, // trigger at 1 for testing cap
      },
    };
    const rules = defaultRules();

    // Channel 1: promoted
    const c1 = await store.recordCandidateVideo({
      channelId: 'UC_channel_111111',
      videoId: 'v1',
      classification: qualClassification,
      settings,
      rules,
    });
    expect(c1.promoted).toBe(true);

    // Channel 2: promoted
    const c2 = await store.recordCandidateVideo({
      channelId: 'UC_channel_222222',
      videoId: 'v2',
      classification: qualClassification,
      settings,
      rules,
    });
    expect(c2.promoted).toBe(true);

    // Channel 3: cap reached! Should become suggested instead of active
    const c3 = await store.recordCandidateVideo({
      channelId: 'UC_channel_333333',
      videoId: 'v3',
      classification: qualClassification,
      settings,
      rules,
    });
    expect(c3.promoted).toBe(false);
    expect(c3.suggested).toBe(true);
    expect(c3.entry?.status).toBe('suggested');

    const active = await store.getActiveBlockedChannelIds();
    expect(active.has('UC_channel_111111')).toBe(true);
    expect(active.has('UC_channel_222222')).toBe(true);
    expect(active.has('UC_channel_333333')).toBe(false);
  });

  it('revokes automatic block when video is corrected as Not AI', async () => {
    const settings = {
      ...defaultSettings(),
      autoChannel: { enabled: true, maxPromotionsPerDay: 5, minDistinctVideos: 2 },
    };
    const rules = defaultRules();

    await store.recordCandidateVideo({
      channelId: canonicalChannelId,
      videoId: 'v1',
      classification: qualClassification,
      settings,
      rules,
    });
    await store.recordCandidateVideo({
      channelId: canonicalChannelId,
      videoId: 'v2',
      classification: qualClassification,
      settings,
      rules,
    });

    let active = await store.getActiveBlockedChannelIds();
    expect(active.has(canonicalChannelId)).toBe(true);

    // User marks v1 as Not AI
    const revoked = await store.revokeForCorrection('v1');
    expect(revoked).toContain(canonicalChannelId);

    active = await store.getActiveBlockedChannelIds();
    expect(active.has(canonicalChannelId)).toBe(false);

    const state = await store.load();
    expect(state.entries[canonicalChannelId]?.status).toBe('revoked');
  });

  it('revokes automatic block when channel or video is added to allowlist', async () => {
    const settings = {
      ...defaultSettings(),
      autoChannel: { enabled: true, maxPromotionsPerDay: 5, minDistinctVideos: 1 },
    };
    const rules = defaultRules();

    await store.recordCandidateVideo({
      channelId: canonicalChannelId,
      videoId: 'v1',
      classification: qualClassification,
      settings,
      rules,
    });

    expect((await store.getActiveBlockedChannelIds()).has(canonicalChannelId)).toBe(true);

    // Channel added to allowlist
    const rulesWithAllow = {
      ...rules,
      allowedChannelIds: [canonicalChannelId],
    };
    const revoked = await store.revokeForRules(rulesWithAllow);
    expect(revoked).toContain(canonicalChannelId);

    expect((await store.getActiveBlockedChannelIds()).has(canonicalChannelId)).toBe(false);
  });

  it('supports one-action Undo / manual revocation and manual promotion', async () => {
    const settings = {
      ...defaultSettings(),
      autoChannel: { enabled: true, maxPromotionsPerDay: 5, minDistinctVideos: 1 },
    };
    const rules = defaultRules();

    await store.recordCandidateVideo({
      channelId: canonicalChannelId,
      videoId: 'v1',
      classification: qualClassification,
      settings,
      rules,
    });
    expect((await store.getActiveBlockedChannelIds()).has(canonicalChannelId)).toBe(true);

    // Revoke
    const ok = await store.revoke(canonicalChannelId);
    expect(ok).toBe(true);
    expect((await store.getActiveBlockedChannelIds()).has(canonicalChannelId)).toBe(false);

    // Candidate observation should not resurrect revoked entry
    const res = await store.recordCandidateVideo({
      channelId: canonicalChannelId,
      videoId: 'v2',
      classification: qualClassification,
      settings,
      rules,
    });
    expect(res.promoted).toBe(false);
    expect(res.entry?.status).toBe('revoked');

    // Manual promote
    await store.promoteSuggestion(canonicalChannelId);
    expect((await store.getActiveBlockedChannelIds()).has(canonicalChannelId)).toBe(true);
  });

  it('sweeps expired entries past 30 days', async () => {
    const now = Date.now();
    const state = defaultAutoChannelState();
    state.entries['UC_expired_12345'] = {
      channelId: 'UC_expired_12345',
      qualifyingVideoIds: ['v1'],
      evidenceCategories: ['ai-visual'],
      recordedAt: now - 35 * 86_400_000,
      expiresAt: now - 5 * 86_400_000, // expired 5 days ago
      status: 'active',
    };
    state.entries['UC_valid_1234567'] = {
      channelId: 'UC_valid_1234567',
      qualifyingVideoIds: ['v2'],
      evidenceCategories: ['ai-voice'],
      recordedAt: now,
      expiresAt: now + 25 * 86_400_000, // valid for 25 more days
      status: 'active',
    };
    await store.save(state);

    const swept = await store.sweepExpired(now);
    expect(swept).toBe(1);

    const active = await store.getActiveBlockedChannelIds(now);
    expect(active.has('UC_expired_12345')).toBe(false);
    expect(active.has('UC_valid_1234567')).toBe(true);
  });

  it('serializes concurrent candidate recordings safely', async () => {
    const settings = {
      ...defaultSettings(),
      autoChannel: { enabled: true, maxPromotionsPerDay: 5, minDistinctVideos: 3 },
    };
    const rules = defaultRules();

    // Fire 5 distinct videos concurrently
    const promises = [1, 2, 3, 4, 5].map((i) =>
      store.recordCandidateVideo({
        channelId: canonicalChannelId,
        videoId: `vid-${i}`,
        classification: qualClassification,
        settings,
        rules,
      }),
    );

    await Promise.all(promises);
    const loaded = await store.load();
    expect(loaded.entries[canonicalChannelId]?.qualifyingVideoIds).toHaveLength(5);
    expect(loaded.entries[canonicalChannelId]?.status).toBe('active');
  });
});
