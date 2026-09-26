import { describe, expect, it, vi, beforeEach } from 'vitest';
import { identityOf } from '@/domain/video';
import { FilterOrchestrator, type OrchestratorDeps } from '@/pipeline/orchestrator';
import { defaultSettings } from '@/domain/settings';
import { defaultRules } from '@/domain/rules';
import { setPresentationCallbacks } from '@/presentation/apply-decision';

/**
 * DOM-07..DOM-11, DOM-23 — hydration/reinsertion/race correctness.
 * Uses real MutationObserver timing via awaits, fake deps, real jsdom.
 */

function settings() {
  return defaultSettings();
}

function deps(): OrchestratorDeps & {
  addReviewRecord: ReturnType<typeof vi.fn>;
  classifyCalls: number;
} {
  return {
    getSettings: vi.fn(async () => settings()),
    getRules: vi.fn(async () => defaultRules()),
    getCachedClassifications: vi.fn(async (inputs: readonly unknown[]) =>
      inputs.map(() => undefined),
    ),
    putCachedClassifications: vi.fn(async () => {}),
    getCorrections: vi.fn(async () => ({ notAi: false, notSlop: false })),
    addReviewRecord: vi.fn(async () => {}),
    applyStats: vi.fn(async () => {}),
    isRemoteProviderEnabled: () => false,
    classifyCalls: 0,
  };
}

function disclosureCardHtml(id: string, title: string): string {
  return `
  <yt-lockup-view-model>
    <a id="video-title-link" href="/watch?v=${id}"><span id="video-title">${title}</span></a>
    <div class="badges"><span class="badge">Altered or synthetic content</span></div>
  </yt-lockup-view-model>`;
}

describe('observation hydration (DOM-07..DOM-09)', () => {
  let container: HTMLElement;
  beforeEach(() => {
    // Presentation callbacks are wired by the entrypoint in production.
    setPresentationCallbacks({
      showOnce: () => {},
      why: () => {},
      allowVideo: () => {},
      allowChannel: () => {},
    });
    document.body.innerHTML = '<main id="contents"></main>';
    container = document.querySelector('main')!;
  });

  it('DOM-07: skeleton card whose title text hydrates later is processed with new metadata', async () => {
    const orch = new FilterOrchestrator(deps());
    orch.start();
    container.innerHTML = disclosureCardHtml('hydrate01', '');
    await new Promise((r) => setTimeout(r, 50));
    // Hydration: title text node changes.
    container.querySelector('#video-title')!.textContent = 'AI generated funny fruits';
    await new Promise((r) => setTimeout(r, 80));
    // The card must have been processed after hydration (state applied).
    const state = container.querySelector('yt-lockup-view-model')!.getAttribute('data-bts-state');
    expect(state === 'hidden' || state === 'warn').toBe(true);
    orch.stop();
  });

  it('DOM-08: href-only replacement on a reused node reprocesses the new video', async () => {
    const orch = new FilterOrchestrator(deps());
    orch.start();
    container.innerHTML = disclosureCardHtml('reused01', 'Some video');
    await new Promise((r) => setTimeout(r, 50));
    const card = container.querySelector('yt-lockup-view-model')!;
    // Recycle the node: same element, new video.
    card.querySelector('a')!.setAttribute('href', '/watch?v=newclip02');
    card.querySelector('#video-title')!.textContent = 'Brand new clip';
    await new Promise((r) => setTimeout(r, 80));
    expect(card.getAttribute('data-bts-video-id')).toBe('newclip02');
    orch.stop();
  });

  it('DOM-09: extension-owned mutations do not trigger infinite reprocessing', async () => {
    const d = deps();
    const orch = new FilterOrchestrator(d);
    orch.start();
    container.innerHTML = disclosureCardHtml('loopv001', 'Rome retold');
    await new Promise((r) => setTimeout(r, 80));
    const afterFirst = d.addReviewRecord.mock.calls.length;
    // Let any observer loops settle.
    await new Promise((r) => setTimeout(r, 200));
    expect(d.addReviewRecord.mock.calls.length).toBe(afterFirst);
    orch.stop();
  });
});

describe('orchestrator identity guard (DOM-10, DOM-13)', () => {
  beforeEach(() => {
    setPresentationCallbacks({
      showOnce: () => {},
      why: () => {},
      allowVideo: () => {},
      allowChannel: () => {},
    });
    document.body.innerHTML = '<main id="contents"></main>';
  });

  it('DOM-13: classification resolving after card recycle does not apply the old result', async () => {
    const d = deps();
    // Classify slowly so the await window is observable.
    let resolveClassify!: (value: typeof slowClassification) => void;
    const slowClassification = {
      aiLikelihood: 0.9,
      slopLikelihood: 0.1,
      categories: {},
      confidence: 'very-high' as const,
      evidence: [],
      classifierVersion: '1',
      rulesVersion: '1',
      evaluatedAt: Date.now(),
    };
    d.getCachedClassifications = vi.fn(
      (inputs: readonly unknown[]) =>
        new Promise<Array<typeof slowClassification | undefined>>((resolve) => {
          resolveClassify = (): void => resolve(inputs.map(() => slowClassification));
        }),
    ) as unknown as OrchestratorDeps['getCachedClassifications'];
    const orch = new FilterOrchestrator(d);
    orch.start();
    const main = document.querySelector('main')!;
    main.innerHTML = disclosureCardHtml('slowvid01', 'First video');
    const cardEl = main.querySelector('yt-lockup-view-model')!;
    const firstPass = orch.processBatch([main]);
    // Wait a macro tick: the settings/rules/classify async chain must have
    // reached getCachedClassification before we resolve it.
    await new Promise((r) => setTimeout(r, 10));
    // Recycle the card while classification is pending.
    cardEl.querySelector('a')!.setAttribute('href', '/watch?v=nextvid02');
    cardEl.querySelector('#video-title')!.textContent = 'Second video';
    resolveClassify(slowClassification);
    await firstPass;
    // The old hide must NOT have applied to the recycled card.
    const state = cardEl.getAttribute('data-bts-state');
    // Either null (not yet processed for the new id) or the new video's id.
    expect(cardEl.getAttribute('data-bts-video-id')).not.toBe('slowvid01');
    expect(state).not.toBe('hidden');
    orch.stop();
  });

  it('DOM-10: fingerprint includes description so late description re-evaluates', () => {
    const base = {
      videoId: 'fingerprint1' as string | undefined,
      title: 'Same title',
      channel: { channelId: 'UCsame1111111111111111' },
      surface: 'home' as const,
      cardKind: 'video' as const,
      badges: [] as string[],
      ariaLabels: [] as string[],
      metadataText: [] as string[],
      isShort: false,
      observedAt: 1,
    };
    const without = identityOf({ ...base });
    const withDesc = identityOf({ ...base, description: 'All footage generated with Sora' });
    expect(without).not.toBe(withDesc);
  });
});

describe('surface routing (DOM-05 partial)', () => {
  it('WL playlist maps to watch-later surface', async () => {
    const { pageContextFromUrl } = await import('@/youtube/routes');
    expect(pageContextFromUrl('https://www.youtube.com/playlist?list=WL').surface).toBe(
      'watch-later',
    );
    expect(pageContextFromUrl('https://www.youtube.com/playlist?list=PLabc').surface).toBe(
      'playlist',
    );
  });
});
