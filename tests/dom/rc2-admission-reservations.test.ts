import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionRecoveryStore } from '@/presentation/session-recovery';
import { FilterOrchestrator, type OrchestratorDeps } from '@/pipeline/orchestrator';
import {
  applyDecision,
  ensureStyles,
  restore,
  setPresentationCallbacks,
} from '@/presentation/apply-decision';
import { defaultSettings, type UserSettings } from '@/domain/settings';
import { defaultRules } from '@/domain/rules';
import { identityOf } from '@/domain/video';
import type { NormalizedVideoCandidate } from '@/domain/video';
import type { FilterDecision } from '@/domain/decision';
import { elementFromHtml } from '../fixtures/youtube';

/**
 * RC2 issue 1 — EXPLICIT slot reservations in the REAL production wiring.
 *
 * The prior implementation only wired admission in tests; production never
 * called the store, and capacity was checked (not owned) — two overlapping
 * hides could claim the same last slot across the awaited persistence and
 * settings reads. The contract now:
 *  - the content script assigns orchestrator.onHideRecoveryReserve /
 *    onHideRecoveryRelease to the sessionRecovery store ( asserted here
 *    against the REAL content-script module, not a test helper);
 *  - reserve() takes an element-owned reservation; capacity = entries +
 *    reservations, so overlapping in-flight hides cannot double-claim;
 *  - record() commits the element's reservation after presentation;
 *  - releaseReservation() cancels it on abort (never touching records).
 *
 * The invariant: every automatically hidden connected card has a reachable
 * recovery route, or the hide fails open.
 */

function decision(): FilterDecision {
  return {
    action: 'hide',
    reason: 'user-rule',
    ruleId: 'video-block:rc2a',
    explanation: ['Hidden by your rule.'],
  };
}

function settings(): UserSettings {
  return {
    ...defaultSettings(),
    displayMode: 'collapse',
    history: { enabled: false, retentionDays: 30 },
  };
}

let seq = 0;
function candidate(videoId?: string): NormalizedVideoCandidate {
  const id = videoId ?? `rc2a${String(++seq).padStart(3, '0')}`;
  return {
    videoId: id,
    title: `RC2A video ${id}`,
    channel: { channelId: 'UCRc2a000000000000000' },
    surface: 'home',
    cardKind: 'video',
    badges: [],
    ariaLabels: [],
    metadataText: [],
    isShort: false,
    observedAt: Date.now(),
  };
}

function makeCard(i: number, videoId?: string): { el: Element; cand: NormalizedVideoCandidate } {
  const id = videoId ?? `rc2a${String(i).padStart(4, '0')}`;
  const el = elementFromHtml(
    `<ytd-rich-item-renderer data-testid="rc2a-${i}"><yt-lockup-view-model>` +
      `<a id="video-title-link" href="/watch?v=${id}" aria-label="RC2A ${i}">` +
      `<span id="video-title">RC2A ${i}</span></a>` +
      `<div id="channel-name"><a href="/channel/UCRc2a000000000000000">RC2A Ch</a></div>` +
      `</yt-lockup-view-model></ytd-rich-item-renderer>`,
  );
  document.body.appendChild(el);
  return { el, cand: candidate(id) };
}

