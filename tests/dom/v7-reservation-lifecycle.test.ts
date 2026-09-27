import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FilterOrchestrator } from '@/pipeline/orchestrator';
import { SessionRecoveryStore } from '@/presentation/session-recovery';
import { ensureStyles, setPresentationCallbacks } from '@/presentation/apply-decision';
import { defaultSettings, type UserSettings } from '@/domain/settings';
import { defaultRules } from '@/domain/rules';
import { identityOf } from '@/domain/video';
import type { NormalizedVideoCandidate } from '@/domain/video';
import type { FilterDecision } from '@/domain/decision';
import { parseDiscovered, cardKindOf } from '@/youtube/discover';
import { currentPageContext } from '@/youtube/routes';
import { elementFromHtml } from '../fixtures/youtube';

/**
 * V7 audit: reservation OWNERSHIP through the hide lifecycle.
 *
 * Reported failures (independently reproduced, both ending with
 * `reservationsLeft: 1, hidden: false, recoveryEntries: 0`):
 *  A. "Show once" arrives while a hide is awaiting persistence — the
 *     pipeline takes the override return path WITHOUT releasing its
 *     reservation.
 *  B. The FINAL getSettings() rejects after a reservation was obtained —
 *     the exception exits processCard without releasing.
 *
 * Repeated leaks exhaust the bounded recovery capacity. The contract: a hide
 * must release its reservation on EVERY return/throw after reserve, never
 * release another operation's reservation, and never delete a committed
 * recovery record when releasing. Every await before presentation must be
 * followed by freshness checks (generation, connectivity, settings, surface,
 * identity, override). A settings-read failure must FAIL OPEN (card stays
 * visible) without an unhandled rejection. Tests exercise the REAL production
 * wiring (orchestrator + SessionRecoveryStore hooks), never a test-local
 * idealization.
 */

const DISCLOSURE_BADGE =
  '<div class="badges"><span class="badge badge-shape-wiz__text">Altered or synthetic content</span></div>';

function decision(): FilterDecision {
  return {
    action: 'hide',
    reason: 'user-rule',
    ruleId: 'video-block:v7res',
    explanation: ['Hidden by your rule.'],
  };
}

function settings(): UserSettings {
  return {
    ...defaultSettings(),
    displayMode: 'collapse',
    history: { enabled: true, retentionDays: 30 }, // durable write ON: persistence is awaited
  };
}

let seq = 0;
function candidate(videoId?: string): NormalizedVideoCandidate {
  const id = videoId ?? `v7res${String(++seq).padStart(4, '0')}`;
  return {
    videoId: id,
    title: `V7 reservation ${id}`,
    channel: { channelId: 'UCV7Res000000000000000' },
    surface: 'unknown',
    cardKind: 'video',
    badges: [],
    ariaLabels: [],
    metadataText: [],
    isShort: false,
    observedAt: Date.now(),
  };
}

/** Returns the CARD element the pipeline discovers (the inner lockup). */
function makeCard(id: string): { card: Element; wrapper: Element } {
  const wrapper = elementFromHtml(
    `<ytd-rich-item-renderer data-testid="v7res-${id}"><yt-lockup-view-model>` +
      `<a id="video-title-link" href="/watch?v=${id}" aria-label="V7 reservation ${id}">` +
      `<span id="video-title">V7 reservation ${id}</span></a>` +
      `<div id="channel-name"><a href="/channel/UCV7Res000000000000000">V7 Ch</a></div>` +
      DISCLOSURE_BADGE +
      `</yt-lockup-view-model></ytd-rich-item-renderer>`,
  );
  document.body.appendChild(wrapper);
  const card = wrapper.querySelector('yt-lockup-view-model')!;
  return { card, wrapper };
}

/** Identity exactly as production derives it (re-parse at call time). */
function signatureOf(card: Element): string {
  return identityOf(
    parseDiscovered(
      { element: card, kind: cardKindOf(card) },
      currentPageContext().surface,
      Date.now(),
    ),
  );
}

