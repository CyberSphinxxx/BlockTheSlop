import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionRecoveryStore } from '@/presentation/session-recovery';
import { FilterOrchestrator, type OrchestratorDeps } from '@/pipeline/orchestrator';
import {
  applyDecision,
  ensureStyles,
  restore,
  setPresentationCallbacks,
} from '@/presentation/apply-decision';
import { cleanupAll } from '@/presentation/cleanup';
import { defaultSettings, type UserSettings } from '@/domain/settings';
import { defaultRules } from '@/domain/rules';
import { identityOf } from '@/domain/video';
import type { FilterDecision } from '@/domain/decision';
import type { NormalizedVideoCandidate } from '@/domain/video';
import { elementFromHtml } from '../fixtures/youtube';

/**
 * Release blocker C — recovery admission and eviction failure.
 *
 * The prior probe: with history OFF, 100 entries, an eviction callback that
 * THREW removed the oldest entry BEFORE attempting the reveal — the callback
 * error was swallowed, the entry was gone, the card stayed hidden, and (with
 * history off) there was NO recovery route left. entries=100,
 * oldestStillHidden=true, oldestHasRecovery=false.
 *
 * Product invariant under test: EVERY connected automatically hidden card has
 * a reachable recovery route, or its hide fails open (stays visible with a
 * concise local indication).
 *
 * Design under test:
 *  - reserve-before-hide: FilterOrchestrator.onHideAdmission reserves a
 *    session-recovery slot BEFORE presentation (admit()); a refusal keeps
 *    the card visible and fires onHideAdmissionRefused;
 *  - the eviction callback REPORTS success/failure (false/throw = failure);
 *    a failed eviction preserves the entry;
 *  - duplicate sightings replace in place and never trigger evictions;
 *  - reentrancy guard: a nested eviction during a reveal is refused;
 *  - identity freshness: an old entry whose element was recycled is never
 *    revealed as if it were still that video.
 */

function decision(): FilterDecision {
  return {
    action: 'hide',
    reason: 'user-rule',
    ruleId: 'video-block:rcc',
    explanation: ['Hidden by your rule.'],
  };
}

function collapseSettings(): UserSettings {
  return {
    ...defaultSettings(),
    displayMode: 'collapse',
    history: { enabled: false, retentionDays: 30 },
  };
}

function makeCard(i: number): { el: Element; candidate: NormalizedVideoCandidate } {
  const id = `rccvid${String(i).padStart(4, '0')}`;
  const el = elementFromHtml(
    `<ytd-rich-item-renderer data-testid="c${i}"><yt-lockup-view-model>` +
      `<a id="video-title-link" href="/watch?v=${id}" aria-label="RCC video ${i}">` +
      `<span id="video-title">RCC video ${i}</span></a>` +
      `<div id="channel-name"><a href="/channel/UCRcc0000000000000000">RCC Channel</a></div>` +
      `</yt-lockup-view-model></ytd-rich-item-renderer>`,
  );
  document.body.appendChild(el);
  const candidate: NormalizedVideoCandidate = {
    videoId: id,
    title: `RCC video ${i}`,
    channel: { channelId: 'UCRcc0000000000000000', displayName: 'RCC Channel' },
    surface: 'home',
    cardKind: 'video',
    badges: [],
    ariaLabels: [],
    metadataText: [],
    isShort: false,
    observedAt: Date.now(),
  };
  return { el, candidate };
}

/** The production hide path, factored for the store-level suites. */
function hide(store: SessionRecoveryStore, el: Element, candidate: NormalizedVideoCandidate): void {
  applyDecision(el, decision(), candidate, collapseSettings());
  store.record(el, candidate, decision(), identityOf(candidate));
}

