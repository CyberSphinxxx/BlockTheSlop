import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FilterOrchestrator, type OrchestratorDeps } from '@/pipeline/orchestrator';
import { defaultSettings, type UserSettings } from '@/domain/settings';
import { defaultRules } from '@/domain/rules';
import { parseDiscovered } from '@/youtube/discover';
import { identityOf } from '@/domain/video';
import { pageContextFromUrl } from '@/youtube/routes';
import {
  restore,
  setPresentationCallbacks,
  stampIsCurrent,
  type PresentationCallbacks,
} from '@/presentation/apply-decision';

/**
 * N02 recycled-card / cancellation safety.
 *
 * YouTube reuses card elements for different videos. Invariants:
 * - a decision computed for video A is never applied to a card that now holds
 *   video B (re-parse before mutation);
 * - a Show-once override survives only while the card still holds the SAME
 *   content (element + signature set, not element alone);
 * - Allow video/channel verify the card's fingerprint at click time.
 */

function settings(overrides: Partial<UserSettings> = {}): UserSettings {
  return { ...defaultSettings(), displayMode: 'placeholder', ...overrides };
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

function cardHtml(id: string, title: string): string {
  return `<yt-lockup-view-model data-testid="card-${id}">
    <a id="video-title-link" href="/watch?v=${id}"><span id="video-title">${title}</span></a>
    <div class="badges"><span class="badge-shape-wiz__text">Altered or synthetic content</span></div>
  </yt-lockup-view-model>`;
}

async function tick(ms = 30): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

function setupCard(id: string, title: string): { main: Element; card: Element } {
  document.body.innerHTML = `<main>${cardHtml(id, title)}</main>`;
  const main = document.querySelector('main')!;
  return { main, card: main.querySelector('yt-lockup-view-model')! };
}

describe('N02: recycled card safety', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    setPresentationCallbacks({
      showOnce: () => {},
      why: () => {},
      allowVideo: () => {},
      allowChannel: () => {},
    } satisfies PresentationCallbacks);
  });

  it('a mid-flight identity change drops the stale decision (no cross-video hide)', async () => {
    // Classification resolves AFTER the card is recycled to another video.
    let resolveClassify: (() => void) | undefined;
    const d = deps({
      getCachedClassifications: vi.fn(
        (inputs: readonly unknown[]) =>
          new Promise<Array<undefined>>((resolve) => {
            resolveClassify = (): void => resolve(inputs.map(() => undefined));
          }),
      ),
    });
    const orch = new FilterOrchestrator(d);
    const { main, card } = setupCard('n02stale01', 'Original video');

    const batch = orch.processBatch([main]);
    await tick();
    // Recycle the card to a DIFFERENT video while classification is pending.
    card.querySelector('a')!.setAttribute('href', '/watch?v=n02other2');
    card.querySelector('#video-title')!.textContent = 'Recycled video';
    resolveClassify!();
    await batch;
    await tick();

    // The stale decision must NOT have been applied to the recycled card.
    expect(card.getAttribute('data-bts-state')).toBeNull();
    expect(card.querySelector('.bts-placeholder')).toBeNull();
    orch.stop();
  });

  it('show-once override is identity-scoped: a recycled card is filterable again', async () => {
    const d = deps();
    const orch = new FilterOrchestrator(d);
    const { main, card } = setupCard('n02show01', 'Show-once target');

    await orch.processBatch([main]);
    await tick();
    expect(card.getAttribute('data-bts-state')).toBe('hidden');

    // Click Show once — wiring passes the card's CURRENT content signature.
    const parsed = parseDiscovered(
      { element: card, kind: 'card' },
      pageContextFromUrl('https://www.youtube.com/').surface,
      Date.now(),
    );
    orch.showOnce(card, identityOf(parsed));
    await tick();
    expect(card.getAttribute('data-bts-state')).toBeNull(); // revealed

    // YouTube recycles the element for a DIFFERENT video: signature differs,
    // so the override must NOT suppress filtering for the new content.
    card.querySelector('a')!.setAttribute('href', '/watch?v=n02next02');
    card.querySelector('#video-title')!.textContent = 'Recycled after show-once';
    await orch.processBatch([main]);
    await tick();
    expect(card.getAttribute('data-bts-state')).toBe('hidden');
    orch.stop();
  });

  it('allow actions verify the fingerprint at click time (stale overlay is inert)', async () => {
    const { card } = setupCard('n02click01', 'Click-target video');
    const candidate = parseDiscovered(
      { element: card, kind: 'card' },
      pageContextFromUrl('https://www.youtube.com/').surface,
      Date.now(),
    );
    // Simulate an applied overlay: stamp the element with the candidate.
    const { applyDecision } = await import('@/presentation/apply-decision');
    applyDecision(
      card,
      { action: 'warn', reason: 'automatic', explanation: ['x'] },
      candidate,
      settings(),
    );
    expect(stampIsCurrent(card, candidate)).toBe(true);

    // Recycle the card to a different video — the stamp no longer describes it.
    card.querySelector('a')!.setAttribute('href', '/watch?v=n02fresh2');
    card.querySelector('#video-title')!.textContent = 'Recycled under overlay';
    expect(stampIsCurrent(card, candidate)).toBe(false);

    // After restore the stamp is gone entirely.
    restore(card);
    expect(stampIsCurrent(card, candidate)).toBe(false);
  });

  it('unchanged cards still re-apply cleanly (idempotence preserved)', async () => {
    const d = deps();
    const orch = new FilterOrchestrator(d);
    const { main, card } = setupCard('n02stable1', 'Stable card');

    await orch.processBatch([main]);
    await tick();
    expect(card.getAttribute('data-bts-state')).toBe('hidden');
    // Re-run: shouldProcess keeps it untouched; state remains correct.
    await orch.processBatch([main]);
    await tick();
    expect(card.querySelectorAll('.bts-placeholder')).toHaveLength(1);
    orch.stop();
  });
});
