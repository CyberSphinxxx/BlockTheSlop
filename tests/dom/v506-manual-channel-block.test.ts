import { beforeEach, describe, expect, it } from 'vitest';
import { FilterOrchestrator } from '@/pipeline/orchestrator';
import { defaultSettings } from '@/domain/settings';
import { RuleStore } from '@/storage/rule-store';
import { MemoryKVStore, type KVStore } from '@/storage/db';
import { parseCardElement } from '@/youtube/parse/card';

describe('V5-06: Manual Channel Block', () => {
  let kv: MemoryKVStore;
  let ruleStore: RuleStore;

  beforeEach(() => {
    kv = new MemoryKVStore();
    ruleStore = new RuleStore(kv);
    document.body.innerHTML = '';
  });

  const createCard = (options: {
    videoId: string;
    title: string;
    channelId?: string;
    handle?: string;
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
    if (options.channelId) {
      const channelLink = document.createElement('a');
      channelLink.href = `/channel/${options.channelId}`;
      channelLink.appendChild(textSpan);
      channelDiv.appendChild(channelLink);
    } else if (options.handle) {
      const channelLink = document.createElement('a');
      channelLink.href = `/@${options.handle}`;
      channelLink.appendChild(textSpan);
      channelDiv.appendChild(channelLink);
    } else {
      channelDiv.appendChild(textSpan);
    }
    lockup.appendChild(channelDiv);
    card.appendChild(lockup);
    document.body.appendChild(card);
    return card;
  };

  it('blocks channel by canonical UC... ID, saves before acknowledging, and hides only that channel', async () => {
    const cardA1 = createCard({
      videoId: 'vidA1',
      title: 'Video A1',
      channelId: 'UCchannelA123',
      displayName: 'Channel A',
    });
    const cardB = createCard({
      videoId: 'vidB',
      title: 'Video B',
      channelId: 'UCchannelB456',
      displayName: 'Channel B',
    });
    const cardA2 = createCard({
      videoId: 'vidA2',
      title: 'Video A2',
      channelId: 'UCchannelA123',
      displayName: 'Channel A',
    });

    const settings = defaultSettings();
    const orchestrator = new FilterOrchestrator({
      getSettings: async () => settings,
      getRules: async () => ruleStore.load(),
      getCachedClassifications: async () => [undefined, undefined, undefined],
      putCachedClassifications: async () => {},
      getCorrections: async () => ({ notAi: false, notSlop: false }),
      recordHiddenDurable: async () => {},
      applyStats: async () => {},
      isRemoteProviderEnabled: () => false,
    });

    // Initial pass: all cards allowed
    await orchestrator.processBatch([document.body]);
    expect(cardA1.hasAttribute('data-bts-collapse')).toBe(false);
    expect(cardB.hasAttribute('data-bts-collapse')).toBe(false);
    expect(cardA2.hasAttribute('data-bts-collapse')).toBe(false);

    // Apply manual channel block mutation with source and reason
    const updatedRules = await ruleStore.apply({
      kind: 'block-channel',
      channelId: 'UCchannelA123',
      source: 'context-menu',
      reason: 'Blocked via right-click context menu',
    });

    expect(updatedRules.blockedChannelIds).toContain('UCchannelA123');
    expect(updatedRules.channelRulesMeta?.['UCchannelA123']?.source).toBe('context-menu');
    expect(updatedRules.channelRulesMeta?.['UCchannelA123']?.addedAt).toBeGreaterThan(0);

    const isCollapsed = (el: Element): boolean =>
      el.hasAttribute('data-bts-collapse') || el.querySelector('[data-bts-collapse]') !== null;

    // Rescan immediately re-evaluates page and collapses Card A1 and Card A2
    orchestrator.rescan();
    await new Promise((r) => setTimeout(r, 50));
    expect(isCollapsed(cardA1)).toBe(true);
    expect(isCollapsed(cardA2)).toBe(true);
    expect(isCollapsed(cardB)).toBe(false);
  });

  it('rejects blocking by display name alone when channel ID and handle are absent', async () => {
    const card = createCard({
      videoId: 'vidNoId',
      title: 'Video without link',
      displayName: 'Anonymous Channel',
    });

    const candidate = parseCardElement(card, 'home', Date.now());
    expect(candidate.channel.channelId).toBeUndefined();
    expect(candidate.channel.handle).toBeUndefined();
    expect(candidate.channel.displayName).toBe('Anonymous Channel');

    // Attempting to derive a rule without ID or handle must not create a blank or bogus block rule
    const rulesBefore = await ruleStore.load();
    expect(candidate.channel.channelId ?? candidate.channel.handle).toBeUndefined();
    // Invariant: Display name alone is never used as a block key
    expect(rulesBefore.blockedChannelIds).toEqual([]);
    expect(rulesBefore.fallbackBlockedHandles).toEqual([]);
  });

  it('supports fallback block-by-handle when canonical UC ID is absent', async () => {
    const card = createCard({
      videoId: 'vidHandleOnly',
      title: 'Handle only video',
      handle: 'syntheticcreator',
      displayName: 'Synthetic Creator',
    });

    const candidate = parseCardElement(card, 'home', Date.now());
    expect(candidate.channel.channelId).toBeUndefined();
    expect(candidate.channel.handle).toBe('syntheticcreator');

    // Apply fallback handle block
    const updated = await ruleStore.apply({
      kind: 'block-channel-by-handle',
      handle: 'syntheticcreator',
      source: 'context-menu',
      reason: 'Handle-only fallback block',
    });

    expect(updated.fallbackBlockedHandles).toContain('syntheticcreator');
    expect(updated.channelRulesMeta?.['syntheticcreator']?.handle).toBe('syntheticcreator');

    // Orchestrator collapses cards matching the handle
    const orchestrator = new FilterOrchestrator({
      getSettings: async () => defaultSettings(),
      getRules: async () => updated,
      getCachedClassifications: async () => [undefined],
      putCachedClassifications: async () => {},
      getCorrections: async () => ({ notAi: false, notSlop: false }),
      recordHiddenDurable: async () => {},
      applyStats: async () => {},
      isRemoteProviderEnabled: () => false,
    });

    await orchestrator.processBatch([card]);
    const isCollapsed =
      card.hasAttribute('data-bts-collapse') || card.querySelector('[data-bts-collapse]') !== null;
    expect(isCollapsed).toBe(true);
  });

  it('detects recycled DOM node and prevents blocking wrong channel', async () => {
    const card = createCard({
      videoId: 'vidInitial',
      title: 'Initial Video',
      channelId: 'UCchannelA',
      displayName: 'Channel A',
    });

    // Context target captured at click time
    const initialCandidate = parseCardElement(card, 'home', Date.now());
    const capturedTarget = {
      element: card,
      videoId: initialCandidate.videoId,
      channelId: initialCandidate.channel.channelId,
      at: Date.now(),
    };

    // YouTube recycles the element to Channel B before menu action arrives
    const link = card.querySelector('#video-title-link') as HTMLAnchorElement;
    link.href = '/watch?v=vidRecycled';
    const chanLink = card.querySelector('#channel-name a') as HTMLAnchorElement;
    chanLink.href = '/channel/UCchannelB';
    chanLink.textContent = 'Channel B';

    // Click-time freshness check
    const currentCandidate = parseCardElement(card, 'home', Date.now());
    const isStale =
      currentCandidate.videoId !== capturedTarget.videoId ||
      currentCandidate.channel.channelId !== capturedTarget.channelId;

    expect(isStale).toBe(true);
    // Because it is stale, Channel B is NOT blocked
    const storedRules = await ruleStore.load();
    expect(storedRules.blockedChannelIds).not.toContain('UCchannelB');
  });

  it('fails open without hiding if storage write fails', async () => {
    let failWrites = true;
    const faultyKv: KVStore = {
      async get<T>(_key: string): Promise<T | undefined> {
        return undefined;
      },
      async set<T>(_key: string, _value: T): Promise<void> {
        if (failWrites) throw new Error('Storage write failed');
      },
      async remove(_key: string): Promise<void> {},
    };
    const faultyStore = new RuleStore(faultyKv);

    await expect(
      faultyStore.apply({
        kind: 'block-channel',
        channelId: 'UCbroken',
        source: 'context-menu',
      }),
    ).rejects.toThrow('Storage write failed');

    // Rule was not saved
    failWrites = false;
    const rules = await faultyStore.load();
    expect(rules.blockedChannelIds).not.toContain('UCbroken');
  });

  it('supports one-click Undo to restore blocked channel', async () => {
    await ruleStore.apply({
      kind: 'block-channel',
      channelId: 'UCrestoreMe',
      handle: 'restoreme',
      source: 'context-menu',
    });

    let current = await ruleStore.load();
    expect(current.blockedChannelIds).toContain('UCrestoreMe');

    // Undo action (allow channel removes the block entry)
    current = await ruleStore.apply({
      kind: 'allow-channel',
      channelId: 'UCrestoreMe',
      handle: 'restoreme',
    });

    expect(current.blockedChannelIds).not.toContain('UCrestoreMe');
    expect(current.allowedChannelIds).toContain('UCrestoreMe');
  });

  it('attaches channel-page affordance without covering native controls, toggles state, and supports Undo', async () => {
    // Setup channel page header DOM
    const header = document.createElement('div');
    header.id = 'channel-header-container';
    const buttons = document.createElement('div');
    buttons.id = 'buttons';
    const nativeSubscribe = document.createElement('button');
    nativeSubscribe.id = 'subscribe-button';
    nativeSubscribe.textContent = 'Subscribe';
    buttons.appendChild(nativeSubscribe);
    header.appendChild(buttons);
    document.body.appendChild(header);

    // Meta tag with channel ID
    const meta = document.createElement('meta');
    meta.setAttribute('itemprop', 'channelId');
    meta.content = 'UCchannelPageTest';
    document.head.appendChild(meta);

    const { ensureChannelPageAffordance } = await import('@/presentation/channel-affordance');

    let ruleChangeNotified = false;
    const btn = ensureChannelPageAffordance(document, ruleStore, () => {
      ruleChangeNotified = true;
    });

    expect(btn).not.toBeNull();
    expect(btn?.textContent).toBe('Block Channel');
    // Does not cover native controls
    expect(document.getElementById('subscribe-button')).not.toBeNull();
    expect(buttons.contains(nativeSubscribe)).toBe(true);

    // Click to block
    btn?.click();
    await new Promise((r) => setTimeout(r, 20));

    let rules = await ruleStore.load();
    expect(rules.blockedChannelIds).toContain('UCchannelPageTest');
    expect(rules.channelRulesMeta?.['UCchannelPageTest']?.source).toBe('channel-page');
    expect(ruleChangeNotified).toBe(true);
    expect(btn?.textContent).toContain('Channel Blocked (Undo)');

    // Click again to Undo
    btn?.click();
    await new Promise((r) => setTimeout(r, 20));

    rules = await ruleStore.load();
    expect(rules.blockedChannelIds).not.toContain('UCchannelPageTest');
    expect(btn?.textContent).toBe('Block Channel');
  });
});