/** Assert the invariant across ALL connected hidden cards, not just the newest. */
function expectNoStrandedHiddenCards(els: Element[], store: SessionRecoveryStore): void {
  const listedElements = new Set(store.list().map((e) => e.id));
  void listedElements;
  const listedIds = new Set(store.list().map((e) => e.videoId));
  const stranded = els.filter(
    (el, i) =>
      el.isConnected &&
      el.getAttribute('data-bts-collapse') !== null &&
      !listedIds.has(`rccvid${String(i).padStart(4, '0')}`),
  );
  expect(stranded).toEqual([]);
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

describe('RC blocker C: store-level eviction semantics', () => {
  it('100 connected cards with history off: every hidden card has a recovery route', () => {
    const store = new SessionRecoveryStore();
    const revealed: Element[] = [];
    store.setEvictionCallback((entry) => {
      revealed.push(entry.element);
      restore(entry.element);
    });
    const els: Element[] = [];
    for (let i = 0; i < 100; i++) {
      const { el, candidate } = makeCard(i);
      hide(store, el, candidate);
      els.push(el);
    }
    expect(store.count()).toBe(100);
    expect(revealed).toHaveLength(0);
    expectNoStrandedHiddenCards(els, store);
  });

  it('101st hide at capacity: successful eviction reveals the oldest — no stranded card', () => {
    const store = new SessionRecoveryStore();
    const revealed: Element[] = [];
    store.setEvictionCallback((entry) => {
      revealed.push(entry.element);
      restore(entry.element);
    });
    const els: Element[] = [];
    for (let i = 0; i < 101; i++) {
      const { el, candidate } = makeCard(i);
      hide(store, el, candidate);
      els.push(el);
    }
    expect(revealed).toHaveLength(1);
    expect(revealed[0]).toBe(els[0]);
    expect(els[0]!.getAttribute('data-bts-collapse')).toBeNull();
    expect(store.count()).toBe(100);
    expectNoStrandedHiddenCards(els, store);
  });

  it('substantially more connected cards (250) with successful evictions: invariant holds', () => {
    const store = new SessionRecoveryStore();
    store.setEvictionCallback((entry) => {
      restore(entry.element);
    });
    const els: Element[] = [];
    for (let i = 0; i < 250; i++) {
      const { el, candidate } = makeCard(i);
      hide(store, el, candidate);
      els.push(el);
    }
    // 150 reveals happened; the 100 newest hidden cards all have entries.
    expect(store.count()).toBe(100);
    expectNoStrandedHiddenCards(els, store);
    // The evicted cards were actually revealed (not hidden-without-entry).
    for (let i = 0; i < 150; i++) {
      expect(els[i]!.getAttribute('data-bts-collapse')).toBeNull();
    }
  });

  it('throwing callback at capacity: entry preserved, invariant still holds (soft overflow)', () => {
    const store = new SessionRecoveryStore();
    let throwFirst = true;
    store.setEvictionCallback((entry) => {
      if (throwFirst) {
        throwFirst = false;
        throw new Error('reveal path exploded');
      }
      restore(entry.element);
    });
    const els: Element[] = [];
    for (let i = 0; i < 102; i++) {
      const { el, candidate } = makeCard(i);
      hide(store, el, candidate);
      els.push(el);
    }
    // The 101st hide's eviction threw: its entry was preserved (101 entries),
    // and the 102nd hide's eviction succeeded (100 entries after that).
    expect(store.count()).toBe(100);
    expectNoStrandedHiddenCards(els, store);
  });

  it('explicit unsuccessful callback result: same preserve semantics as a throw', () => {
    const store = new SessionRecoveryStore();
    let failFirst = true;
    store.setEvictionCallback((entry) => {
      if (failFirst) {
        failFirst = false;
        return false;
      }
      restore(entry.element);
      return true;
    });
    const els: Element[] = [];
    for (let i = 0; i < 102; i++) {
      const { el, candidate } = makeCard(i);
      hide(store, el, candidate);
      els.push(el);
    }
    expect(store.count()).toBe(100);
    expectNoStrandedHiddenCards(els, store);
  });

  it('callback that MUTATES the store (removes entries) cannot corrupt eviction', () => {
    const store = new SessionRecoveryStore();
    const store2 = new SessionRecoveryStore();
    let first = true;
    store.setEvictionCallback((entry) => {
      restore(entry.element);
      if (first) {
        first = false;
        // Hostile/edge callback: reach into ANOTHER store and clear it, and
        // remove this entry by element from the evicting store as well.
        store2.clear();
        store.removeByElement(entry.element);
      }
    });
    for (let i = 0; i < 3; i++) {
      const { el, candidate } = makeCard(900 + i);
      hide(store2, el, candidate);
    }
    const els: Element[] = [];
    for (let i = 0; i < 102; i++) {
      const { el, candidate } = makeCard(i);
      hide(store, el, candidate);
      els.push(el);
    }
    expectNoStrandedHiddenCards(els, store);
  });

  it('duplicate recording of the same element never evicts, even at full capacity', () => {
    const store = new SessionRecoveryStore();
    let evictions = 0;
    store.setEvictionCallback((entry) => {
      evictions += 1;
      restore(entry.element);
    });
    const els: Element[] = [];
    for (let i = 0; i < 100; i++) {
      const { el, candidate } = makeCard(i);
      hide(store, el, candidate);
      els.push(el);
    }
    expect(store.count()).toBe(100);
    // Re-record element 50 fifty times (settings changes re-hide cards).
    const { el, candidate } = makeCard(50);
    els[50]!.remove();
    for (let i = 0; i < 50; i++) {
      store.record(el, candidate, decision(), identityOf(candidate));
    }
    expect(evictions).toBe(0);
    expect(store.count()).toBe(100);
  });

  it('detached entries are pruned silently; they owe no recovery', () => {
    const store = new SessionRecoveryStore();
    const onEvict = vi.fn();
    store.setEvictionCallback(onEvict);
    const els: Element[] = [];
    for (let i = 0; i < 30; i++) {
      const { el, candidate } = makeCard(200 + i);
      hide(store, el, candidate);
      els.push(el);
    }
    for (const el of els) el.remove();
    expect(store.count()).toBe(0);
    expect(onEvict).not.toHaveBeenCalled();
  });

  it('wrapper collapse (single-card slot) and ordinary collapse both keep recovery rows', () => {
    const store = new SessionRecoveryStore();
    store.setEvictionCallback((entry) => {
      restore(entry.element);
    });
    // Wrapper collapse: ytd-rich-item-renderer wraps exactly one lockup.
    const wrapper = elementFromHtml(
      `<ytd-rich-item-renderer data-testid="wrapped"><yt-lockup-view-model>` +
        `<a id="video-title-link" href="/watch?v=rccwrap01" aria-label="Wrapped card">` +
        `<span id="video-title">Wrapped card</span></a>` +
        `<div id="channel-name"><a href="/channel/UCRcc0000000000000000">RCC Channel</a></div>` +
        `</yt-lockup-view-model></ytd-rich-item-renderer>`,
    );
    document.body.appendChild(wrapper);
    const inner = wrapper.querySelector('yt-lockup-view-model')!;
    const wrappedCandidate: NormalizedVideoCandidate = {
      videoId: 'rccwrap01',
      title: 'Wrapped card',
      channel: { channelId: 'UCRcc0000000000000000' },
      surface: 'home',
      cardKind: 'video',
      badges: [],
      ariaLabels: [],
      metadataText: [],
      isShort: false,
      observedAt: Date.now(),
    };
    applyDecision(inner, decision(), wrappedCandidate, collapseSettings());
    expect(wrapper.getAttribute('data-bts-slot')).toBe('collapse');
    store.record(inner, wrappedCandidate, decision(), identityOf(wrappedCandidate));

    const { el: plainEl, candidate: plainCandidate } = makeCard(300);
    hide(store, plainEl, plainCandidate);

    expect(store.list().map((e) => e.videoId)).toContain('rccwrap01');
    expect(store.list().map((e) => e.videoId)).toContain('rccvid0300');
  });

  it('repeated scans under capacity pressure stay stable (no eviction churn)', () => {
    const store = new SessionRecoveryStore();
    let evictions = 0;
    store.setEvictionCallback((entry) => {
      evictions += 1;
      restore(entry.element);
    });
    const els: Element[] = [];
    for (let i = 0; i < 105; i++) {
      const { el, candidate } = makeCard(400 + i);
      hide(store, el, candidate);
      els.push(el);
    }
    const afterFirstBatch = evictions;
    expect(afterFirstBatch).toBe(5);
    // Repeated re-recording of the SAME hidden cards (rescan behavior):
    // replacements must not evict anything further.
    for (let round = 0; round < 5; round++) {
      for (let i = 95; i < 105; i++) {
        const { el, candidate } = makeCard(400 + i);
        els[i]!.remove();
        void el;
        hide(store, els[i]!, candidate);
      }
    }
    expect(evictions).toBe(afterFirstBatch);
  });
});

describe('RC blocker C: admission + orchestrator lifecycle', () => {
  function deps(): OrchestratorDeps {
    return {
      getSettings: vi.fn(async () => collapseSettings()),
      getRules: vi.fn(async () => defaultRules()),
      getCachedClassifications: vi.fn(async (inputs: readonly unknown[]) =>
        inputs.map(() => undefined),
      ),
      putCachedClassifications: vi.fn(async () => {}),
      getCorrections: vi.fn(async () => ({ notAi: false, notSlop: false })),
      recordHiddenDurable: vi.fn(async () => {}),
      applyStats: vi.fn(async () => {}),
      isRemoteProviderEnabled: () => false,
    };
  }

  /** Production-shaped wiring: reserve-before-hide + eviction reveal. */
  function wireProduction(
    orch: FilterOrchestrator,
    store: SessionRecoveryStore,
  ): { evictions: () => number } {
    let evictionCount = 0;
    let evicting = false;
    store.setEvictionCallback((entry) => {
      if (evicting) return false;
      if (!entry.element.isConnected) return true;
      evicting = true;
      try {
        restore(entry.element);
      } finally {
        evicting = false;
      }
      evictionCount += 1;
      return true;
    });
    orch.onHideRecoveryReserve = (element) => store.reserve(element);
    orch.onHideRecoveryRelease = (element) => store.releaseReservation(element);
    orch.onDecisionApplied = (element, dec, candidate, signature) => {
      if (dec.action === 'hide') store.record(element, candidate, dec, signature);
      else store.removeByElement(element);
    };
    return { evictions: () => evictionCount };
  }

  function pageWithCards(n: number, startId = 0): { main: Element; cards: Element[] } {
    const cards: Element[] = [];
    let html = '';
    for (let i = 0; i < n; i++) {
      const id = `rccvid${String(startId + i).padStart(4, '0')}`;
      html += `<ytd-rich-item-renderer data-testid="p${startId + i}"><yt-lockup-view-model data-testid="card${startId + i}">
        <a id="video-title-link" href="/watch?v=${id}" aria-label="RCC video ${startId + i}">
        <span id="video-title">RCC video ${startId + i}</span></a>
        <div id="channel-name"><a href="/channel/UCRcc0000000000000000">RCC Channel</a></div>
        <div class="badges"><span class="badge badge-shape-wiz__text">Altered or synthetic content</span></div>
      </yt-lockup-view-model></ytd-rich-item-renderer>`;
    }
    document.body.insertAdjacentHTML('beforeend', `<main id="contents">${html}</main>`);
    const main = document.querySelector('main')!;
    for (let i = 0; i < n; i++) {
      cards.push(main.querySelector(`[data-testid="card${startId + i}"]`)!);
    }
    return { main, cards };
  }

  it('reserve-before-hide: a hide only proceeds once its recovery slot is secured', async () => {
    const store = new SessionRecoveryStore();
    const orch = new FilterOrchestrator(deps());
    const w = wireProduction(orch, store);
    const { main, cards } = pageWithCards(4);
    await orch.processBatch([main]);
    for (const card of cards) {
      expect(card.getAttribute('data-bts-collapse')).not.toBeNull();
    }
    expect(store.count()).toBe(4);
    expect(w.evictions()).toBe(0);
    orch.stop();
  });

  it('admission refusal at hard capacity: the hide FAILS OPEN and other routes survive', async () => {
    const store = new SessionRecoveryStore();
    const orch = new FilterOrchestrator(deps());
    // A WEDGED reveal path: every eviction attempt fails (both throw and
    // explicit-failure variants are covered by the store-level suite).
    store.setEvictionCallback(() => false);
    orch.onHideRecoveryReserve = (element) => store.reserve(element);
    orch.onHideRecoveryRelease = (element) => store.releaseReservation(element);
    const refusals: Element[] = [];
    orch.onHideAdmissionRefused = (element) => {
      refusals.push(element);
    };
    orch.onDecisionApplied = (element, dec, candidate, signature) => {
      if (dec.action === 'hide') store.record(element, candidate, dec, signature);
      else store.removeByElement(element);
    };
    // Pre-fill the store with 100 CONNECTED hidden entries: capacity is full
    // and no slot can be secured through the failing reveal path.
    for (let i = 500; i < 600; i++) {
      const { el, candidate } = makeCard(i);
      hide(store, el, candidate);
    }
    const { main, cards } = pageWithCards(2, 700);
    await orch.processBatch([main]);
    // The new hides were REFUSED (fail open, visible) — not hidden without a
    // recovery route.
    expect(refusals).toHaveLength(2);
    for (const card of cards) {
      expect(card.getAttribute('data-bts-collapse')).toBeNull();
      expect(card.getAttribute('data-bts-state')).toBeNull();
    }
    // The 100 pre-existing hidden cards all kept their recovery routes.
    expect(store.count()).toBe(100);
    orch.stop();
  });

  it('eviction during admission preserves routes for ALL other hidden cards', async () => {
    const store = new SessionRecoveryStore();
    const orch = new FilterOrchestrator(deps());
    wireProduction(orch, store);
    // 100 pre-existing connected hidden cards, then 3 new ones: 3 oldest are
    // revealed through the eviction path during admission.
    for (let i = 600; i < 700; i++) {
      const { el, candidate } = makeCard(i);
      hide(store, el, candidate);
    }
    const { main, cards } = pageWithCards(3, 800);
    await orch.processBatch([main]);
    expect(store.count()).toBe(100);
    // The three new cards are hidden and hold recovery routes of their own.
    for (const card of cards) {
      expect(card.getAttribute('data-bts-collapse')).not.toBeNull();
    }
    // Invariant across every still-hidden card in the document.
    const allHidden = [...document.querySelectorAll('[data-bts-collapse]')];
    expect(allHidden.length).toBeGreaterThanOrEqual(100);
    const listedIds = new Set(store.list().map((e) => e.videoId));
    for (const hidden of allHidden) {
      const videoId = hidden.getAttribute('data-bts-video-id');
      // Every hidden card either has an entry or was never recorded by us.
      if (videoId?.startsWith('rccvid')) {
        expect(listedIds.has(videoId), videoId).toBe(true);
      }
    }
    orch.stop();
  });

  it('global disable: cleanupAll restores content and clears marks (no stranded hides)', async () => {
    const store = new SessionRecoveryStore();
    const orch = new FilterOrchestrator(deps());
    wireProduction(orch, store);
    const { main, cards } = pageWithCards(6);
    await orch.processBatch([main]);
    expect(store.count()).toBe(6);
    cleanupAll(document);
    for (const card of cards) {
      expect(card.getAttribute('data-bts-collapse')).toBeNull();
      expect(card.getAttribute('data-bts-state')).toBeNull();
    }
    // After cleanup NOTHING is hidden, so the recovery invariant (every
    // hidden card has a route) holds trivially; entries stay until the
    // session-scoped clear on navigation.
    expect(document.querySelectorAll('[data-bts-collapse]')).toHaveLength(0);
    orch.stop();
  });

  it('popup-style restore (session:restore semantics): true only on real restore', async () => {
    const store = new SessionRecoveryStore();
    const orch = new FilterOrchestrator(deps());
    wireProduction(orch, store);
    const { main, cards } = pageWithCards(3);
    await orch.processBatch([main]);
    const newest = store.list()[0]!; // record() unshifts: newest first.
    let restored = false;
    const ok = store.restore(newest.id, (element, signature) => {
      // validatedRestore equivalent (verified path).
      void signature;
      restore(element);
      restored = true;
      return true;
    });
    expect(ok).toBe('restored');
    expect(restored).toBe(true);
    expect(cards[2]!.getAttribute('data-bts-collapse')).toBeNull();
    // A second restore of the same id finds no entry: obsolete.
    expect(store.restore(newest.id, () => true)).toBe('obsolete');
    orch.stop();
  });

  it('navigation (clear) never fires evictions and drops all routes', async () => {
    const store = new SessionRecoveryStore();
    const onEvict = vi.fn();
    store.setEvictionCallback(onEvict);
    for (let i = 0; i < 10; i++) {
      const { el, candidate } = makeCard(900 + i);
      hide(store, el, candidate);
    }
    store.clear();
    expect(store.count()).toBe(0);
    expect(onEvict).not.toHaveBeenCalled();
  });
});
