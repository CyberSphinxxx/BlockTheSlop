import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FilterOrchestrator, type OrchestratorDeps } from '@/pipeline/orchestrator';
import { defaultSettings, type UserSettings } from '@/domain/settings';
import { defaultRules } from '@/domain/rules';
import {
  setPresentationCallbacks,
  type PresentationCallbacks,
  ensureStyles,
} from '@/presentation/apply-decision';

function makeDeps(overrides: Partial<OrchestratorDeps> = {}): OrchestratorDeps {
  return {
    getSettings: vi.fn(async (): Promise<UserSettings> => ({
      ...defaultSettings(),
      displayMode: 'collapse' as const,
      history: { enabled: true, retentionDays: 30 },
      collectLocalStats: true,
    })),
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

function cardHtml(id: string, title: string, disclosure = true): string {
  return `<yt-lockup-view-model data-testid="card-${id}">
    <a id="video-title-link" href="/watch?v=${id}"><span id="video-title">${title}</span></a>
    ${disclosure ? '<div class="badges"><span class="badge-shape-wiz__text">Altered or synthetic content</span></div>' : ''}
  </yt-lockup-view-model>`;
}

describe('V6-11: orchestrator emits day-bucketed stat observations (DOM)', () => {
  beforeEach(() => {
    ensureStyles();
    document.body.innerHTML = '';
    setPresentationCallbacks({
      showOnce: () => {},
      why: () => {},
      allowVideo: () => {},
      allowChannel: () => {},
    } satisfies PresentationCallbacks);
  });

  it('emits one hide observation per distinct video, fire-and-forget', async () => {
    const recordDailyStat = vi.fn(async () => {});
    const d = makeDeps({ recordDailyStat });
    const orchestrator = new FilterOrchestrator(d);
    document.body.innerHTML = `<main>${cardHtml('a1', 'Altered content video')}${cardHtml(
      'a1',
      'Altered content video',
    )}</main>`;
    orchestrator.start();
    await new Promise((r) => setTimeout(r, 60));
    await Promise.all(orchestrator.inFlight);
    // V5 dedup already collapsed the two cards; the daily observation must
    // carry exactly ONE hide for the distinct video.
    const hides = recordDailyStat.mock.calls.filter(
      (c: unknown[]) => (c[0] as { outcome: string })?.outcome === 'hide',
    ) as unknown[][];
    expect(hides).toHaveLength(1);
    const first = hides[0]![0] as { videoId: string; observedAt: number };
    expect(first.videoId).toBe('a1');
    expect(typeof first.observedAt).toBe('number');
    orchestrator.stop();
  });

  it('a rejecting daily-stats sink never breaks filtering', async () => {
    const recordDailyStat = vi.fn(async () => {
      throw new Error('background unavailable');
    });
    const d = makeDeps({ recordDailyStat });
    const orchestrator = new FilterOrchestrator(d);
    document.body.innerHTML = `<main>${cardHtml('b1', 'Altered content video')}</main>`;
    orchestrator.start();
    await new Promise((r) => setTimeout(r, 60));
    await Promise.all(orchestrator.inFlight);
    // The hide WAS applied (card collapsed) despite the stats failure.
    const card = document.querySelector('[data-testid="card-b1"]');
    expect(card?.getAttribute('data-bts-collapse')).not.toBeNull();
    orchestrator.stop();
  });

  it('no observations when collection is off', async () => {
    const recordDailyStat = vi.fn(async () => {});
    const d = makeDeps({
      recordDailyStat,
      getSettings: vi.fn(async (): Promise<UserSettings> => ({
        ...defaultSettings(),
        collectLocalStats: false,
      })),
    });
    const orchestrator = new FilterOrchestrator(d);
    document.body.innerHTML = `<main>${cardHtml('c1', 'Altered content video')}</main>`;
    orchestrator.start();
    await new Promise((r) => setTimeout(r, 60));
    await Promise.all(orchestrator.inFlight);
    expect(recordDailyStat).not.toHaveBeenCalled();
    orchestrator.stop();
  });
});
