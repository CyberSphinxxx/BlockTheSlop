import type { DecisionReason } from '@/domain/decision';
import { ATTR_STATE, ATTR_VIDEO_ID } from '@/youtube/selectors';
import { activityPositionClass, type ActivityIndicatorPosition } from './indicator-position';
import { sessionRecovery, type SessionRecoveryEntry } from './session-recovery';

export function formatDecisionReason(reason?: DecisionReason, ruleId?: string): string {
  if (reason === 'user-rule') {
    if (ruleId?.startsWith('phrase-rule:')) return 'Phrase rule';
    return 'Explicit video rule';
  }
  if (reason === 'channel-rule') {
    return ruleId?.startsWith('auto-channel:') ? 'Automatic channel block' : 'Manual channel rule';
  }
  if (reason === 'correction') return 'User correction';
  if (reason === 'automatic') return 'Automatic hide';
  return 'Filter rule';
}

/** Small page-local confirmation & session recovery control (V5-02 / V5-09). Counts distinct currently hidden video IDs. */
export class HideActivityNotice {
  private notice: HTMLElement | null = null;
  private panel: HTMLElement | null = null;
  private lastCount = 0;
  private scheduledFrame: number | undefined;
  private escapeHandler: ((e: KeyboardEvent) => void) | undefined;
  /** V6-10: current chip position (default bottom-right, 'off' removes it). */
  private position: ActivityIndicatorPosition = 'bottom-right';
  onRestore?: (element: Element, signature: string) => void;
  onBlockChannel?: (entry: Omit<SessionRecoveryEntry, 'element'>) => void;

  /** V6-10: update the chip position live (Off removes the chip entirely). */
  setPosition(position: ActivityIndicatorPosition): void {
    this.position = position;
    this.applyPosition();
    if (position === 'off' && this.lastCount > 0) {
      this.clear();
    }
    this.scheduleUpdate();
  }

  /** Test seam: force the position without a settings round-trip. */
  setLabelOverrideForTests(position: () => ActivityIndicatorPosition): void {
    this.position = position();
  }

  private applyPosition(): void {
    if (this.notice === null) return;
    const cls = activityPositionClass(this.position);
    for (const pos of ['top-left', 'top-right', 'bottom-left', 'bottom-right'] as const) {
      this.notice.classList.toggle(`bts-activity-pos-${pos}`, cls === `bts-activity-pos-${pos}`);
    }
  }

  scheduleUpdate(): void {
    if (this.scheduledFrame !== undefined) return;
    this.scheduledFrame = window.requestAnimationFrame(() => {
      this.scheduledFrame = undefined;
      this.update();
    });
  }

