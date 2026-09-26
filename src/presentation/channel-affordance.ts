import { channelIdentityFromHref } from '@/youtube/routes';
import type { RuleStore } from '@/storage/rule-store';
import type { RuleMutation } from '@/domain/rules';

const BTN_ID = 'bts-channel-page-affordance';

export interface ChannelPageIdentity {
  channelId?: string | undefined;
  handle?: string | undefined;
  displayName?: string | undefined;
}

export function extractChannelPageIdentity(doc: Document = document): ChannelPageIdentity {
  // 1. Meta tag with canonical UC ID
  const metaId = (doc.querySelector('meta[itemprop="channelId"]') as HTMLMetaElement | null)
    ?.content;

  // 2. Canonical link
  const canonicalHref = (doc.querySelector('link[rel="canonical"]') as HTMLLinkElement | null)
    ?.href;
  const canonicalIdent = canonicalHref ? channelIdentityFromHref(canonicalHref) : {};

  // 3. Current URL
  const urlIdent = channelIdentityFromHref(location.href);

  // 4. Header title / display name
  const nameEl = doc.querySelector('#channel-name #text, ytd-channel-name #text, #header #text');
  const displayName = nameEl?.textContent?.trim() || undefined;

  const channelId =
    (metaId && metaId.startsWith('UC') ? metaId : undefined) ||
    (canonicalIdent.channelId && canonicalIdent.channelId.startsWith('UC')
      ? canonicalIdent.channelId
      : undefined) ||
    (urlIdent.channelId && urlIdent.channelId.startsWith('UC') ? urlIdent.channelId : undefined);

  const handle = urlIdent.handle || canonicalIdent.handle;

  return { channelId, handle, displayName };
}

/**
 * Ensures the Block Channel affordance is attached to the channel page header
 * without covering or obscuring native YouTube controls.
 */
export function ensureChannelPageAffordance(
  doc: Document,
  ruleStore: RuleStore,
  onRuleChanged: () => void,
): HTMLElement | null {
  if (doc.getElementById(BTN_ID)) {
    return doc.getElementById(BTN_ID);
  }

  // Find native header actions or buttons container
  const headerContainer =
    doc.querySelector('#channel-header-container #buttons') ||
    doc.querySelector('ytd-c4-tabbed-header-renderer #subscribe-button') ||
    doc.querySelector('#channel-header .page-header-view-model-wiz__page-header-actions') ||
    doc.querySelector('#channel-header');

  if (!headerContainer) return null;

  const identity = extractChannelPageIdentity(doc);
  if (!identity.channelId && !identity.handle) return null;

  const btn = doc.createElement('button');
  btn.id = BTN_ID;
  btn.className = 'bts-channel-page-btn';
  btn.type = 'button';
  btn.setAttribute('aria-label', 'Block this channel with BlockTheSlop');
  btn.textContent = 'Block Channel';

  // Apply clean styling that matches YouTube without covering native controls
  btn.style.cssText = `
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 0 16px;
    height: 36px;
    margin-left: 8px;
    margin-right: 8px;
    border-radius: 18px;
    font-size: 14px;
    font-weight: 500;
    font-family: inherit;
    cursor: pointer;
    background: rgba(239, 68, 68, 0.12);
    color: #ef4444;
    border: 1px solid rgba(239, 68, 68, 0.35);
    transition: all 0.15s ease;
    z-index: 10;
  `;

  btn.addEventListener('mouseenter', () => {
    btn.style.background = 'rgba(239, 68, 68, 0.22)';
  });
  btn.addEventListener('mouseleave', () => {
    btn.style.background =
      btn.getAttribute('data-blocked') === 'true'
        ? 'rgba(100, 116, 139, 0.2)'
        : 'rgba(239, 68, 68, 0.12)';
  });

  const updateState = async () => {
    const rules = await ruleStore.load();
    const isBlocked =
      (identity.channelId && rules.blockedChannelIds.includes(identity.channelId)) ||
      (identity.handle && rules.fallbackBlockedHandles.includes(identity.handle.toLowerCase()));

    if (isBlocked) {
      btn.setAttribute('data-blocked', 'true');
      btn.textContent = 'Channel Blocked (Undo)';
      btn.style.color = '#94a3b8';
      btn.style.borderColor = 'rgba(148, 163, 184, 0.35)';
      btn.style.background = 'rgba(100, 116, 139, 0.2)';
    } else {
      btn.removeAttribute('data-blocked');
      btn.textContent = 'Block Channel';
      btn.style.color = '#ef4444';
      btn.style.borderColor = 'rgba(239, 68, 68, 0.35)';
      btn.style.background = 'rgba(239, 68, 68, 0.12)';
    }
  };

  void updateState();

  btn.addEventListener('click', async (e) => {
    e.preventDefault();
    e.stopPropagation();

    const isBlocked = btn.getAttribute('data-blocked') === 'true';
    btn.disabled = true;

    try {
      if (isBlocked) {
        // Undo / allow
        const mutation: RuleMutation = identity.channelId
          ? { kind: 'allow-channel', channelId: identity.channelId, handle: identity.handle }
          : { kind: 'allow-channel-by-handle', handle: identity.handle! };
        await ruleStore.apply(mutation);
      } else {
        // Block
        let mutation: RuleMutation;
        if (identity.channelId && identity.channelId.startsWith('UC')) {
          mutation = {
            kind: 'block-channel',
            channelId: identity.channelId,
            handle: identity.handle,
            displayName: identity.displayName,
            source: 'channel-page',
            reason: `Blocked from channel page: ${identity.displayName ?? identity.handle ?? identity.channelId}`,
          };
        } else if (identity.handle) {
          mutation = {
            kind: 'block-channel-by-handle',
            handle: identity.handle,
            displayName: identity.displayName,
            source: 'channel-page',
            reason: `Blocked from channel page by handle: @${identity.handle}`,
          };
        } else {
          return;
        }
        await ruleStore.apply(mutation);
      }
      await updateState();
      onRuleChanged();
    } finally {
      btn.disabled = false;
    }
  });

  // Attach cleanly without covering native elements
  headerContainer.appendChild(btn);
  return btn;
}
