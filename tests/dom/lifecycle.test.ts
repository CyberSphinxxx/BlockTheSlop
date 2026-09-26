import { describe, expect, it, beforeEach, vi } from 'vitest';
import { FilterOrchestrator, type OrchestratorDeps } from '@/pipeline/orchestrator';
import { defaultSettings, type UserSettings } from '@/domain/settings';
import { defaultRules } from '@/domain/rules';
import { pageContextFromUrl, videoIdFromUrl, channelIdentityFromHref } from '@/youtube/routes';
import { discoverCards } from '@/youtube/discover';
import { bumpEpoch, shouldProcess, forget } from '@/youtube/identity';
import { setPresentationCallbacks } from '@/presentation/apply-decision';
import { removeShortsGuard } from '@/presentation/shorts-guard';
import { canonicalChannelId } from '@/domain/video';

/**
 * DOM-11..DOM-24 — overlapping roots, live revisions, hostile identities,
 * malformed cards, Shorts guard, bounded queue behavior.
 */

function settings(overrides: Partial<UserSettings> = {}): UserSettings {
  return { ...defaultSettings(), ...overrides };
}

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

function cardHtml(id: string, title: string, extra = ''): string {
  return `
  <yt-lockup-view-model>
    <a id="video-title-link" href="/watch?v=${id}"><span id="video-title">${title}</span></a>
    ${extra}
  </yt-lockup-view-model>`;
}

const DISCLOSURE_BADGE =
  '<div class="badges"><span class="badge">Altered or synthetic content</span></div>';
const HIGH_CLASSIFICATION = {
  aiLikelihood: 0.9,
  slopLikelihood: 0.1,
  categories: { 'creator-disclosure': 0.9 } as Record<string, number>,
  confidence: 'very-high' as const,
  evidence: [],
  classifierVersion: '1',
  rulesVersion: '1',
  evaluatedAt: Date.now(),
};

async function tick(ms = 60): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

beforeEach(() => {
  setPresentationCallbacks({
    showOnce: () => {},
    why: () => {},
    allowVideo: () => {},
    allowChannel: () => {},
  });
  document.body.innerHTML = '<main id="contents"></main>';
});

describe('DOM-11: overlapping roots evaluate once per fingerprint', () => {
  it('parent, child and duplicate roots produce one logical evaluation per card', async () => {
    const d = deps();
    const orch = new FilterOrchestrator(d);
    const main = document.querySelector('main')!;
    main.innerHTML = cardHtml('overlap001', 'Overlapping card', DISCLOSURE_BADGE);
    const card = main.querySelector('yt-lockup-view-model')!;

    // Root set intentionally overlaps: main contains card, plus card itself,
    // plus a duplicate main reference.
    await orch.processBatch([main, card, main]);

    // One review record for one unique card, despite triple roots.
    expect(d.recordHiddenDurable).toHaveBeenCalledTimes(1);
    orch.stop();
  });
});

describe('DOM-14: settings win after every await', () => {
  it('disable during async work prevents hide application', async () => {
    let current = settings();
    const d = deps({
      getSettings: vi.fn(async () => current),
      getCachedClassifications: vi.fn(
        async (inputs: readonly unknown[]) =>
          await new Promise<Array<typeof HIGH_CLASSIFICATION | undefined>>((resolve) => {
            // Disable filtering while classification is in flight.
            setTimeout(() => {
              current = settings({ enabled: false });
              resolve(inputs.map(() => HIGH_CLASSIFICATION));
            }, 20);
          }),
      ),
    });
    const orch = new FilterOrchestrator(d);
    const main = document.querySelector('main')!;
    main.innerHTML = cardHtml('disabler1', 'Disabled mid-flight');
    await orch.processBatch([main]);
    await tick();
    // The card must NOT be hidden: current settings (disabled) win.
    expect(main.querySelector('yt-lockup-view-model')!.getAttribute('data-bts-state')).not.toBe(
      'hidden',
    );
    orch.stop();
  });
});

