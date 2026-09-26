import { beforeEach, describe, expect, it } from 'vitest';
import { FilterOrchestrator } from '@/pipeline/orchestrator';
import { defaultSettings } from '@/domain/settings';
import { RuleStore } from '@/storage/rule-store';
import { MemoryKVStore } from '@/storage/db';
import { parseCardElement } from '@/youtube/parse/card';
import {
  showChannelChoiceNotice,
  dismissChannelChoiceNotice,
} from '@/presentation/channel-choice-notice';
import { HideActivityNotice } from '@/presentation/activity';
import { sessionRecovery } from '@/presentation/session-recovery';

describe('V5-07: Deliberate Manual Mark -> Channel Choice & Undo', () => {
  let kv: MemoryKVStore;
  let ruleStore: RuleStore;

  beforeEach(() => {
    kv = new MemoryKVStore();
    ruleStore = new RuleStore(kv);
    document.body.innerHTML = '';
    sessionRecovery.clear();
  });

  const createCard = (options: {
    videoId: string;
    title: string;
    channelId?: string;
    handle?: string;
    displayName?: string;
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
    textSpan.textContent = options.displayName ?? options.handle ?? options.channelId ?? 'Channel';
    if (options.channelId) {
      const channelLink = document.createElement('a');
      channelLink.href = `/channel/${options.channelId}`;
      channelLink.appendChild(textSpan);
      channelDiv.appendChild(channelLink);
    } else if (options.handle) {
      const channelLink = document.createElement('a');
      channelLink.href = `/@${options.handle.replace(/^@/, '')}`;
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

  it('renders deliberate channel choice notice with channel identity and scope', async () => {
    const notice = await showChannelChoiceNotice({
      videoId: 'vid123',
      channelId: 'UCdeliberate1',
      handle: 'deliberate_creator',
      displayName: 'Deliberate Creator',
      videoTitle: 'Test Video',
      ruleStore,
    });

    expect(notice).not.toBeNull();
    expect(notice.getAttribute('data-bts-channel-choice')).toBe('');
    expect(notice.querySelector('[data-bts-channel-name]')?.textContent).toBe('Deliberate Creator');
    expect(notice.textContent).toContain('@deliberate_creator');
    expect(notice.textContent).toContain('UCdeliberate1');

    const scope = notice.querySelector('[data-bts-channel-scope]');
    expect(scope?.textContent).toContain('All future videos from this channel will be hidden');
    expect(scope?.textContent).toContain('Explicit video allow rules take precedence');
    expect(scope?.textContent).toContain('Local-only; no remote reporting');
  });

  it('handles cards with missing channel identity safely without crashing or guessing', async () => {
    const notice = await showChannelChoiceNotice({
      videoId: 'vidUnknown',
      videoTitle: 'Mystery Video',
      ruleStore,
    });

    expect(notice.textContent).toContain('whole-channel blocking is unavailable');
    expect(notice.querySelector('[data-bts-action="confirm-block-channel"]')).toBeNull();

    const closeBtn = notice.querySelector<HTMLButtonElement>('[data-bts-action="cancel"]');
    expect(closeBtn).not.toBeNull();
    closeBtn?.click();

    expect(document.querySelector('[data-bts-channel-choice]')).toBeNull();
    const rules = await ruleStore.load();
    expect(rules.blockedChannelIds).toEqual([]);
    expect(rules.fallbackBlockedHandles).toEqual([]);
  });

  it('detects and documents conflict when channel is already in Allowed list', async () => {
    // Pre-populate allowed channels
    await ruleStore.apply({ kind: 'allow-channel', channelId: 'UCfriendly1' });

    const notice = await showChannelChoiceNotice({
      videoId: 'vidFriendly',
      channelId: 'UCfriendly1',
      displayName: 'Friendly Channel',
      ruleStore,
    });

    const conflict = notice.querySelector('[data-bts-channel-conflict]');
    expect(conflict).not.toBeNull();
    expect(conflict?.textContent).toContain('This channel is currently in your Allowed list');
    expect(conflict?.textContent).toContain('Blocking it will remove it from Allowed Channels');
  });

  it('cancel button dismisses notice and does not block channel', async () => {
    const notice = await showChannelChoiceNotice({
      videoId: 'vidCancel',
      channelId: 'UCkeepMe',
      displayName: 'Keep Me Channel',
      ruleStore,
    });

    const cancelBtn = notice.querySelector<HTMLButtonElement>('[data-bts-action="cancel"]');
    expect(cancelBtn).not.toBeNull();
    cancelBtn?.click();

    expect(document.querySelector('[data-bts-channel-choice]')).toBeNull();
    const rules = await ruleStore.load();
    expect(rules.blockedChannelIds).not.toContain('UCkeepMe');
  });

  it('confirming block adds channel rule, removes any allow conflict, and provides instant Undo', async () => {
    let blockCallbackCalled = false;
    let undoCallbackCalled = false;

    // Start with channel in allowed list to verify conflict removal
    await ruleStore.apply({ kind: 'allow-channel', channelId: 'UCswitcheroo' });

    const notice = await showChannelChoiceNotice({
      videoId: 'vidSwitch',
      channelId: 'UCswitcheroo',
      displayName: 'Switcheroo Channel',
      videoTitle: 'Clickbait Video',
      ruleStore,
      onBlockSuccess: () => {
        blockCallbackCalled = true;
      },
      onUndoSuccess: () => {
        undoCallbackCalled = true;
      },
    });

    const blockBtn = notice.querySelector<HTMLButtonElement>(
      '[data-bts-action="confirm-block-channel"]',
    );
    expect(blockBtn).not.toBeNull();
    blockBtn?.click();
    await new Promise((r) => setTimeout(r, 25));

    expect(blockCallbackCalled).toBe(true);

    let rules = await ruleStore.load();
    expect(rules.blockedChannelIds).toContain('UCswitcheroo');
    expect(rules.allowedChannelIds).not.toContain('UCswitcheroo');
    expect(rules.channelRulesMeta?.['UCswitcheroo']?.source).toBe('manual');
    expect(rules.channelRulesMeta?.['UCswitcheroo']?.reason).toContain('Clickbait Video');

    // Verify Undo view appeared
    const undoBtn = notice.querySelector<HTMLButtonElement>(
      '[data-bts-action="undo-block-channel"]',
    );
    expect(undoBtn).not.toBeNull();
    undoBtn?.click();
    await new Promise((r) => setTimeout(r, 25));

    expect(undoCallbackCalled).toBe(true);
    rules = await ruleStore.load();
    expect(rules.blockedChannelIds).not.toContain('UCswitcheroo');
    expect(rules.channelRulesMeta?.['UCswitcheroo']).toBeUndefined();
  });

  it('enforces precedence: explicit video allow wins over blocked channel', async () => {
    const cardAllowedVideo = createCard({
      videoId: 'vidAllowedSpecial',
      title: 'Allowed Special Video',
      channelId: 'UCspammer1',
      displayName: 'Spammer Channel',
    });
    const cardOtherVideo = createCard({
      videoId: 'vidSpamOther',
      title: 'Normal Spam Video',
      channelId: 'UCspammer1',
      displayName: 'Spammer Channel',
    });

    // 1. Explicitly allow the special video
    await ruleStore.apply({ kind: 'allow-video', videoId: 'vidAllowedSpecial' });

    // 2. Deliberately block the whole channel
    await ruleStore.apply({
      kind: 'block-channel',
      channelId: 'UCspammer1',
      displayName: 'Spammer Channel',
      source: 'manual',
    });

    const orchestrator = new FilterOrchestrator({
      getSettings: async () => defaultSettings(),
      getRules: async () => ruleStore.load(),
      getCachedClassifications: async () => [undefined, undefined],
      putCachedClassifications: async () => {},
      getCorrections: async () => ({ notAi: false, notSlop: false }),
      recordHiddenDurable: async () => {},
      applyStats: async () => {},
      isRemoteProviderEnabled: () => false,
    });

    const isCollapsed = (el: Element): boolean =>
      el.hasAttribute('data-bts-collapse') || el.querySelector('[data-bts-collapse]') !== null;

    await orchestrator.processBatch([document.body]);

    // Special allowed video MUST remain visible (video allow > channel block)
    expect(isCollapsed(cardAllowedVideo)).toBe(false);

    // Other video from the same channel MUST be hidden by the channel block
    expect(isCollapsed(cardOtherVideo)).toBe(true);
  });

  it('allows reopening deliberate channel choice from session recovery activity notice', async () => {
    const card = createCard({
      videoId: 'vidRecoveryChoice',
      title: 'Recoverable Video',
      channelId: 'UCchoiceFromPanel',
      handle: 'panelcreator',
      displayName: 'Panel Creator',
    });

    const parsed = parseCardElement(card, 'home', Date.now());
    sessionRecovery.record(
      card,
      parsed,
      { action: 'hide', reason: 'automatic', explanation: ['Filtered'] },
      'sig1',
    );

    const activity = new HideActivityNotice();
    let choiceOpened = false;

    activity.onBlockChannel = (item) => {
      choiceOpened = true;
      void showChannelChoiceNotice({
        videoId: item.videoId ?? '',
        channelId: item.channelId,
        handle: item.handle,
        displayName: item.channelName,
        ruleStore,
      });
    };

    // Mark card as hidden in DOM for activity counter
    card.setAttribute('data-bts-state', 'hidden');
    card.setAttribute('data-bts-video-id', 'vidRecoveryChoice');
    activity.update();
    activity.openPanel();

    const blockBtn = document.querySelector<HTMLButtonElement>(
      '[data-bts-action="open-channel-choice"]',
    );
    expect(blockBtn).not.toBeNull();
    blockBtn?.click();
    await new Promise((r) => setTimeout(r, 25));

    expect(choiceOpened).toBe(true);
    const notice = document.querySelector('[data-bts-channel-choice]');
    expect(notice).not.toBeNull();
    expect(notice?.querySelector('[data-bts-channel-name]')?.textContent).toBe('Panel Creator');

    dismissChannelChoiceNotice();
    expect(document.querySelector('[data-bts-channel-choice]')).toBeNull();
    activity.clear();
  });
});
