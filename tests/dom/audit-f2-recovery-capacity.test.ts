import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionRecoveryStore } from '@/presentation/session-recovery';
import {
  applyDecision,
  ensureStyles,
  restore,
  setPresentationCallbacks,
} from '@/presentation/apply-decision';
import { defaultSettings, type UserSettings } from '@/domain/settings';
import type { FilterDecision } from '@/domain/decision';
import type { NormalizedVideoCandidate } from '@/domain/video';
import { elementFromHtml } from '../fixtures/youtube';

/**
 * Audit Finding 2 — recovery when history is OFF and more than 100 cards are
 * hidden. The product promise: EVERY automatic hide stays recoverable, or the
 * hide fails open with the content visible. A silent `entries.length = 100`
 * truncation broke that: the oldest hidden card kept its collapse but lost
 * its recovery entry (no popup row, no on-page row, no durable history —
 * because history is off in this scenario).
 *
 * Contract under test:
 *  - CAPACITY (100) bounds the store, but a CONNECTED entry may only be
 *    evicted THROUGH a registered eviction callback (the embedder reveals the
 *    card first — fail-open, the hide simply stops holding). A detached entry
 *    owes no recovery and is pruned silently.
 *  - With NO callback registered, connected entries are RETAINED (capacity is
 *    exceeded) rather than silently dropped: bounded in practice by pruning
 *    on every record/list/count once YouTube detaches virtualized cards.
 *  - Duplicate sightings of the same element never grow the store.
 *  - restore() removes the entry and never fires the eviction callback.
 *  - An eviction callback that throws must not corrupt the store.
 *  - clear() (SPA navigation) empties the store without firing evictions.
 *  - The store is intentionally session-scoped: a page reload resets it and
 *    every card renders visible (documented, session-recovery contract).
 */

function decision(): FilterDecision {
  return {
    action: 'hide',
    reason: 'user-rule',
    ruleId: 'video-block:auditf2',
    explanation: ['Hidden by your rule.'],
  };
}

function collapseSettings(): UserSettings {
  return { ...defaultSettings(), displayMode: 'collapse' };
}

/** Fresh isolated store per test (not the content-script singleton). */
function makeStore(): SessionRecoveryStore {
  return new SessionRecoveryStore();
}

/** Build `n` DISTINCT connected hidden cards, recording each in the store. */
function hideMany(store: SessionRecoveryStore, n: number): Element[] {
  const els: Element[] = [];
  for (let i = 0; i < n; i++) {
    const el = elementFromHtml(
      `<ytd-rich-item-renderer data-testid="h${i}"><yt-lockup-view-model>` +
        `<a id="video-title-link" href="/watch?v=f2vid${String(i).padStart(4, '0')}" aria-label="F2 video ${i}">` +
        `<span id="video-title">F2 video ${i}</span></a>` +
        `<div id="channel-name"><a href="/channel/UCF20000000000000000">F2 Channel</a></div>` +
        `</yt-lockup-view-model></ytd-rich-item-renderer>`,
    );
    document.body.appendChild(el);
    const candidate: NormalizedVideoCandidate = {
      videoId: `f2vid${String(i).padStart(4, '0')}`,
      title: `F2 video ${i}`,
      channel: { channelId: 'UCF20000000000000000', displayName: 'F2 Channel' },
      surface: 'home',
      cardKind: 'video',
      badges: [],
      ariaLabels: [],
      metadataText: [],
      isShort: false,
      observedAt: Date.now(),
    };
    applyDecision(el, decision(), candidate, collapseSettings());
    store.record(el, candidate, decision(), `sig-f2-${i}`);
    els.push(el);
  }
  return els;
}

beforeEach(() => {
  document.body.innerHTML = '';
  ensureStyles();
  setPresentationCallbacks({
    showOnce: vi.fn(),
    why: vi.fn(),
    allowVideo: vi.fn(),
    allowChannel: vi.fn(),
  });
});

