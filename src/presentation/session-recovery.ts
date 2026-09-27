import type { FilterDecision } from '@/domain/decision';
import type { NormalizedVideoCandidate } from '@/domain/video';

/**
 * Session recovery store (V5-02, tightened by audit Finding 2).
 *
 * For history-off (and quick in-session recovery), collapsed cards are tracked
 * here in memory for the current page session. This allows cards to be fully
 * collapsed (`display: none !important`) with NO inline recovery bar left in the
 * grid slot, while guaranteeing every hidden card remains recoverable via the
 * extension popup or the persistent corner badge.
 *
 * Audit Finding 2 — bounded capacity without stranding a hide; tightened by
 * the RC release-blocker-C probe (throwing eviction destroyed the ONLY
 * recovery route while history was off):
 *   - A CONNECTED entry may only leave THROUGH the eviction callback, and
 *     only when the reveal SUCCEEDS (no throw, no explicit failure).
 *   - A failed eviction PRESERVES the entry; capacity admission (reserve())
 *     then REFUSES the incoming hide — the card stays visible with a local
 *     notice, never an unrecoverable hide. The hide lifecycle reserves its
 *     recovery slot via reserve() BEFORE presentation, and the reservation
 *     survives every awaited persistence/settings boundary until record()
 *     commits it or releaseReservation() cancels it (reserve-before-hide).
 *   - Detached entries (YouTube virtualization/navigation) owe no recovery
 *     and are pruned lazily; duplicate sightings replace by element; with
 *     NO callback registered, connected entries are RETAINED (soft capacity)
 *     rather than dropped.
 * The store is intentionally session-scoped: a page reload resets it and
 * every card renders visible again (documented session-recovery contract).
 */

/** Hard capacity for recovery entries per page session. */
const CAPACITY = 100;