  update(): void {
    const ids = new Set<string>();
    // Query both explicit hidden state and gap-free collapsed items
    for (const card of document.querySelectorAll(`[${ATTR_STATE}="hidden"], [data-bts-collapse]`)) {
      const id = card.getAttribute(ATTR_VIDEO_ID);
      if (id) ids.add(id);
    }
    // Also include connected session-recovery elements (already filtered for connection)
    for (const item of sessionRecovery.list()) {
      if (item.videoId) ids.add(item.videoId);
      else ids.add(item.id);
    }
    const count = ids.size;
    if (count === 0) {
      this.clear();
      return;
    }
    // V6-10: 'off' means NO on-page UI, even when videos are hidden. The
    // popup's session-recovery list and the Review tab remain available.
    if (this.position === 'off') {
      this.clear();
      return;
    }
    if (count === this.lastCount && this.notice !== null) {
      this.applyPosition();
      return;
    }
    this.lastCount = count;
    const notice = this.notice ?? document.createElement('div');
    notice.className = 'bts-activity-notice';
    notice.classList.add(`bts-activity-pos-${this.position}`);
    notice.setAttribute('role', 'button');
    notice.setAttribute('tabindex', '0');
    notice.setAttribute('aria-expanded', this.panel !== null ? 'true' : 'false');
    notice.setAttribute(
      'aria-label',
      `${count} video${count === 1 ? '' : 's'} hidden on this page. Click to review or restore.`,
    );
    notice.textContent = `${count} video${count === 1 ? '' : 's'} hidden · Review`;
    if (!this.notice) {
      notice.addEventListener('click', (e) => {
        e.stopPropagation();
        this.togglePanel();
      });
      notice.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          this.togglePanel();
        }
      });
    }
    if (!notice.isConnected) document.body.appendChild(notice);
    this.notice = notice;
    if (this.panel !== null) {
      this.renderPanelContent();
    }
  }

  togglePanel(): void {
    if (this.panel !== null) {
      this.closePanel();
    } else {
      this.openPanel();
    }
  }

  openPanel(): void {
    if (this.panel !== null) return;
    const panel = document.createElement('div');
    panel.className = 'bts-activity-panel';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-modal', 'true');
    panel.setAttribute('aria-label', 'Hidden videos session recovery');
    this.panel = panel;
    this.renderPanelContent();
    document.body.appendChild(panel);

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        this.closePanel();
        this.notice?.focus();
      }
    };
    this.escapeHandler = onKeyDown;
    document.addEventListener('keydown', onKeyDown);

    if (this.notice) {
      this.notice.setAttribute('aria-expanded', 'true');
    }
  }

  closePanel(): void {
    if (this.escapeHandler) {
      document.removeEventListener('keydown', this.escapeHandler);
      this.escapeHandler = undefined;
    }
    if (this.panel !== null) {
      this.panel.remove();
      this.panel = null;
    }
    if (this.notice) {
      this.notice.setAttribute('aria-expanded', 'false');
    }
  }

  private renderPanelContent(): void {
    if (!this.panel) return;
    this.panel.innerHTML = '';

    const header = document.createElement('div');
    header.className = 'bts-activity-panel-header';
    header.textContent = `Hidden on this page (${this.lastCount})`;

    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'bts-activity-panel-close';
    closeBtn.setAttribute('aria-label', 'Close');
    closeBtn.textContent = '✕';
    closeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.closePanel();
      this.notice?.focus();
    });
    header.appendChild(closeBtn);
    this.panel.appendChild(header);

    const items = sessionRecovery.list();
    if (items.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'bts-activity-item';
      empty.textContent = 'No hidden items to recover.';
      this.panel.appendChild(empty);
      return;
    }

    const listContainer = document.createElement('div');
    for (const item of items) {
      const row = document.createElement('div');
      row.className = 'bts-activity-item';

      const info = document.createElement('div');
      info.className = 'bts-activity-item-info';

      const title = document.createElement('div');
      title.className = 'bts-activity-item-title';
      title.textContent = item.title || item.videoId || 'Hidden video';
      info.appendChild(title);

      const reasonTag = formatDecisionReason(item.decisionReason, item.ruleId);
      const sub = document.createElement('div');
      sub.className = 'bts-activity-item-sub';
      sub.textContent = `${item.channelName ? item.channelName + ' · ' : ''}[${reasonTag}] ${item.reason}`;
      info.appendChild(sub);

      row.appendChild(info);

      const actions = document.createElement('div');
      actions.style.display = 'flex';
      actions.style.gap = '6px';

      if (this.onBlockChannel && (item.channelId || item.handle)) {
        const blockChannelBtn = document.createElement('button');
        blockChannelBtn.type = 'button';
        blockChannelBtn.className = 'bts-button';
        blockChannelBtn.setAttribute('data-bts-action', 'open-channel-choice');
        blockChannelBtn.textContent = 'Block Channel';
        blockChannelBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          this.onBlockChannel?.(item);
        });
        actions.appendChild(blockChannelBtn);
      }

      const restoreBtn = document.createElement('button');
      restoreBtn.type = 'button';
      restoreBtn.className = 'bts-button';
      restoreBtn.textContent = 'Restore';
      restoreBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (this.onRestore) {
          sessionRecovery.restore(item.id, this.onRestore);
          this.scheduleUpdate();
        }
      });
      actions.appendChild(restoreBtn);

      row.appendChild(actions);

      listContainer.appendChild(row);
    }
    this.panel.appendChild(listContainer);
  }

  clear(): void {
    if (this.scheduledFrame !== undefined) window.cancelAnimationFrame(this.scheduledFrame);
    this.scheduledFrame = undefined;
    this.closePanel();
    this.notice?.remove();
    this.notice = null;
    this.lastCount = 0;
  }
}
