import type { RuleStore } from '@/storage/rule-store';
import type { RuleMutation } from '@/domain/rules';

export interface ChannelChoiceNoticeOptions {
  videoId: string;
  channelId?: string | undefined;
  handle?: string | undefined;
  displayName?: string | undefined;
  videoTitle?: string | undefined;
  ruleStore: RuleStore;
  onBlockSuccess?: ((channelIdentifier: string) => void) | undefined;
  onUndoSuccess?: (() => void) | undefined;
  doc?: Document | undefined;
}

const NOTICE_ATTR = 'data-bts-channel-choice';

/**
 * Remove any active channel choice notice from the document.
 */
export function dismissChannelChoiceNotice(doc: Document = document): void {
  const existing = doc.querySelector(`[${NOTICE_ATTR}]`);
  existing?.remove();
}

/**
 * Deliberate manual mark -> channel choice prompt (V5-07).
 *
 * Appears after "Hide this video" to offer an explicit choice to also block
 * the video's channel. Shows channel identity and scope before applying,
 * prevents accidental single-click whole-channel bans, documents precedence/conflicts,
 * supports instant Undo, and stays strictly local/offline.
 */
export async function showChannelChoiceNotice(
  options: ChannelChoiceNoticeOptions,
): Promise<HTMLElement> {
  const doc = options.doc ?? document;
  dismissChannelChoiceNotice(doc);

  const container = doc.createElement('div');
  container.className = 'bts-channel-choice-notice';
  container.setAttribute(NOTICE_ATTR, '');
  container.setAttribute('role', 'dialog');
  container.setAttribute('aria-label', 'Channel block choice');

  const channelId = options.channelId;
  const handle = options.handle;
  const displayName = options.displayName || handle || channelId || 'Unknown Channel';

  // Header
  const header = doc.createElement('div');
  header.className = 'bts-channel-choice-header';

  const titleSpan = doc.createElement('div');
  titleSpan.textContent = 'Video hidden';
  header.appendChild(titleSpan);

  const tagSpan = doc.createElement('span');
  tagSpan.textContent = 'Channel Choice';
  header.appendChild(tagSpan);

  container.appendChild(header);

  // If identity is completely missing, fail safely and explain
  if (!channelId && !handle) {
    const body = doc.createElement('div');
    body.className = 'bts-channel-choice-body';
    body.textContent =
      'This video is hidden. The channel could not be verified on this card (no channel ID or handle), so whole-channel blocking is unavailable.';
    container.appendChild(body);

    const actions = doc.createElement('div');
    actions.className = 'bts-channel-choice-actions';

    const closeBtn = doc.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'bts-button';
    closeBtn.setAttribute('data-bts-action', 'cancel');
    closeBtn.textContent = 'Close';
    closeBtn.addEventListener('click', () => container.remove());
    actions.appendChild(closeBtn);

    container.appendChild(actions);
    doc.body.appendChild(container);
    return container;
  }

  // Body: Question & Channel identity
  const body = doc.createElement('div');
  body.className = 'bts-channel-choice-body';

  const promptText = doc.createElement('div');
  promptText.textContent = 'Also block this channel?';
  promptText.style.fontWeight = '500';
  promptText.style.marginBottom = '4px';
  body.appendChild(promptText);

  const channelInfo = doc.createElement('div');
  const channelNameSpan = doc.createElement('span');
  channelNameSpan.className = 'bts-channel-choice-channel';
  channelNameSpan.setAttribute('data-bts-channel-name', '');
  channelNameSpan.textContent = displayName;
  channelInfo.appendChild(channelNameSpan);

  if (handle) {
    const handleSpan = doc.createElement('span');
    handleSpan.className = 'bts-channel-choice-handle';
    handleSpan.textContent = `@${handle.replace(/^@/, '')}`;
    channelInfo.appendChild(handleSpan);
  }
  if (channelId && channelId.startsWith('UC')) {
    const idSpan = doc.createElement('span');
    idSpan.className = 'bts-channel-choice-handle';
    idSpan.textContent = ` (${channelId})`;
    channelInfo.appendChild(idSpan);
  }
  body.appendChild(channelInfo);
  container.appendChild(body);

  // Scope explanation
  const scope = doc.createElement('div');
  scope.className = 'bts-channel-choice-scope';
  scope.setAttribute('data-bts-channel-scope', '');
  scope.textContent =
    'Scope: All future videos from this channel will be hidden. Explicit video allow rules take precedence and remain visible. Local-only; no remote reporting.';
  container.appendChild(scope);

  // Check for conflicts with existing Allowed rules
  try {
    const currentRules = await options.ruleStore.load();
    const isAllowed =
      (channelId !== undefined && currentRules.allowedChannelIds.includes(channelId)) ||
      (handle !== undefined &&
        currentRules.fallbackAllowedHandles.includes(handle.replace(/^@/, '').toLowerCase()));

    if (isAllowed) {
      const conflict = doc.createElement('div');
      conflict.className = 'bts-channel-choice-conflict';
      conflict.setAttribute('data-bts-channel-conflict', '');
      conflict.textContent =
        '⚠️ Notice: This channel is currently in your Allowed list. Blocking it will remove it from Allowed Channels.';
      container.appendChild(conflict);
    }
  } catch {
    // If store read fails, continue without conflict banner
  }

  // Actions
  const actions = doc.createElement('div');
  actions.className = 'bts-channel-choice-actions';

  const cancelBtn = doc.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.className = 'bts-button';
  cancelBtn.setAttribute('data-bts-action', 'cancel');
  cancelBtn.textContent = 'Keep video hidden only';
  cancelBtn.addEventListener('click', () => {
    container.remove();
  });
  actions.appendChild(cancelBtn);

  const blockBtn = doc.createElement('button');
  blockBtn.type = 'button';
  blockBtn.className = 'bts-button bts-button-danger';
  blockBtn.setAttribute('data-bts-action', 'confirm-block-channel');
  blockBtn.textContent = 'Block Channel';

  blockBtn.addEventListener('click', async () => {
    blockBtn.disabled = true;
    cancelBtn.disabled = true;
    blockBtn.textContent = 'Blocking…';

    let mutation: RuleMutation;
    let identifier: string;

    if (channelId && channelId.startsWith('UC')) {
      identifier = channelId;
      mutation = {
        kind: 'block-channel',
        channelId,
        handle,
        displayName,
        source: 'manual',
        reason: options.videoTitle
          ? `Blocked after hiding video "${options.videoTitle.slice(0, 40)}"`
          : 'Blocked after manual video hide',
      };
    } else if (handle) {
      identifier = handle;
      mutation = {
        kind: 'block-channel-by-handle',
        handle,
        displayName,
        source: 'manual',
        reason: options.videoTitle
          ? `Blocked by handle after hiding video "${options.videoTitle.slice(0, 40)}"`
          : 'Blocked by handle after manual video hide',
      };
    } else {
      return;
    }

    try {
      await options.ruleStore.apply(mutation);
      options.onBlockSuccess?.(identifier);

      // Render Undo view
      container.innerHTML = '';

      const undoHeader = doc.createElement('div');
      undoHeader.className = 'bts-channel-choice-header';
      undoHeader.textContent = 'Channel blocked';
      container.appendChild(undoHeader);

      const undoBody = doc.createElement('div');
      undoBody.className = 'bts-channel-choice-body';
      undoBody.textContent = `All videos from ${displayName} are now hidden.`;
      container.appendChild(undoBody);

      const undoActions = doc.createElement('div');
      undoActions.className = 'bts-channel-choice-actions';

      const undoBtn = doc.createElement('button');
      undoBtn.type = 'button';
      undoBtn.className = 'bts-button';
      undoBtn.setAttribute('data-bts-action', 'undo-block-channel');
      undoBtn.textContent = 'Undo';

      undoBtn.addEventListener('click', async () => {
        undoBtn.disabled = true;
        undoBtn.textContent = 'Undoing…';

        let undoMutation: RuleMutation;
        if (channelId && channelId.startsWith('UC')) {
          undoMutation = { kind: 'unblock-channel', channelId, handle };
        } else {
          undoMutation = { kind: 'unblock-channel-by-handle', handle: handle! };
        }

        try {
          await options.ruleStore.apply(undoMutation);
          options.onUndoSuccess?.();
          undoBody.textContent = `Channel ${displayName} unblocked.`;
          undoActions.remove();
          setTimeout(() => container.remove(), 1200);
        } catch {
          undoBody.textContent = 'Undo failed. You can remove it from Settings.';
        }
      });
      undoActions.appendChild(undoBtn);

      const dismissBtn = doc.createElement('button');
      dismissBtn.type = 'button';
      dismissBtn.className = 'bts-button';
      dismissBtn.textContent = 'Dismiss';
      dismissBtn.addEventListener('click', () => container.remove());
      undoActions.appendChild(dismissBtn);

      container.appendChild(undoActions);
    } catch (err) {
      blockBtn.disabled = false;
      cancelBtn.disabled = false;
      blockBtn.textContent = 'Retry Block';
      const errMsg = doc.createElement('div');
      errMsg.className = 'bts-channel-choice-conflict';
      errMsg.textContent = `Block failed: ${err instanceof Error ? err.message : String(err)}`;
      container.appendChild(errMsg);
    }
  });

  actions.appendChild(blockBtn);
  container.appendChild(actions);

  doc.body.appendChild(container);
  return container;
}
