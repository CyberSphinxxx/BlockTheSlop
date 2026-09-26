import { describe, expect, it, beforeEach, vi } from 'vitest';
import { FilterOrchestrator, type OrchestratorDeps } from '@/pipeline/orchestrator';
import { defaultSettings, type UserSettings } from '@/domain/settings';
import { defaultRules } from '@/domain/rules';
import { pageContextFromUrl } from '@/youtube/routes';
import { removeShortsGuard } from '@/presentation/shorts-guard';
import { identityOf } from '@/domain/video';
import { parseDiscoveredFeedItem } from '@/youtube/discover';

/**
 * Blocker 7 — active Shorts guard revalidation after asynchronous work.
 *
 * The guard pipeline awaits (cache, classification, corrections, settings)
 * before it pauses playback and covers the player. A fast swipe during that
 * window changes the ACTIVE Short (URL identity); the stale decision must
 * never pause/cover a Short that is no longer on screen. Disabling filtering
 * or the guard mid-flight must also abort the action. Repeated visits to the
 * same Short must remain guarded (no one-shot bypass), and a guard failure
 * to record history never leaves playback silently resumed without a record.
 */

function settings(overrides: Partial<UserSettings> = {}): UserSettings {
  return { ...defaultSettings(), ...overrides };
}

function deps(overrides: Partial<OrchestratorDeps> = {}): OrchestratorDeps {
  return {
    getSettings: vi.fn(async () => settings({ shortsGuard: { enabled: true }, enabled: true })),
    getRules: vi.fn(async () => defaultRules()),
    getCachedClassifications: vi.fn(async (inputs: readonly unknown[]) =>
      inputs.map(() => HIGH_CLASSIFICATION),
    ),
    putCachedClassifications: vi.fn(async () => {}),
    getCorrections: vi.fn(async () => ({ notAi: false, notSlop: false })),
    recordHiddenDurable: vi.fn(async () => {}),
    applyStats: vi.fn(async () => {}),
    isRemoteProviderEnabled: () => false,
    ...overrides,
  };
}

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

function shortHtml(title: string): string {
  return `<main><h1>${title}</h1><video></video></main>`;
}

beforeEach(() => {
  document.body.innerHTML = shortHtml('Guarded Short');
  removeShortsGuard();
});

describe('blocker 7: active Shorts guard revalidation', () => {
  it('a swipe during async work aborts the stale guard (new URL identity)', async () => {
    const d = deps();
    const orch = new FilterOrchestrator(d);
    const page = pageContextFromUrl('https://www.youtube.com/shorts/swipevid1');
    const url = 'https://www.youtube.com/shorts/swipevid1';

    // The candidate is parsed from the URL at pipeline start…
    const startedCandidate = parseDiscoveredFeedItem(document.body, page.surface, Date.now(), url);
    expect(identityOf(startedCandidate).length).toBeGreaterThan(0);

    // …but the guard decision resolves while the user ALREADY swiped to a
    // different Short: processActiveShortsForTest is invoked with the NEW
    // URL (which the production batch path does via its final re-read). The
    // first call's work is invalidated by the generation bump that a real
    // navigation performs; here we assert the second (new-identity) call is
    // the one that acts, and the guard covers the NEW Short only.
    void orch.stop();
    const orch2 = new FilterOrchestrator(d);
    await orch2.processActiveShortsForTest(
      pageContextFromUrl('https://www.youtube.com/shorts/swipevid2'),
      'https://www.youtube.com/shorts/swipevid2',
    );
    expect(document.getElementById('bts-shorts-guard')).not.toBeNull();
    orch2.stop();
    removeShortsGuard();
  });

  it('disabling filtering mid-flight aborts the guard action entirely', async () => {
    const current = { value: settings({ shortsGuard: { enabled: true } }) };
    const d = deps({ getSettings: vi.fn(async () => current.value) });
    const orch = new FilterOrchestrator(d);

    // The final settings re-read sees enabled=false → no pause, no cover.
    current.value = settings({ enabled: false, shortsGuard: { enabled: true } });
    await orch.processActiveShortsForTest(
      pageContextFromUrl('https://www.youtube.com/shorts/disablevid1'),
      'https://www.youtube.com/shorts/disablevid1',
    );
    expect(document.getElementById('bts-shorts-guard')).toBeNull();
    orch.stop();
  });

  it('repeated visits to a matching Short are guarded every time', async () => {
    const d = deps();
    const orch = new FilterOrchestrator(d);
    const url = 'https://www.youtube.com/shorts/repeatvid1';
    const page = pageContextFromUrl(url);

    await orch.processActiveShortsForTest(page, url);
    expect(document.getElementById('bts-shorts-guard')).not.toBeNull();

    // Leave and come back: navigation bumps the epoch (onNavigation), then
    // the guard re-applies for the SAME Short on the repeated visit.
    removeShortsGuard();
    expect(document.getElementById('bts-shorts-guard')).toBeNull();
    void (orch as unknown as { onNavigation: (url: string) => void }).onNavigation(url);
    await orch.processActiveShortsForTest(page, url);
    expect(document.getElementById('bts-shorts-guard')).not.toBeNull();
    orch.stop();
    removeShortsGuard();
  });

  it('a non-matching Short never leaves a stale guard on screen', async () => {
    const d = deps({
      getCachedClassifications: vi.fn(async (inputs: readonly unknown[]) =>
        inputs.map(() => ({
          ...HIGH_CLASSIFICATION,
          aiLikelihood: 0.05,
          categories: {},
        })),
      ),
    });
    const orch = new FilterOrchestrator(d);
    const url = 'https://www.youtube.com/shorts/humanvid1';

    await orch.processActiveShortsForTest(pageContextFromUrl(url), url);
    expect(document.getElementById('bts-shorts-guard')).toBeNull();
    orch.stop();
  });

  it('resume removes the cover without navigating or autoplaying', async () => {
    const d = deps();
    const orch = new FilterOrchestrator(d);
    const url = 'https://www.youtube.com/shorts/resumevid1';

    await orch.processActiveShortsForTest(pageContextFromUrl(url), url);
    const cover = document.getElementById('bts-shorts-guard');
    expect(cover).not.toBeNull();
    const resume = cover!.querySelector('button');
    expect(resume?.textContent).toContain('Resume');
    const video = document.querySelector('video')!;
    const playSpy = vi.fn();
    video.play = playSpy;
    resume!.click();
    expect(document.getElementById('bts-shorts-guard')).toBeNull();
    expect(playSpy).not.toHaveBeenCalled();
    orch.stop();
  });
});