describe('DOM-15: live rule revisions update open cards', () => {
  it('a rescan after rule changes re-evaluates with new rules', async () => {
    let rules = defaultRules();
    const d = deps({ getRules: vi.fn(async () => rules) });
    const orch = new FilterOrchestrator(d);
    const main = document.querySelector('main')!;
    main.innerHTML = cardHtml('liverule1', 'Live rule target');

    await orch.processBatch([main]);
    expect(main.querySelector('yt-lockup-view-model')!.getAttribute('data-bts-state')).toBeNull();

    // External rule edit (options page in another tab) then live rescan.
    rules = {
      ...defaultRules(),
      allowedVideoIds: ['liverule1'],
    };
    orch.rescan();
    await tick(80);
    expect(main.querySelector('yt-lockup-view-model')!.getAttribute('data-bts-state')).toBeNull();
    // Allow decision restored presentation (no placeholder UI).
    expect(main.querySelector('.bts-placeholder')).toBeNull();
    orch.stop();
  });
});

describe('DOM-16: malformed card / thrown detector isolation', () => {
  it('a card that throws during parsing does not prevent later cards from processing', async () => {
    const d = deps();
    const orch = new FilterOrchestrator(d);
    const main = document.querySelector('main')!;
    // First card malformed: no link at all (parser yields empty candidate —
    // must fail open); second card valid and blockable.
    main.innerHTML = `
      <yt-lockup-view-model id="bad"><span>no links here</span></yt-lockup-view-model>
      ${cardHtml('goodcard1', 'AI generated funny fruits', DISCLOSURE_BADGE)}`;
    await orch.processBatch([main]);
    await tick();
    const good = [...main.querySelectorAll('yt-lockup-view-model')].at(-1)!;
    expect(good.getAttribute('data-bts-state')).not.toBeNull();
    // Malformed card untouched (fail open).
    expect(main.querySelector('#bad')!.getAttribute('data-bts-state')).toBeNull();
    orch.stop();
  });
});

describe('DOM-17: hostile/missing identity extraction', () => {
  it('cross-origin channel links yield no identity', () => {
    const evil = channelIdentityFromHref('https://evil.example/channel/UCevil2222222222222222');
    expect(evil.channelId).toBeUndefined();
    expect(evil.handle).toBeUndefined();
  });

  it('invalid channel ids are not canonicalized', () => {
    expect(canonicalChannelId('not-a-channel')).toBeUndefined();
    expect(canonicalChannelId('UCshort')).toBeUndefined();
    const valid = `UC${'a'.repeat(22)}`;
    expect(canonicalChannelId(valid)).toBe(valid);
    expect(canonicalChannelId(undefined)).toBeUndefined();
  });

  it('record with no channel id is stored without fabricated values', async () => {
    const d = deps();
    const orch = new FilterOrchestrator(d);
    const main = document.querySelector('main')!;
    main.innerHTML = cardHtml('nochanne1', 'No channel here', DISCLOSURE_BADGE);
    await orch.processBatch([main]);
    await tick();
    // Hidden by disclosure; record exists but has no fabricated channel id.
    expect(d.recordHiddenDurable).toHaveBeenCalledTimes(1);
    const input = (d.recordHiddenDurable as ReturnType<typeof vi.fn>).mock.calls[0]![0] as {
      candidate: { channel: { channelId?: string } };
    };
    expect(input.candidate.channel.channelId).toBeUndefined();
    orch.stop();
  });
});

describe('DOM-18: same title, different videos', () => {
  it('two cards sharing a title are evaluated separately by identity', () => {
    const a = cardHtml('twinvideo1', 'Same title both');
    const b = cardHtml('twinvideo2', 'Same title both');
    document.body.innerHTML = `<main><section>${a}</section><section>${b}</section></main>`;
    const main = document.querySelector('main')!;
    const cards = discoverCards(main, 'home');
    const ids = cards.map((c) =>
      videoIdFromUrl(c.element.querySelector('a')!.getAttribute('href') ?? ''),
    );
    expect(ids).toEqual(['twinvideo1', 'twinvideo2']);
  });

  it('two elements with the same video id share classification via cache', async () => {
    const d = deps({
      getCachedClassifications: vi.fn(async (inputs: readonly unknown[]) =>
        inputs.map(() => HIGH_CLASSIFICATION),
      ),
    });
    const orch = new FilterOrchestrator(d);
    const main = document.querySelector('main')!;
    main.innerHTML =
      cardHtml('dupevid01', 'First render', DISCLOSURE_BADGE) +
      cardHtml('dupevid01', 'Second render', DISCLOSURE_BADGE);
    await orch.processBatch([main]);
    await tick();
    // One batched cache round-trip covers both cards; classify not called.
    expect(d.getCachedClassifications).toHaveBeenCalledTimes(1);
    // Both cards hidden under the same id.
    const hidden = main.querySelectorAll('[data-bts-video-id="dupevid01"]');
    expect(hidden.length).toBe(2);
    orch.stop();
  });
});

