import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FilterOrchestrator } from '@/pipeline/orchestrator';
import { defaultSettings } from '@/domain/settings';
import { RuleStore } from '@/storage/rule-store';
import { AutoChannelStore } from '@/storage/auto-channel-store';
import { MemoryKVStore } from '@/storage/db';
import type { Classification } from '@/domain/classification';

describe('V5-08: Automatic Channel Blocks DOM Integration', () => {
  let kv: MemoryKVStore;
  let ruleStore: RuleStore;
  let autoChannelStore: AutoChannelStore;
  const canonicalChannelId = 'UC_test_auto_channel_123';

  beforeEach(() => {
    kv = new MemoryKVStore();
    ruleStore = new RuleStore(kv);
    autoChannelStore = new AutoChannelStore(kv);
    document.body.innerHTML = '';
  });

  const createCard = (options: {
    videoId: string;
    title: string;
    channelId: string;
    displayName: string;
  }): HTMLElement => {
    const card = document.createElement('ytd-rich-item-renderer');
    card.className = 'style-scope ytd-rich-grid-renderer';

    const lockup = document.createElement('yt-lockup-view-model');
    const titleLink = document.createElement('a');
    titleLink.id = 'video-title-link';
    titleLink.href = `/watch?v=${options.videoId}`;
    const titleSpan = document.createElement('span');
    titleSpan.id = 'video-title';
    titleSpan.textContent = options.title;
    titleLink.appendChild(titleSpan);
    lockup.appendChild(titleLink);

    const channelDiv = document.createElement('div');
    channelDiv.id = 'channel-name';
    const textSpan = document.createElement('span');
    textSpan.id = 'text';
    textSpan.textContent = options.displayName;
    const channelLink = document.createElement('a');
    channelLink.href = `/channel/${options.channelId}`;
    channelLink.appendChild(textSpan);
    channelDiv.appendChild(channelLink);

    lockup.appendChild(channelDiv);
    card.appendChild(lockup);
    document.body.appendChild(card);
    return card;
  };

  const isCollapsed = (el: Element): boolean =>
    el.hasAttribute('data-bts-collapse') || el.querySelector('[data-bts-collapse]') !== null;

  const createBaseDeps = (
    overrides?: Partial<ConstructorParameters<typeof FilterOrchestrator>[0]>,
  ) => ({
    getSettings: async () => defaultSettings(),
    getRules: async () => ruleStore.load(),
    getCachedClassifications: async () => [undefined],
    putCachedClassifications: async () => {},
    getCorrections: async () => ({ notAi: false, notSlop: false }),
    recordHiddenDurable: async () => {},
    applyStats: async () => {},
    isRemoteProviderEnabled: () => false,
    getActiveAutoChannels: async () => autoChannelStore.getActiveBlockedChannelIds(),
    ...overrides,
  });

  it('hides cards from channels with active auto-channel block', async () => {
    // Populate active auto channel
    const state = await autoChannelStore.load();
    state.entries[canonicalChannelId] = {
      channelId: canonicalChannelId,
      qualifyingVideoIds: ['v1', 'v2', 'v3'],
      evidenceCategories: ['ai-voice'],
      recordedAt: Date.now(),
      expiresAt: Date.now() + 30 * 86_400_000,
      status: 'active',
      reason: 'Auto-blocked',
    };
    await autoChannelStore.save(state);

    const card = createCard({
      videoId: 'v-new',
      title: 'New Video From Channel',
      channelId: canonicalChannelId,
      displayName: 'AI Bot Studio',
    });

    const orchestrator = new FilterOrchestrator(
      createBaseDeps({
        getSettings: async () => ({
          ...defaultSettings(),
          autoChannel: { enabled: true, maxPromotionsPerDay: 5, minDistinctVideos: 3 },
        }),
      }),
    );

    await orchestrator.processBatch([card]);

    expect(isCollapsed(card)).toBe(true);
  });

  it('preserves Level 2 explicit video allow precedence over auto-channel block', async () => {
    // Populate active auto channel
    const state = await autoChannelStore.load();
    state.entries[canonicalChannelId] = {
      channelId: canonicalChannelId,
      qualifyingVideoIds: ['v1', 'v2', 'v3'],
      evidenceCategories: ['ai-visual'],
      recordedAt: Date.now(),
      expiresAt: Date.now() + 30 * 86_400_000,
      status: 'active',
    };
    await autoChannelStore.save(state);

    // Explicitly allow video 'v-allowed'
    await ruleStore.apply({ kind: 'allow-video', videoId: 'v-allowed' });

    const allowedCard = createCard({
      videoId: 'v-allowed',
      title: 'Human Collaboration Video',
      channelId: canonicalChannelId,
      displayName: 'AI Bot Studio',
    });

    const normalCard = createCard({
      videoId: 'v-other',
      title: 'Another Video',
      channelId: canonicalChannelId,
      displayName: 'AI Bot Studio',
    });

    const orchestrator = new FilterOrchestrator(
      createBaseDeps({
        getSettings: async () => ({
          ...defaultSettings(),
          autoChannel: { enabled: true, maxPromotionsPerDay: 5, minDistinctVideos: 3 },
        }),
      }),
    );

    await orchestrator.processBatch([allowedCard, normalCard]);

    // Allowed card MUST stay visible (not collapsed)
    expect(isCollapsed(allowedCard)).toBe(false);

    // Normal card is collapsed by channel block
    expect(isCollapsed(normalCard)).toBe(true);
  });

  it('prevents feedback loops: does not record candidate if card was hidden by channel rule', async () => {
    const recordSpy = vi.fn();

    // Channel is explicitly blocked
    await ruleStore.apply({ kind: 'block-channel', channelId: canonicalChannelId });

    const card = createCard({
      videoId: 'v-blocked-chan',
      title: 'Blocked Channel Video',
      channelId: canonicalChannelId,
      displayName: 'Spam Net',
    });

    const strongAiClassification: Classification = {
      aiLikelihood: 0.95,
      slopLikelihood: 0.1,
      categories: { 'ai-voice': 0.9 },
      confidence: 'very-high',
      evidence: [
        {
          id: 'ev-voice-1',
          origin: 'first-party',
          category: 'ai-voice',
          detector: 'test',
          strength: 0.95,
          polarity: 'supports',
          reasonCode: 'synthetic',
          reasonText: 'Synthetic voice',
        },
      ],
      classifierVersion: '1.0',
      rulesVersion: '1.0',
      evaluatedAt: Date.now(),
    };

    const orchestrator = new FilterOrchestrator(
      createBaseDeps({
        getCachedClassifications: async () => [strongAiClassification],
        recordAutoChannelCandidate: recordSpy,
      }),
    );

    await orchestrator.processBatch([card]);

    // Card is collapsed by channel-rule
    expect(isCollapsed(card)).toBe(true);

    // recordAutoChannelCandidate must NOT have been called for this card
    expect(recordSpy).not.toHaveBeenCalled();
  });

  it('records qualifying candidate videos and auto-promotes on threshold', async () => {
    const settings = {
      ...defaultSettings(),
      autoChannel: { enabled: true, maxPromotionsPerDay: 5, minDistinctVideos: 2 },
    };

    const strongAiClassification: Classification = {
      aiLikelihood: 0.95,
      slopLikelihood: 0.1,
      categories: { 'ai-voice': 0.9 },
      confidence: 'very-high',
      evidence: [
        {
          id: 'ev-voice-2',
          origin: 'first-party',
          category: 'ai-voice',
          detector: 'test',
          strength: 0.95,
          polarity: 'supports',
          reasonCode: 'synthetic',
          reasonText: 'Synthetic voice',
        },
      ],
      classifierVersion: '1.0',
      rulesVersion: '1.0',
      evaluatedAt: Date.now(),
    };

    const orchestrator = new FilterOrchestrator(
      createBaseDeps({
        getSettings: async () => settings,
        getCachedClassifications: async () => [strongAiClassification],
        recordAutoChannelCandidate: async (opts) => {
          await autoChannelStore.recordCandidateVideo({
            channelId: opts.channelId,
            handle: opts.handle,
            displayName: opts.displayName,
            videoId: opts.videoId,
            classification: opts.classification,
            settings,
            rules: await ruleStore.load(),
          });
        },
      }),
    );

    // Scan Video 1
    const card1 = createCard({
      videoId: 'v-cand-1',
      title: 'AI Video 1',
      channelId: canonicalChannelId,
      displayName: 'Channel XYZ',
    });
    await orchestrator.processBatch([card1]);
    await new Promise((r) => setTimeout(r, 50));

    let active = await autoChannelStore.getActiveBlockedChannelIds();
    expect(active.has(canonicalChannelId)).toBe(false); // 1 video < 2

    // Scan Video 2
    const card2 = createCard({
      videoId: 'v-cand-2',
      title: 'AI Video 2',
      channelId: canonicalChannelId,
      displayName: 'Channel XYZ',
    });
    await orchestrator.processBatch([card2]);
    await new Promise((r) => setTimeout(r, 50));

    active = await autoChannelStore.getActiveBlockedChannelIds();
    expect(active.has(canonicalChannelId)).toBe(true); // 2 videos >= 2, promoted!
  });
});