/** Controllable deferred for explicit synchronization (no timing sleeps). */
function deferred<T>(): {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
} {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

interface Harness {
  orch: FilterOrchestrator;
  store: SessionRecoveryStore;
  durableWrites: () => number;
  persistenceFailures: () => number;
}

/**
 * Production-shaped harness: the EXACT wiring the content script installs
 * (wireRecoveryAdmission) plus the onDecisionApplied record commit.
 * `finalRead` replaces every getSettings call from the 3rd call on —
 * call 1 = batch start, call 2 = DOM-14 read, call 3 = FINAL pre-presentation read.
 */
function setup(
  opts: { finalRead?: Promise<UserSettings>; deferredPersist?: Promise<void> } = {},
): Harness {
  let settingsCalls = 0;
  const store = new SessionRecoveryStore();
  let durableWrites = 0;
  let persistenceFailures = 0;
  const orch = new FilterOrchestrator({
    getSettings: vi.fn(async () => {
      settingsCalls += 1;
      if (opts.finalRead !== undefined && settingsCalls >= 3) return opts.finalRead;
      return settings();
    }),
    getRules: vi.fn(async () => defaultRules()),
    getCachedClassifications: vi.fn(async (inputs: readonly unknown[]) =>
      inputs.map(() => undefined),
    ),
    putCachedClassifications: vi.fn(async () => {}),
    getCorrections: vi.fn(async () => ({ notAi: false, notSlop: false })),
    recordHiddenDurable: vi.fn(async () => {
      durableWrites += 1;
      if (opts.deferredPersist !== undefined) await opts.deferredPersist;
    }),
    applyStats: vi.fn(async () => {}),
    isRemoteProviderEnabled: () => false,
  });
  // wireRecoveryAdmission (production wiring, extracted in the content script):
  orch.onHideRecoveryReserve = (element) => store.reserve(element);
  orch.onHideRecoveryRelease = (element) => store.releaseReservation(element);
  orch.onHidePersistenceFailed = () => {
    persistenceFailures += 1;
  };
  // Production commit path (mirrors the content script's onDecisionApplied):
  orch.onDecisionApplied = (element, dec, cand, signature) => {
    if (dec.action === 'hide') store.record(element, cand, dec, signature);
    else store.removeByElement(element);
  };
  return {
    orch,
    store,
    durableWrites: () => durableWrites,
    persistenceFailures: () => persistenceFailures,
  };
}

/** Unhandled-rejection sentinel for the settings-reject case. */
function trackUnhandled(): { list: PromiseRejectionEvent[]; dispose: () => void } {
  const list: PromiseRejectionEvent[] = [];
  const handler = (event: PromiseRejectionEvent): void => {
    list.push(event);
  };
  // Structural Node process access (the DOM tsconfig scope has no @types/node):
  // the runtime under vitest is Node, so these APIs exist at run time.
  type NodeProcessLike = {
    on(event: 'unhandledRejection', handler: (event: PromiseRejectionEvent) => void): unknown;
    off(event: 'unhandledRejection', handler: (event: PromiseRejectionEvent) => void): unknown;
  };
  const nodeProcess = globalThis as unknown as { process?: NodeProcessLike };
  nodeProcess.process?.on('unhandledRejection', handler);
  return {
    list,
    dispose: () => nodeProcess.process?.off('unhandledRejection', handler),
  };
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

describe('V7 reservation lifecycle: reported failures', () => {
  it('Case A: show once during deferred persistence releases the unused reservation', async () => {
    const persist = deferred<void>();
    const h = setup({ deferredPersist: persist.promise });
    const { card } = makeCard('v7resa001');
    const batch = h.orch.processBatch([document.body]);
    // Hide is awaiting the durable write; reservation is held in flight.
    await vi.waitFor(() => expect(h.store.reservationCount()).toBe(1));
    // User clicks Show once while persistence is still in flight.
    h.orch.showOnce(card, signatureOf(card));
    persist.resolve();
    await batch;
    // Card visible, no unused reservation, no unintended recovery record.
    expect(card.getAttribute('data-bts-state')).not.toBe('hidden');
    expect(card.getAttribute('data-bts-collapse')).toBeNull();
    expect(h.store.reservationCount()).toBe(0);
    expect(h.store.count()).toBe(0);
  });

  it('Case B: final settings read rejects after reserve — fail open, reservation released, no unhandled rejection', async () => {
    const unhandled = trackUnhandled();
    try {
      const finalRead = deferred<UserSettings>();
      const h = setup({ finalRead: finalRead.promise });
      const { card } = makeCard('v7resb001');
      const batch = h.orch.processBatch([document.body]);
      // Reservation held while the FINAL settings read pends; the durable
      // write already committed (it precedes the final read).
      await vi.waitFor(() => expect(h.store.reservationCount()).toBe(1));
      expect(h.durableWrites()).toBe(1);
      // The read REJECTS — the hide must abort cleanly and fail open.
      finalRead.reject(new Error('settings storage unavailable'));
      await batch; // must not reject the batch (no unhandled rejection in production)
      // The card stays visible (fail open) and the slot is free again.
      expect(card.getAttribute('data-bts-state')).not.toBe('hidden');
      expect(card.getAttribute('data-bts-collapse')).toBeNull();
      expect(h.store.reservationCount()).toBe(0);
      expect(h.store.count()).toBe(0);
      // Give the event loop a turn for any unhandled rejection to surface.
      await new Promise((r) => setTimeout(r, 20));
      expect(unhandled.list).toHaveLength(0);
    } finally {
      unhandled.dispose();
    }
  });
});

describe('V7 reservation lifecycle: extended ownership contract', () => {
  it('settings read remains pending while navigation changes generation — released, no stale application, no record', async () => {
    const finalRead = deferred<UserSettings>();
    const h = setup({ finalRead: finalRead.promise });
    const { card } = makeCard('v7resg001');
    const batch = h.orch.processBatch([document.body]);
    await vi.waitFor(() => expect(h.store.reservationCount()).toBe(1));
    h.orch.stop(); // generation bump — the strongest invalidation
    finalRead.resolve(settings());
    await batch;
    // Freshness after the final await: a stale generation must NEVER apply.
    expect(card.getAttribute('data-bts-state')).not.toBe('hidden');
    expect(h.store.reservationCount()).toBe(0);
    expect(h.store.count()).toBe(0);
  });

  it('disable while pending releases the reservation and shows the card', async () => {
    const finalRead = deferred<UserSettings>();
    const h = setup({ finalRead: finalRead.promise });
    const { card } = makeCard('v7resd001');
    const batch = h.orch.processBatch([document.body]);
    await vi.waitFor(() => expect(h.store.reservationCount()).toBe(1));
    finalRead.resolve({ ...settings(), enabled: false });
    await batch;
    expect(card.getAttribute('data-bts-state')).not.toBe('hidden');
    expect(h.store.reservationCount()).toBe(0);
  });

  it('surface disabled while pending releases the reservation', async () => {
    const finalRead = deferred<UserSettings>();
    const h = setup({ finalRead: finalRead.promise });
    const { card } = makeCard('v7ress001');
    const batch = h.orch.processBatch([document.body]);
    await vi.waitFor(() => expect(h.store.reservationCount()).toBe(1));
    finalRead.resolve({ ...settings(), surfaces: { ...settings().surfaces, home: false } });
    await batch;
    expect(card.getAttribute('data-bts-state')).not.toBe('hidden');
    expect(h.store.reservationCount()).toBe(0);
  });

  it('element detaches while pending releases the reservation', async () => {
    const finalRead = deferred<UserSettings>();
    const h = setup({ finalRead: finalRead.promise });
    const { card } = makeCard('v7resx001');
    const batch = h.orch.processBatch([document.body]);
    await vi.waitFor(() => expect(h.store.reservationCount()).toBe(1));
    card.remove();
    finalRead.resolve(settings());
    await batch;
    expect(h.store.reservationCount()).toBe(0);
    expect(h.store.count()).toBe(0);
  });

  it('A→B identity recycling during the final settings await releases (A owns nothing after)', async () => {
    const finalRead = deferred<UserSettings>();
    const h = setup({ finalRead: finalRead.promise });
    const { card } = makeCard('v7resr001');
    const batch = h.orch.processBatch([document.body]);
    await vi.waitFor(() => expect(h.store.reservationCount()).toBe(1));
    // YouTube recycled the card to video B while the read was in flight.
    card.querySelector('a')!.setAttribute('href', '/watch?v=v7resother1');
    card.querySelector('#video-title')!.textContent = 'Recycled video B';
    finalRead.resolve(settings());
    await batch;
    expect(card.getAttribute('data-bts-state')).not.toBe('hidden');
    expect(h.store.reservationCount()).toBe(0);
    expect(h.store.count()).toBe(0);
  });

  it('persistence failure releases the reservation and never creates a record', async () => {
    const store = new SessionRecoveryStore();
    let persistenceFailed = 0;
    const orch = new FilterOrchestrator({
      getSettings: vi.fn(async () => settings()),
      getRules: vi.fn(async () => defaultRules()),
      getCachedClassifications: vi.fn(async (inputs: readonly unknown[]) =>
        inputs.map(() => undefined),
      ),
      putCachedClassifications: vi.fn(async () => {}),
      getCorrections: vi.fn(async () => ({ notAi: false, notSlop: false })),
      recordHiddenDurable: vi.fn(async () => {
        throw new Error('storage write failed');
      }),
      applyStats: vi.fn(async () => {}),
      isRemoteProviderEnabled: () => false,
    });
    orch.onHideRecoveryReserve = (element) => store.reserve(element);
    orch.onHideRecoveryRelease = (element) => store.releaseReservation(element);
    orch.onHidePersistenceFailed = () => {
      persistenceFailed += 1;
    };
    const { card } = makeCard('v7resf001');
    await orch.processBatch([document.body]);
    expect(persistenceFailed).toBe(1);
    expect(card.getAttribute('data-bts-state')).not.toBe('hidden');
    expect(store.reservationCount()).toBe(0);
    expect(store.count()).toBe(0);
  });

  it('show-once override during the final settings await releases the reservation', async () => {
    const finalRead = deferred<UserSettings>();
    const h = setup({ finalRead: finalRead.promise });
    const { card } = makeCard('v7reso001');
    const batch = h.orch.processBatch([document.body]);
    await vi.waitFor(() => expect(h.store.reservationCount()).toBe(1));
    h.orch.showOnce(card, signatureOf(card));
    finalRead.resolve(settings());
    await batch;
    expect(card.getAttribute('data-bts-state')).not.toBe('hidden');
    expect(h.store.reservationCount()).toBe(0);
    expect(h.store.count()).toBe(0);
  });

  it('existing committed entry plus aborted reprocessing never deletes the record', async () => {
    const finalRead = deferred<UserSettings>();
    const h = setup({ finalRead: finalRead.promise });
    const { card } = makeCard('v7resc001');
    const cand = candidate('v7resc001');
    // Committed recovery entry from an earlier hide of the SAME element:
    h.store.record(card, cand, decision(), identityOf(cand));
    expect(h.store.count()).toBe(1);
    // Reprocessing aborts (disable during the final read):
    const batch = h.orch.processBatch([document.body]);
    finalRead.resolve({ ...settings(), enabled: false });
    await batch;
    // The committed entry SURVIVES the abort (releases never delete records).
    expect(h.store.count()).toBe(1);
    expect(h.store.list()[0]!.videoId).toBe('v7resc001');
    expect(h.store.reservationCount()).toBe(0);
  });

  it('two elements competing for the last slot: exactly one wins, loser owns nothing', async () => {
    const store = new SessionRecoveryStore();
    for (let i = 0; i < 99; i++) {
      const el = makeCard(`v7resfill${String(i).padStart(3, '0')}`).card;
      store.record(el, candidate(`v7resfill${String(i).padStart(3, '0')}`), decision(), 'sig');
    }
    expect(store.count()).toBe(99);
    const a = makeCard('v7reswina').card;
    const b = makeCard('v7reswinb').card;
    expect(store.reserve(a)).toBe(true);
    expect(store.reserve(b)).toBe(false); // refused: card stays visible, no reservation owned
    expect(store.reservationCount()).toBe(1);
    store.record(a, candidate('v7reswina'), decision(), identityOf(candidate('v7reswina')));
    expect(store.reservationCount()).toBe(0);
    expect(store.count()).toBe(100);
    store.releaseReservation(b); // releasing a non-owner must be a no-op
    expect(store.count()).toBe(100);
    expect(store.reservationCount()).toBe(0);
  });

  it('repeated aborted operations never reduce usable capacity', async () => {
    // Each abort uses a FRESH deferred final read; every abort ends with the
    // baseline restored (0 reservations) before the next one starts.
    for (let round = 0; round < 20; round++) {
      const finalRead = deferred<UserSettings>();
      const h = setup({ finalRead: finalRead.promise });
      makeCard(`v7resab${String(round).padStart(3, '0')}`);
      const batch = h.orch.processBatch([document.body]);
      await vi.waitFor(() => expect(h.store.reservationCount()).toBe(1));
      finalRead.resolve({ ...settings(), enabled: false });
      await batch;
      // Baseline restored after EVERY aborted operation:
      expect(h.store.reservationCount()).toBe(0);
      expect(h.orch.inFlight.size).toBe(0);
      h.orch.stop();
    }
    // A subsequent valid hide can still obtain capacity and complete.
    const h = setup();
    const { card: good } = makeCard('v7resgood1');
    await h.orch.processBatch([document.body]);
    expect(good.getAttribute('data-bts-state')).toBe('hidden');
    expect(h.store.count()).toBe(1);
    expect(h.store.reservationCount()).toBe(0);
  });
});