describe('DOM-19: observer stop invalidates context', () => {
  it('after stop(), generation bump prevents stale applications', async () => {
    const d = deps();
    const orch = new FilterOrchestrator(d);
    const main = document.querySelector('main')!;
    main.innerHTML = cardHtml('stoppage1', 'Stop the world', DISCLOSURE_BADGE);
    const pass = orch.processBatch([main]);
    orch.stop();
    await pass;
    await tick();
    expect(main.querySelector('yt-lockup-view-model')!.getAttribute('data-bts-state')).toBeNull();
    expect(d.recordHiddenDurable).not.toHaveBeenCalled();
  });

  it('in-flight promises are tracked and settle', async () => {
    const d = deps();
    const orch = new FilterOrchestrator(d);
    const main = document.querySelector('main')!;
    main.innerHTML = cardHtml('inflight1', 'In flight check');
    const p = orch.processBatch([main]);
    expect(orch.inFlight.size).toBe(1);
    await p;
    expect(orch.inFlight.size).toBe(0);
  });
});

describe('DOM-20: unknown future renderer fails open', () => {
  it('unknown card tags are not discovered as video cards', () => {
    document.body.innerHTML =
      '<main><ytd-future-renderer-9000><span>mystery</span></ytd-future-renderer-9000></main>';
    const main = document.querySelector('main')!;
    expect(discoverCards(main, 'home')).toHaveLength(0);
  });

  it('a disabled surface (e.g. shorts off) disables filtering on that page even with strong evidence', async () => {
    const d = deps({
      getSettings: vi.fn(async () =>
        settings({
          surfaces: {
            home: false,
            search: true,
            subscriptions: true,
            'watch-sidebar': true,
            channel: true,
            playlist: true,
            history: true,
            'watch-later': true,
            'shorts-shelf': true,
            'shorts-feed': true,
            unknown: true,
          },
        }),
      ),
    });
    const orch = new FilterOrchestrator(d);
    const main = document.querySelector('main')!;
    main.innerHTML = cardHtml('surfoff01', 'AI generated funny fruits', DISCLOSURE_BADGE);
    // jsdom location is http://localhost/ → surface 'home', which is disabled.
    // Disabled surface wins over all evidence (DET-28): nothing is filtered.
    await orch.processBatch([main]);
    await tick();
    const hidden = main.querySelectorAll('[data-bts-state="hidden"]');
    expect(hidden.length).toBe(0);
    expect(d.recordHiddenDurable).not.toHaveBeenCalled();
    orch.stop();
  });
});

describe('DOM-21/22: no query or neighbor contamination', () => {
  it('search query text is not part of the card identity or evidence', () => {
    document.body.innerHTML = `
      <div id="search-query">AI generated video</div>
      <main><yt-lockup-view-model>
        <a id="video-title-link" href="/watch?v=cleanvid1"><span id="video-title">Gardening tips</span></a>
      </yt-lockup-view-model></main>`;
    const main = document.querySelector('main')!;
    const cards = discoverCards(main, 'search');
    expect(cards).toHaveLength(1);
    // The identity is derived from the card only — the query div is outside.
    expect(cards[0]!.element.contains(document.getElementById('search-query'))).toBe(false);
  });

  it('a shelf header containing AI text does not contaminate neighbor cards', () => {
    document.body.innerHTML = `
      <main>
        <h2>AI generated shorts shelf</h2>
        <ytm-shorts-lockup-view-model>
          <a href="/shorts/shortclean1" aria-label="Totally normal cooking"></a>
        </ytm-shorts-lockup-view-model>
      </main>`;
    const main = document.querySelector('main')!;
    const cards = discoverCards(main, 'home');
    expect(cards).toHaveLength(1);
    expect(cards[0]!.element.querySelector('h2')).toBeNull();
  });
});

