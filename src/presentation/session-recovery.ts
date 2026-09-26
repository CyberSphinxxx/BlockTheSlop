import type { FilterDecision } from '@/domain/decision';
import type { NormalizedVideoCandidate } from '@/domain/video';

/**
 * Session recovery store (V5-02).
 *
 * For history-off (and quick in-session recovery), collapsed cards are tracked
 * here in memory for the current page session. This allows cards to be fully
 * collapsed (`display: none !important`) with NO inline recovery bar left in the
 * grid slot, while guaranteeing every hidden card remains recoverable via the
 * extension popup or the persistent corner badge.
 */
export interface SessionRecoveryEntry {
  id: string;
  videoId?: string;
  title: string;
  channelName?: string;
  channelId?: string;
  handle?: string;
  surface: string;
  element: Element;
  signature: string;
  hiddenAt: number;
  reason: string;
  decisionReason?: FilterDecision['reason'];
  ruleId?: string;
}

export class SessionRecoveryStore {
  private entries: SessionRecoveryEntry[] = [];
  private static instance: SessionRecoveryStore | null = null;

  static getInstance(): SessionRecoveryStore {
    if (!SessionRecoveryStore.instance) {
      SessionRecoveryStore.instance = new SessionRecoveryStore();
    }
    return SessionRecoveryStore.instance;
  }

  record(
    element: Element,
    candidate: NormalizedVideoCandidate,
    decision: FilterDecision,
    signature: string,
  ): void {
    // Remove any existing entry for this element
    this.removeByElement(element);

    const id = `sr_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const entry: SessionRecoveryEntry = {
      id,
      title: candidate.title,
      surface: candidate.surface,
      element,
      signature,
      hiddenAt: Date.now(),
      reason: decision.explanation[0] ?? 'Matched your filter rules',
      decisionReason: decision.reason,
      ...(decision.ruleId !== undefined ? { ruleId: decision.ruleId } : {}),
      ...(candidate.videoId !== undefined ? { videoId: candidate.videoId } : {}),
      ...(candidate.channel.displayName !== undefined
        ? { channelName: candidate.channel.displayName }
        : {}),
      ...(candidate.channel.channelId !== undefined
        ? { channelId: candidate.channel.channelId }
        : {}),
      ...(candidate.channel.handle !== undefined ? { handle: candidate.channel.handle } : {}),
    };
    this.entries.unshift(entry);

    // Bound entries to 100 per page view
    if (this.entries.length > 100) {
      this.entries.length = 100;
    }
  }

  removeByElement(element: Element): void {
    this.entries = this.entries.filter((e) => e.element !== element);
  }

  list(): Array<Omit<SessionRecoveryEntry, 'element'>> {
    // Filter out detached elements
    this.entries = this.entries.filter((e) => e.element.isConnected);
    return this.entries.map(({ element: _el, ...rest }) => rest);
  }

  restore(id: string, onRestore: (element: Element, signature: string) => void): boolean {
    const index = this.entries.findIndex((e) => e.id === id);
    if (index === -1) return false;
    const entry = this.entries[index]!;
    this.entries.splice(index, 1);
    if (entry.element.isConnected) {
      onRestore(entry.element, entry.signature);
      return true;
    }
    return false;
  }

  restoreAll(onRestore: (element: Element, signature: string) => void): number {
    const valid = this.entries.filter((e) => e.element.isConnected);
    this.entries = [];
    for (const entry of valid) {
      onRestore(entry.element, entry.signature);
    }
    return valid.length;
  }

  clear(): void {
    this.entries = [];
  }

  count(): number {
    this.entries = this.entries.filter((e) => e.element.isConnected);
    return this.entries.length;
  }
}

export const sessionRecovery = SessionRecoveryStore.getInstance();