/** Prune cadence: one detached sweep per N record() calls (amortized O(1)). */
const PRUNE_EVERY_RECORDS = 32;
/** ...or at oldest every PRUNE_INTERVAL_MS during long infinite-scroll feeds. */
const PRUNE_INTERVAL_MS = 2000;
/** Hard scan bound so one sweep can never walk an unbounded array. */
const PRUNE_SCAN_LIMIT = 4000;
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
  /**
   * Audit Finding 2 / release blocker C: reveal path used when capacity
   * forces the eviction of a CONNECTED entry. The embedder restores that
   * card (fail-open, the hide simply stops holding) and REPORTS the outcome:
   * false (or a throw) means the reveal failed — the entry is preserved and
   * admission refuses the incoming hide. Null in bare stores: connected
   * entries are then retained instead of dropped.
   */
  private onEvict: ((entry: SessionRecoveryEntry) => void | boolean) | null = null;
  /**
   * RC2 issue 1: slots reserved for hides IN FLIGHT. The hide pipeline
   * awaits persistence and settings between reserve() and the actual
   * record(); counting only committed entries would let two overlapping
   * hides claim the same last slot. Owned by ELEMENT, idempotent per
   * element, committed after presentation (or released on abort), dropped
   * when the element detaches. Reservations and entries are separate
   * collections: releasing a reservation can never delete a valid record.
   */
  private reservations = new Set<Element>();
  private recordsSincePrune = 0;
  private lastPruneAt = 0;

  /** Capacity consumption: committed entries PLUS in-flight reservations. */
  private used(): number {
    return this.entries.length + this.reservations.size;
  }

  static getInstance(): SessionRecoveryStore {
    if (!SessionRecoveryStore.instance) {
      SessionRecoveryStore.instance = new SessionRecoveryStore();
    }
    return SessionRecoveryStore.instance;
  }

  /**
   * Audit Finding 2 / release blocker C: register the reveal path used when
   * capacity forces the eviction of a CONNECTED entry. The embedder must
   * restore the card (fail-open: the hide stops holding and the content is
   * visible) so a still-hidden card never silently loses its recovery entry.
   * Return false to report a FAILED reveal (thrown errors are equivalent):
   * the entry is then preserved and capacity admission refuses the incoming
   * hide instead of destroying a recovery route.
   */
  setEvictionCallback(onEvict: (entry: SessionRecoveryEntry) => void | boolean): void {
    this.onEvict = onEvict;
  }

  /**
   * Drop entries whose element has left the document (YouTube virtualizes
   * and detaches cards on navigation/infinite scroll). A detached card owes
   * no recovery, so this never fires the eviction callback. Bounded: stops
   * at the first connected prefix element and caps the scan.
   */
  private pruneDetached(): void {
    if (this.entries.length === 0 && this.reservations.size === 0) return;
    const limit = Math.min(this.entries.length, PRUNE_SCAN_LIMIT);
    let firstDetached = -1;
    for (let i = 0; i < limit; i++) {
      if (!this.entries[i]!.element.isConnected) {
        firstDetached = i;
        break;
      }
    }
    if (firstDetached !== -1) {
      this.entries = this.entries.filter((e) => e.element.isConnected);
    }
    // A reservation for a detached element is dead weight (the element was
    // recycled/removed while its hide was in flight): drop it so the slot
    // returns to the pool. Reservations are bounded by in-flight hides.
    for (const el of this.reservations) {
      if (!el.isConnected) this.reservations.delete(el);
    }
  }

  /** Amortized prune on record(): by call count, or by time on long feeds. */
  private maybePrune(now: number): void {
    this.recordsSincePrune += 1;
    if (
      this.recordsSincePrune >= PRUNE_EVERY_RECORDS ||
      now - this.lastPruneAt >= PRUNE_INTERVAL_MS
    ) {
      this.recordsSincePrune = 0;
      this.lastPruneAt = now;
      this.pruneDetached();
    }
  }

  record(
    element: Element,
    candidate: NormalizedVideoCandidate,
    decision: FilterDecision,
    signature: string,
  ): void {
    // Duplicate sightings replace by element: they never grow the store and
    // never trigger capacity evictions (churn guard — a re-hidden card at
    // capacity must not reveal fifty other cards just to re-record itself).
    const existingIndex = this.entries.findIndex((e) => e.element === element);
    const isReplacement = existingIndex !== -1;
    if (isReplacement) this.entries.splice(existingIndex, 1);

    const now = Date.now();
    this.maybePrune(now);

    const id = `sr_${now}_${Math.random().toString(36).slice(2, 8)}`;
    const entry: SessionRecoveryEntry = {
      id,
      title: candidate.title,
      surface: candidate.surface,
      element,
      signature,
      hiddenAt: now,
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

    // RC2 issue 1: record() COMMITS a reservation taken by reserve(). In the
    // production wiring the orchestrator always reserves first, so consuming
    // the reservation keeps capacity exact: entries + reservations ≤ CAPACITY
    // at every instant, across all awaited persistence/settings boundaries.
    // (Reservations for OTHER elements may exist — they are committed by
    // their own record() calls.) Safety net for bare embedders that record()
    // without reserve(): make room by dropping detached entries, then evict
    // the oldest connected entry through the reveal path — delete only after
    // success (throw/false = failure = entry preserved, soft overflow).
    this.reservations.delete(element);
    if (!isReplacement && this.entries.length + 1 > CAPACITY) {
      let over = this.entries.length + 1 - CAPACITY;
      for (let i = this.entries.length - 1; i >= 0 && over > 0; i--) {
        if (this.entries[i]!.element.isConnected) continue;
        this.entries.splice(i, 1);
        over -= 1;
      }
      while (over > 0 && this.entries.length > 0 && this.onEvict !== null) {
        const oldest = this.entries[this.entries.length - 1]!;
        let succeeded = false;
        try {
          // Explicit failure semantics: a callback that REPORTS failure is
          // handled exactly like one that THROWS.
          succeeded = this.onEvict(oldest) !== false;
        } catch {
          succeeded = false;
        }
        if (succeeded) {
          // Remove the entry only now — AFTER the reveal succeeded, never
          // before. A callback that removed the entry itself (store
          // mutation) finds nothing here, which is fine: it is gone either way.
          const idx = this.entries.lastIndexOf(oldest);
          if (idx !== -1) this.entries.splice(idx, 1);
          over -= 1;
        } else {
          // FAILED eviction: preserve the entry and STOP. Capacity is
          // exceeded rather than a recovery route destroyed; no retry inside
          // record(), so no hide→evict→rescan churn can start here.
          break;
        }
      }
    }
    this.entries.unshift(entry);
  }

  /**
   * RC2 issue 1 — reserve a recovery slot for a hide BEFORE it starts its
   * async pipeline. Reservation ownership is the ELEMENT (idempotent: a
   * second reserve for the same element is a no-op success). Capacity is
   * entries + reservations, so overlapping in-flight hides cannot claim the
   * same slot. Returns false only when NO slot can be secured — the caller
   * must NOT hide; the element stays visible with a local failure notice.
   */
  reserve(element: Element): boolean {
    if (this.reservations.has(element)) return true;
    if (this.entries.some((e) => e.element === element)) return true; // already recoverable
    this.pruneDetached();
    if (this.used() < CAPACITY) {
      this.reservations.add(element);
      return true;
    }
    if (this.onEvict === null) return false;
    // Make room through the reveal path. Each successful eviction removes
    // the old entry ONLY after the reveal succeeded (throw/false = failure).
    while (this.used() >= CAPACITY) {
      const oldest = this.entries[this.entries.length - 1]!;
      let succeeded = false;
      try {
        succeeded = this.onEvict(oldest) !== false;
      } catch {
        succeeded = false;
      }
      if (!succeeded) return false; // preserve entry; refuse the incoming hide
      const idx = this.entries.lastIndexOf(oldest);
      if (idx !== -1) this.entries.splice(idx, 1);
    }
    this.reservations.add(element);
    return true;
  }

  /**
   * RC2 issue 1: release a reservation WITHOUT touching any committed entry.
   * Called when a hide aborts (generation/disabled/detached/identity change),
   * persistence fails, or the element was recycled. Never deletes records.
   */
  releaseReservation(element: Element): void {
    this.reservations.delete(element);
  }

  /** Whether `element` currently holds an in-flight reservation. */
  hasReservation(element: Element): boolean {
    return this.reservations.has(element);
  }

  /** Test/diagnostic view of in-flight reservation count. */
  reservationCount(): number {
    return this.reservations.size;
  }

  removeByElement(element: Element): void {
    this.entries = this.entries.filter((e) => e.element !== element);
  }

  list(): Array<Omit<SessionRecoveryEntry, 'element'>> {
    // Detached elements owe no recovery; drop them lazily on read.
    this.pruneDetached();
    return this.entries.map(({ element: _el, ...rest }) => rest);
  }

  /**
   * RC2 issue 2: explicit restore outcome.
   *  - 'restored': the callback revealed the element; the entry is consumed.
   *  - 'obsolete': the entry provably describes nothing recoverable
   *    (element detached, or the callback reports the element holds
   *    unrelated content) — the entry is discarded, nothing to retry.
   *  - 'failed': the restore could not be performed (callback threw or
   *    reported failure) — the entry is RETAINED so the user can retry.
   */
  restoreEntry(
    entry: SessionRecoveryEntry,
    onRestore: (element: Element, signature: string) => boolean | 'obsolete' | void,
  ): 'restored' | 'obsolete' | 'failed' {
    if (!entry.element.isConnected) {
      this.removeEntry(entry);
      return 'obsolete'; // detached: provably nothing to recover
    }
    let result: boolean | 'obsolete' | void;
    try {
      result = onRestore(entry.element, entry.signature);
    } catch {
      return 'failed'; // entry RETAINED for retry
    }
    if (result === 'obsolete') {
      // Callback policy: the element demonstrably holds unrelated content
      // (e.g. no evidence stamp at all) — the entry can never be restored.
      this.removeEntry(entry);
      return 'obsolete';
    }
    if (result === false) {
      return 'failed'; // entry RETAINED for retry
    }
    this.removeEntry(entry);
    return 'restored';
  }

  private removeEntry(entry: SessionRecoveryEntry): void {
    const idx = this.entries.indexOf(entry);
    if (idx !== -1) this.entries.splice(idx, 1);
  }

  /**
   * Restore one entry by id. Returns the explicit outcome (RC2 issue 2):
   * 'restored' | 'obsolete' | 'failed' — a FAILED restore keeps the entry
   * (retryable) and an OBSOLETE one is discarded. Only 'restored' may be
   * acknowledged or counted in statistics.
   */
  restore(
    id: string,
    onRestore: (element: Element, signature: string) => boolean | 'obsolete' | void,
  ): 'restored' | 'obsolete' | 'failed' {
    const entry = this.entries.find((e) => e.id === id);
    if (entry === undefined) return 'obsolete'; // unknown id: nothing to restore
    return this.restoreEntry(entry, onRestore);
  }

  /**
   * RC2 issue 2: restore every entry INDIVIDUALLY — successful ones are
   * consumed, provably obsolete ones discarded, failed ones RETAINED for
   * retry. Returns honest partial-success counts; a bulk restore never
   * destroys recovery routes of entries whose restore failed.
   */
  restoreAll(onRestore: (element: Element, signature: string) => boolean | 'obsolete' | void): {
    restored: number;
    failed: number;
    obsolete: number;
  } {
    const snapshot = [...this.entries];
    let restored = 0;
    let failed = 0;
    let obsolete = 0;
    for (const entry of snapshot) {
      const outcome = this.restoreEntry(entry, onRestore);
      if (outcome === 'restored') restored += 1;
      else if (outcome === 'obsolete') obsolete += 1;
      else failed += 1;
    }
    return { restored, failed, obsolete };
  }

  /** Navigation/session end: drop entries AND in-flight reservations. */
  clear(): void {
    this.entries = [];
    this.reservations.clear();
  }

  count(): number {
    this.pruneDetached();
    return this.entries.length;
  }
}

export const sessionRecovery = SessionRecoveryStore.getInstance();