describe('Audit Finding 2: recovery survives >100 hidden cards with history off', () => {
  it('REPRODUCES the audit finding: 101 distinct connected hidden cards silently lose the oldest entry', () => {
    const store = makeStore();
    const els = hideMany(store, 101);
    // OLD behavior: count() === 100 and element 0 (still hidden) has NO entry.
    const listedIds = new Set(store.list().map((e) => e.videoId));
    const lost = els.filter(
      (el, i) =>
        el.getAttribute('data-bts-collapse') !== null &&
        !listedIds.has(`f2vid${String(i).padStart(4, '0')}`),
    );
    // The FIX makes this empty; the OLD code fails here with 1 lost card.
    expect(lost).toEqual([]);
    expect(store.count()).toBeLessThanOrEqual(101);
  });

  it('capacity eviction reveals the oldest connected card through the callback — no still-hidden card lacks an entry', () => {
    const store = makeStore();
    const evicted: Element[] = [];
    store.setEvictionCallback((entry) => {
      evicted.push(entry.element);
      restore(entry.element);
    });
    const els = hideMany(store, 101);
    // The oldest connected card was revealed (fail-open) instead of stranded.
    expect(evicted).toHaveLength(1);
    expect(evicted[0]).toBe(els[0]);
    expect(els[0]!.getAttribute('data-bts-collapse')).toBeNull();
    expect(els[0]!.hasAttribute('data-bts-state')).toBe(false);
    // Every STILL-HIDDEN card has a reachable recovery entry.
    const listedIds = new Set(store.list().map((e) => e.videoId));
    for (let i = 1; i < els.length; i++) {
      const el = els[i]!;
      if (el.getAttribute('data-bts-collapse') !== null) {
        expect(listedIds.has(`f2vid${String(i).padStart(4, '0')}`), `entry ${i}`).toBe(true);
      }
    }
    expect(store.count()).toBe(100);
  });

  it('with NO callback the connected entry is retained, never silently dropped', () => {
    const store = makeStore();
    const els = hideMany(store, 101);
    // Element 0 is still hidden AND still recoverable (capacity soft-exceeded).
    expect(els[0]!.getAttribute('data-bts-collapse')).toBe('');
    const listedIds = new Set(store.list().map((e) => e.videoId));
    for (let i = 0; i < els.length; i++) {
      expect(listedIds.has(`f2vid${String(i).padStart(4, '0')}`), `entry ${i}`).toBe(true);
    }
  });

  it('duplicate sightings of the same element never grow the store or evict anything', () => {
    const store = makeStore();
    store.setEvictionCallback(() => {
      throw new Error('must never evict for duplicates');
    });
    const els = hideMany(store, 3);
    const candidate: NormalizedVideoCandidate = {
      videoId: 'f2vid0000',
      title: 'F2 video 0',
      channel: { channelId: 'UCF20000000000000000', displayName: 'F2 Channel' },
      surface: 'home',
      cardKind: 'video',
      badges: [],
      ariaLabels: [],
      metadataText: [],
      isShort: false,
      observedAt: Date.now(),
    };
    for (let i = 0; i < 150; i++) {
      store.record(els[0]!, candidate, decision(), 'sig-f2-0');
    }
    expect(store.count()).toBe(3);
  });

  it('detached cards are pruned without callbacks; only the excess over capacity is evicted', () => {
    const store = makeStore();
    const evictedIds: string[] = [];
    store.setEvictionCallback((entry) => {
      evictedIds.push(entry.videoId ?? '');
      restore(entry.element);
    });
    const els = hideMany(store, 60);
    // Detach 30 cards (YouTube virtualization) and hide 80 more.
    for (const el of els.slice(0, 30)) el.remove();
    hideMany(store, 80);
    // 30 detached pruned silently; 30 remaining connected + 80 new = 110, so
    // EXACTLY the 10 oldest connected entries leave THROUGH the reveal path.
    expect(evictedIds).toHaveLength(10);
    expect(evictedIds).toEqual(
      Array.from({ length: 10 }, (_, i) => `f2vid${String(30 + i).padStart(4, '0')}`),
    );
    // Evicted cards were revealed (fail-open), not stranded hidden.
    for (let i = 30; i < 40; i++) {
      expect(els[i]!.getAttribute('data-bts-collapse')).toBeNull();
    }
    expect(store.count()).toBe(100);
    // Every still-hidden connected card that was NOT evicted keeps its entry.
    const listedIds = new Set(store.list().map((e) => e.videoId));
    for (let i = 40; i < 60; i++) {
      expect(listedIds.has(`f2vid${String(i).padStart(4, '0')}`)).toBe(true);
    }
  });

  it('restore() removes the entry without firing the eviction callback', () => {
    const store = makeStore();
    const onEvict = vi.fn();
    store.setEvictionCallback(onEvict);
    const els = hideMany(store, 5);
    const entries = store.list();
    const ok = store.restore(entries[0]!.id, () => {
      restore(els[0]!);
      return true;
    });
    expect(ok).toBe('restored');
    expect(onEvict).not.toHaveBeenCalled();
    expect(store.count()).toBe(4);
  });

  it('RC blocker C: a throwing eviction callback PRESERVES the entry — every still-hidden card keeps a recovery route', () => {
    const store = makeStore();
    store.setEvictionCallback(() => {
      throw new Error('reveal path exploded');
    });
    const els = hideMany(store, 101);
    // OLD (buggy) behavior: the entry was popped BEFORE the callback threw,
    // so the oldest card stayed hidden with NO recovery entry (the audit
    // probe: entries 100, oldestStillHidden true, oldestHasRecovery false).
    // NEW invariant: the failed eviction preserves the entry, so EVERY
    // connected still-hidden card has a reachable recovery route.
    const listedIds = new Set(store.list().map((e) => e.videoId));
    const stranded = els.filter(
      (el, i) =>
        el.getAttribute('data-bts-collapse') !== null &&
        !listedIds.has(`f2vid${String(i).padStart(4, '0')}`),
    );
    expect(stranded).toEqual([]);
    // Capacity soft-overflows rather than destroying a recovery route.
    expect(store.count()).toBe(101);
    void els;
  });

  it('RC blocker C: an explicit unsuccessful callback result preserves the entry too', () => {
    const store = makeStore();
    store.setEvictionCallback(() => false);
    const els = hideMany(store, 101);
    const listedIds = new Set(store.list().map((e) => e.videoId));
    const stranded = els.filter(
      (el, i) =>
        el.getAttribute('data-bts-collapse') !== null &&
        !listedIds.has(`f2vid${String(i).padStart(4, '0')}`),
    );
    expect(stranded).toEqual([]);
    expect(store.count()).toBe(101);
  });

  it('clear() (SPA navigation) empties the store without firing evictions', () => {
    const store = makeStore();
    const onEvict = vi.fn();
    store.setEvictionCallback(onEvict);
    hideMany(store, 40);
    store.clear();
    expect(store.count()).toBe(0);
    expect(onEvict).not.toHaveBeenCalled();
  });
});