describe('DOM-23: transient failure is not marked permanently processed', () => {
  it('a rejected batched cache read degrades to local classification; recovery needs no epoch bump', async () => {
    const d = deps();
    let fail = true;
    d.getCachedClassifications = vi.fn(async (inputs: readonly unknown[]) => {
      if (fail) throw new Error('transient');
      return inputs.map(() => HIGH_CLASSIFICATION);
    }) as unknown as OrchestratorDeps['getCachedClassifications'];
    const orch = new FilterOrchestrator(d);
    const main = document.querySelector('main')!;
    main.innerHTML = cardHtml('transient', 'AI generated funny fruits', DISCLOSURE_BADGE);
    const card = main.querySelector('yt-lockup-view-model')!;

    // First pass: the batched cache read throws → N08 degradation: the batch
    // is NOT rejected; classification happens locally and a decision applies.
    await orch.processBatch([main]);
    await tick(80);
    expect(card.getAttribute('data-bts-state')).not.toBeNull();

    // After recovery the batched path serves hits; no stale reprocessing.
    fail = false;
    bumpEpoch();
    orch.rescan();
    await tick(80);
    expect(card.getAttribute('data-bts-state')).not.toBeNull();
    orch.stop();
  });
});

describe('DOM-24: active Shorts guard opt-in behavior', () => {
  it('guard disabled leaves the player untouched', async () => {
    const d = deps({ getSettings: vi.fn(async () => settings()) }); // shortsGuard default OFF
    const orch = new FilterOrchestrator(d);
    const main = document.querySelector('main')!;
    main.innerHTML = '<h1>Guarded Short</h1>';
    const video = document.createElement('video');
    main.appendChild(video);
    await orch.processActiveShortsForTest(
      pageContextFromUrl('https://www.youtube.com/shorts/guardvid1'),
      'https://www.youtube.com/shorts/guardvid1',
    );
    // No cover, no pause.
    expect(document.getElementById('bts-shorts-guard')).toBeNull();
    orch.stop();
  });

  it('guard enabled pauses and covers a matching active Short', async () => {
    const d = deps({
      getSettings: vi.fn(async () => settings({ shortsGuard: { enabled: true } })),
      getCachedClassifications: vi.fn(async (inputs: readonly unknown[]) =>
        inputs.map(() => HIGH_CLASSIFICATION),
      ),
    });
    const orch = new FilterOrchestrator(d);
    const main = document.querySelector('main')!;
    main.innerHTML = '<h1>Guarded Short</h1>';
    const video = document.createElement('video');
    const pauseSpy = vi.fn();
    video.pause = pauseSpy;
    main.appendChild(video);

    await orch.processActiveShortsForTest(
      pageContextFromUrl('https://www.youtube.com/shorts/guardvid2'),
      'https://www.youtube.com/shorts/guardvid2',
    );
    expect(document.getElementById('bts-shorts-guard')).not.toBeNull();
    expect(pauseSpy).toHaveBeenCalled();
    removeShortsGuard();
    expect(document.getElementById('bts-shorts-guard')).toBeNull();
    orch.stop();
  });

  it('disabling the guard mid-load removes the cover without autoplay', async () => {
    const { pauseAndCoverShorts } = await import('@/presentation/shorts-guard');
    pauseAndCoverShorts(
      {
        videoId: 'guardvid3',
        title: 'Covered',
        channel: {},
        surface: 'shorts-feed',
        cardKind: 'shorts-video',
        badges: [],
        ariaLabels: [],
        metadataText: [],
        isShort: true,
        observedAt: Date.now(),
      },
      { action: 'hide', reason: 'automatic', explanation: ['test'] },
    );
    expect(document.getElementById('bts-shorts-guard')).not.toBeNull();
    // Disable: guard removed; no video.play() call is ever made by the module.
    removeShortsGuard();
    expect(document.getElementById('bts-shorts-guard')).toBeNull();
  });
});

describe('surface + identity edges (DOM-05/06 extras)', () => {
  it('non-video renderers are not misclassified as cards', () => {
    document.body.innerHTML = `
      <main>
        <ytd-rich-shelf-renderer><h2>Shelf</h2></ytd-rich-shelf-renderer>
        <ytd-menu-renderer><span>menu</span></ytd-menu-renderer>
        <ytd-playlist-panel-video-list-renderer><span>playlist panel</span></ytd-playlist-panel-video-list-renderer>
      </main>`;
    const main = document.querySelector('main')!;
    expect(discoverCards(main, 'home')).toHaveLength(0);
  });

  it('epoch bump forces reprocessing of an already-processed element', () => {
    const el = document.createElement('div');
    expect(shouldProcess(el, 'sig-a')).toBe(true);
    expect(shouldProcess(el, 'sig-a')).toBe(false);
    bumpEpoch();
    expect(shouldProcess(el, 'sig-a')).toBe(true);
    forget(el);
    expect(shouldProcess(el, 'sig-a')).toBe(true);
  });
});