/** Assert the invariant across ALL connected hidden cards in the document. */
function expectEveryHiddenCardHasRoute(store: SessionRecoveryStore): void {
  const routes = new Set(store.list().map((e) => e.videoId));
  const hidden = [...document.querySelectorAll('[data-bts-collapse]')];
  for (const el of hidden) {
    const videoId = el.getAttribute('data-bts-video-id');
    expect(routes.has(videoId ?? ''), `hidden card ${videoId ?? '?'} lacks a recovery route`).toBe(
      true,
    );
  }
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

describe('RC2 issue 1: reservation semantics in the store', () => {
  it('reserve() owns a slot: entries + reservations is the capacity measure', () => {
    const store = new SessionRecoveryStore();
    for (let i = 0; i < 99; i++) {
      const { el, cand } = makeCard(i);
      applyDecision(el, decision(), cand, settings());
      store.record(el, cand, decision(), identityOf(cand));
    }
    expect(store.count()).toBe(99);
    // First in-flight hide reserves the 100th slot...
    const a = elementFromHtml('<div id="a">A</div>');
    document.body.appendChild(a);
    expect(store.reserve(a)).toBe(true);
    expect(store.reservationCount()).toBe(1);
    // ...so a competing hide cannot claim the same last slot.
    const b = elementFromHtml('<div id="b">B</div>');
    document.body.appendChild(b);
    expect(store.reserve(b)).toBe(false);
  });

  it('two pending hides compete for the final slot: exactly one wins', () => {
    const store = new SessionRecoveryStore();
    for (let i = 0; i < 99; i++) {
      const { el, cand } = makeCard(i);
      applyDecision(el, decision(), cand, settings());
      store.record(el, cand, decision(), identityOf(cand));
    }
    const a = elementFromHtml('<div id="a2">A</div>');
    const b = elementFromHtml('<div id="b2">B</div>');
    document.body.appendChild(a);
    document.body.appendChild(b);
    // Both reserve "simultaneously" (before either records). Exactly one
    // can own the final slot — the loser must be refused, not double-booked.
    const first = store.reserve(a);
    const second = store.reserve(b);
    expect([first, second].filter(Boolean)).toHaveLength(1);
    expect(store.reservationCount()).toBe(1);
    // The winner commits; the loser's hide is refused (no record, no route
    // consumed, element stays visible per the orchestrator contract).
    const winner = first ? a : b;
    store.record(winner, candidate('rc2awin1'), decision(), 'sig-win');
    expect(store.reservationCount()).toBe(0);
    expect(store.count()).toBe(100);
    expectEveryHiddenCardHasRoute(store);
  });

  it('record() commits the reservation; releasing afterwards cannot delete the record', () => {
    const store = new SessionRecoveryStore();
    const { el, cand } = makeCard(900);
    expect(store.reserve(el)).toBe(true);
    expect(store.reservationCount()).toBe(1);
    applyDecision(el, decision(), cand, settings());
    store.record(el, cand, decision(), identityOf(cand));
    expect(store.count()).toBe(1);
    expect(store.reservationCount()).toBe(0); // committed
    // Releasing after commit must NOT delete the valid recovery record.
    store.releaseReservation(el);
    expect(store.count()).toBe(1);
    expect(store.list()[0]!.videoId).toBe(cand.videoId);
  });

  it('releaseReservation() never touches committed entries of other elements', () => {
    const store = new SessionRecoveryStore();
    const { el: kept, cand: keptCand } = makeCard(901);
    applyDecision(kept, decision(), keptCand, settings());
    store.record(kept, keptCand, decision(), identityOf(keptCand));
    const stranger = elementFromHtml('<div id="stranger">s</div>');
    document.body.appendChild(stranger);
    store.reserve(stranger);
    store.releaseReservation(stranger);
    expect(store.count()).toBe(1);
  });

  it('element recycling while admission is pending: detached reservation is dropped', () => {
    const store = new SessionRecoveryStore();
    const { el } = makeCard(902);
    expect(store.reserve(el)).toBe(true);
    el.remove(); // recycled/removed while the hide was in flight
    // The next admission lazily prunes the dead reservation and reuses the
    // slot (pruneDetached runs inside reserve()).
    const other = elementFromHtml('<div id="other">o</div>');
    document.body.appendChild(other);
    expect(store.reserve(other)).toBe(true);
    expect(store.hasReservation(el)).toBe(false);
    expect(store.hasReservation(other)).toBe(true);
    expect(store.reservationCount()).toBe(1);
  });

  it('history ON: same reservation flow, independent of durable writes', () => {
    const store = new SessionRecoveryStore();
    const s = { ...settings(), history: { enabled: true, retentionDays: 30 } };
    const { el, cand } = makeCard(903);
    expect(store.reserve(el)).toBe(true);
    applyDecision(el, decision(), cand, s);
    store.record(el, cand, decision(), identityOf(cand));
    expect(store.count()).toBe(1);
    expect(store.reservationCount()).toBe(0);
  });
});

describe('RC2 issue 1: PRODUCTION wiring (real content-script module)', () => {
  it('wireRecoveryAdmission (the function main() calls) wires the hooks end-to-end', async () => {
    vi.resetModules();
    // Import the REAL content-script module and use the EXACT wiring function
    // its main() calls — no test-local reimplementation of the wiring.
    const contentModule = await import('@/entrypoints/youtube.content/index');
    const { wireRecoveryAdmission } = contentModule;
    const { sessionRecovery: store } = await import('@/presentation/session-recovery');
    store.clear();
    const orch = new FilterOrchestrator({
      getSettings: vi.fn(async () => settings()),
      getRules: vi.fn(async () => defaultRules()),
      getCachedClassifications: vi.fn(async (inputs: readonly unknown[]) =>
        inputs.map(() => undefined),
      ),
      putCachedClassifications: vi.fn(async () => {}),
      getCorrections: vi.fn(async () => ({ notAi: false, notSlop: false })),
      recordHiddenDurable: vi.fn(async () => {}),
      applyStats: vi.fn(async () => {}),
      isRemoteProviderEnabled: () => false,
    });
    wireRecoveryAdmission(orch, store);
    expect(typeof orch.onHideRecoveryReserve).toBe('function');
    expect(typeof orch.onHideRecoveryRelease).toBe('function');
    // End-to-end through the wired hooks: reserve → hide → commit.
    const { el, cand } = makeCard(904);
    expect(orch.onHideRecoveryReserve!(el)).toBe(true);
    applyDecision(el, decision(), cand, settings());
    orch.onDecisionApplied?.(el, decision(), cand, identityOf(cand));
    store.record(el, cand, decision(), identityOf(cand));
    expect(store.count()).toBe(1);
    expect(store.reservationCount()).toBe(0);
    expectEveryHiddenCardHasRoute(store);
    // Release path: reservation held for an element whose hide aborts.
    const aborted = elementFromHtml('<div id="rc2abort">x</div>');
    document.body.appendChild(aborted);
    expect(orch.onHideRecoveryReserve!(aborted)).toBe(true);
    expect(store.reservationCount()).toBe(1);
    orch.onHideRecoveryRelease!(aborted);
    expect(store.reservationCount()).toBe(0);
    expect(store.count()).toBe(1); // committed record untouched
    store.clear();
    orch.stop();
  });
});

describe('RC2 issue 1: orchestrator + store end-to-end at capacity edges', () => {
  function deps(overrides: Partial<OrchestratorDeps> = {}): OrchestratorDeps {
    return {
      getSettings: vi.fn(async () => settings()),
      getRules: vi.fn(async () => defaultRules()),
      getCachedClassifications: vi.fn(async (inputs: readonly unknown[]) =>
        inputs.map(() => undefined),
      ),
      putCachedClassifications: vi.fn(async () => {}),
      getCorrections: vi.fn(async () => ({ notAi: false, notSlop: false })),
      recordHiddenDurable: vi.fn(async () => {}),
      applyStats: vi.fn(async () => {}),
      isRemoteProviderEnabled: () => false,
      ...overrides,
    };
  }

  interface Harness {
    orch: FilterOrchestrator;
    store: SessionRecoveryStore;
    refusals: Element[];
    evictions: number;
    deferredPersist: { resolve: () => void }[];
  }

  /** Production-shaped harness: reserve/release wired like the content script, deferred persistence. */
  function setup(pageCards: number, opts: { evictFails?: boolean } = {}): Harness {
    const store = new SessionRecoveryStore();
    const orch = new FilterOrchestrator(deps());
    let evicting = false;
    let evictions = 0;
    store.setEvictionCallback((entry) => {
      if (opts.evictFails) return false;
      if (evicting) return false;
      if (!entry.element.isConnected) return true;
      evicting = true;
      try {
        restore(entry.element);
      } finally {
        evicting = false;
      }
      evictions += 1;
      return true;
    });
    orch.onHideRecoveryReserve = (element) => store.reserve(element);
    orch.onHideRecoveryRelease = (element) => store.releaseReservation(element);
    const refusals: Element[] = [];
    orch.onHideAdmissionRefused = (element) => refusals.push(element);
    orch.onDecisionApplied = (element, dec, cand, signature) => {
      if (dec.action === 'hide') store.record(element, cand, dec, signature);
      else store.removeByElement(element);
    };
    // Deferred persistence: each hide's durable write resolves only when the
    // test releases it — simulating slow storage while OTHER work proceeds.
    const deferredPersist: { resolve: () => void }[] = [];
    const persistImpl = async () => {
      await new Promise<void>((resolve) => deferredPersist.push({ resolve }));
    };
    void persistImpl;
    let html = '';
    for (let i = 0; i < pageCards; i++) {
      const id = `rc2ae${String(i).padStart(4, '0')}`;
      html += `<ytd-rich-item-renderer><yt-lockup-view-model data-testid="ecard${i}">
        <a id="video-title-link" href="/watch?v=${id}" aria-label="RC2AE ${i}">
        <span id="video-title">RC2AE ${i}</span></a>
        <div id="channel-name"><a href="/channel/UCRc2a000000000000000">RC2A Ch</a></div>
        <div class="badges"><span class="badge badge-shape-wiz__text">Altered or synthetic content</span></div>
      </yt-lockup-view-model></ytd-rich-item-renderer>`;
    }
    document.body.insertAdjacentHTML('beforeend', `<main id="contents">${html}</main>`);
    return { orch, store, refusals, evictions, deferredPersist };
  }

  it('99 cards: one more hides; 100 cards: one more hides after eviction; 101: refusal at wedged eviction', async () => {
    // 99 committed + 1 new hide = exactly 100 → hide succeeds, no eviction.
    {
      const h = setup(1);
      for (let i = 0; i < 99; i++) {
        const { el, cand } = makeCard(1000 + i);
        applyDecision(el, decision(), cand, settings());
        h.store.record(el, cand, decision(), identityOf(cand));
      }
      await h.orch.processBatch([document.querySelector('main#contents')!]);
      expect(h.store.count()).toBe(100);
      expect(h.refusals).toHaveLength(0);
      expectEveryHiddenCardHasRoute(h.store);
      h.orch.stop();
    }
    // 100 committed, eviction succeeds → new hide evicts the oldest.
    {
      document.body.innerHTML = ''; // isolate invariant scans between blocks
      const h = setup(1);
      for (let i = 0; i < 100; i++) {
        const { el, cand } = makeCard(1100 + i);
        applyDecision(el, decision(), cand, settings());
        h.store.record(el, cand, decision(), identityOf(cand));
      }
      await h.orch.processBatch([document.querySelector('main#contents')!]);
      expect(h.store.count()).toBe(100);
      expectEveryHiddenCardHasRoute(h.store);
      h.orch.stop();
    }
    // 100 committed, eviction ALWAYS fails → refusal (fail open).
    {
      document.body.innerHTML = ''; // isolate invariant scans between blocks
      const h = setup(1, { evictFails: true });
      for (let i = 0; i < 100; i++) {
        const { el, cand } = makeCard(1200 + i);
        applyDecision(el, decision(), cand, settings());
        h.store.record(el, cand, decision(), identityOf(cand));
      }
      await h.orch.processBatch([document.querySelector('main#contents')!]);
      expect(h.refusals).toHaveLength(1);
      expect(h.store.count()).toBe(100);
      expectEveryHiddenCardHasRoute(h.store);
      h.orch.stop();
    }
  });

  it('250 cards with successful evictions: invariant holds across every hidden card', async () => {
    const h = setup(0);
    for (let i = 0; i < 250; i++) {
      const { el, cand } = makeCard(1300 + i);
      applyDecision(el, decision(), cand, settings());
      h.store.record(el, cand, decision(), identityOf(cand));
    }
    await h.orch.processBatch([document.querySelector('main#contents')!]);
    expect(h.store.count()).toBe(100);
    expectEveryHiddenCardHasRoute(h.store);
    h.orch.stop();
  });

  it('duplicate sightings of one element: one reservation, one record', () => {
    const store = new SessionRecoveryStore();
    const { el, cand } = makeCard(1400);
    expect(store.reserve(el)).toBe(true);
    store.record(el, cand, decision(), identityOf(cand));
    for (let i = 0; i < 20; i++) {
      store.record(el, cand, decision(), identityOf(cand));
    }
    expect(store.count()).toBe(1);
    expect(store.reservationCount()).toBe(0);
  });

  it('different elements displaying the same video: each gets its own route', () => {
    const store = new SessionRecoveryStore();
    const sharedVideo = 'rc2ashared';
    const one = makeCard(1401, sharedVideo);
    const two = makeCard(1402, sharedVideo);
    applyDecision(one.el, decision(), one.cand, settings());
    store.record(one.el, one.cand, decision(), identityOf(one.cand));
    applyDecision(two.el, decision(), two.cand, settings());
    store.record(two.el, two.cand, decision(), identityOf(two.cand));
    expect(store.count()).toBe(2);
    const routes = store.list().filter((e) => e.videoId === sharedVideo);
    expect(routes).toHaveLength(2);
  });

  it('deferred persistence + disable: reservation released, no leak, card visible', async () => {
    const store = new SessionRecoveryStore();
    let resolvePersist: (() => void) | undefined;
    let enabled = true;
    const orch = new FilterOrchestrator({
      ...deps(),
      getSettings: vi.fn(async () => ({
        ...settings(),
        enabled,
        history: { enabled: true, retentionDays: 30 }, // durable writes ON so persistence is awaited
      })),
      recordHiddenDurable: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            resolvePersist = resolve;
          }),
      ),
    });
    store.setEvictionCallback(() => true);
    orch.onHideRecoveryReserve = (element) => store.reserve(element);
    orch.onHideRecoveryRelease = (element) => store.releaseReservation(element);
    orch.onDecisionApplied = (element, dec, cand, signature) => {
      if (dec.action === 'hide') store.record(element, cand, dec, signature);
      else store.removeByElement(element);
    };
    document.body.innerHTML = `<main id="contents"><ytd-rich-item-renderer><yt-lockup-view-model>
      <a id="video-title-link" href="/watch?v=rc2adef01" aria-label="Deferred">
      <span id="video-title">Deferred</span></a>
      <div id="channel-name"><a href="/channel/UCRc2a000000000000000">RC2A Ch</a></div>
      <div class="badges"><span class="badge badge-shape-wiz__text">Altered or synthetic content</span></div>
    </yt-lockup-view-model></ytd-rich-item-renderer></main>`;
    const main = document.querySelector('main#contents')!;
    const batch = orch.processBatch([main]);
    await new Promise((r) => setTimeout(r, 30));
    // Reservation held while persistence is in flight:
    expect(store.reservationCount()).toBe(1);
    expect(store.count()).toBe(0);
    // Disable while the hide is pending, then let persistence resolve:
    enabled = false;
    resolvePersist!();
    await batch;
    // The hide aborted (disabled): card not hidden, reservation released.
    expect(document.querySelectorAll('[data-bts-collapse]')).toHaveLength(0);
    expect(store.reservationCount()).toBe(0);
    expect(store.count()).toBe(0);
    orch.stop();
  });

  it('repeated rescans under capacity pressure: no eviction churn', async () => {
    const store = new SessionRecoveryStore();
    let evictions = 0;
    store.setEvictionCallback((entry) => {
      evictions += 1;
      restore(entry.element);
      return true;
    });
    const hidden = new Map<number, { el: Element; cand: NormalizedVideoCandidate }>();
    for (let i = 0; i < 105; i++) {
      const { el, cand } = makeCard(1500 + i);
      applyDecision(el, decision(), cand, settings());
      store.record(el, cand, decision(), identityOf(cand));
      hidden.set(i, { el, cand });
    }
    const baseline = evictions;
    expect(baseline).toBe(5);
    // Simulate repeated rescans re-recording the same hidden cards: they are
    // already recoverable, so no eviction may fire and counts stay exact.
    for (let round = 0; round < 4; round++) {
      for (let i = 95; i < 105; i++) {
        const { el, cand } = hidden.get(i)!;
        store.record(el, cand, decision(), identityOf(cand));
      }
    }
    expect(evictions).toBe(baseline);
    expect(store.count()).toBe(100);
    expectEveryHiddenCardHasRoute(store);
  });
});
