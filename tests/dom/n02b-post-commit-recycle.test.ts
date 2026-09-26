import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FilterOrchestrator, type OrchestratorDeps } from '@/pipeline/orchestrator';
import { defaultSettings, type UserSettings } from '@/domain/settings';
import { defaultRules } from '@/domain/rules';
import {
  restore,
  setPresentationCallbacks,
  type PresentationCallbacks,
} from '@/presentation/apply-decision';

/**
 * N02 (blocker 2): the FINAL revalidation must happen AFTER the durable
 * history await, immediately before presentation. A deferred history write
 * resolving after YouTube recycled the card (A→B), after filtering was
 * disabled, or after navigation (generation bump) must never apply A's hide:
 * - to the element that now holds video B;
 * - to a page whose filtering is now off;
 * - after a generation invalidation (SPA navigation / rescan / stop).
 *
 * The recorded history event must stay consistent with the resulting action:
 * a hide that was NOT applied must not count as an applied hide (stats).
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

describe('N02b: revalidation after the durable-write await', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    setPresentationCallbacks({
      showOnce: () => {},
      why: () => {},
      allowVideo: () => {},
      allowChannel: () => {},
    } satisfies PresentationCallbacks);
  });

  it('a deferred durable write resolving after A→B recycling never hides B', async () => {
    let resolveWrite: (() => void) | undefined;
    const d = deps({
      recordHiddenDurable: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            resolveWrite = resolve as () => void;
          }),
      ),
    });
    const orch = new FilterOrchestrator(d);
    const { main, card } = setupCard('n02bA', 'Video A awaiting commit');

    const batch = orch.processBatch([main]);
    await tick();
    // The durable write is pending; A is still visible.
    expect(card.getAttribute('data-bts-state')).toBeNull();

    // YouTube recycles the element to video B while the write is in flight.
    card.querySelector('a')!.setAttribute('href', '/watch?v=n02bB2');
    card.querySelector('#video-title')!.textContent = 'Video B recycled';

    resolveWrite!();
    await batch;
    await tick();

    // A's hide must NOT land on B.
    expect(card.getAttribute('data-bts-state')).toBeNull();
    expect(card.querySelector('.bts-placeholder')).toBeNull();
    // And A must not be recorded as an applied (stats) hide.
    expect(d.applyStats).not.toHaveBeenCalledWith(expect.objectContaining({ hidden: 1 }));
    orch.stop();
  });

  it('a deferred durable write resolving after filtering was disabled never hides', async () => {
    let resolveWrite: (() => void) | undefined;
    const current = { value: settings() };
    const d = deps({
      getSettings: vi.fn(async () => current.value),
      recordHiddenDurable: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            resolveWrite = resolve as () => void;
          }),
      ),
    });
    const orch = new FilterOrchestrator(d);
    const { main, card } = setupCard('n02boff', 'Disable during write');

    const batch = orch.processBatch([main]);
    await tick();
    expect(card.getAttribute('data-bts-state')).toBeNull();

    // The user disables filtering while the write is pending.
    current.value = settings({ enabled: false });
    resolveWrite!();
    await batch;
    await tick();

    expect(card.getAttribute('data-bts-state')).toBeNull();
    expect(card.querySelector('.bts-placeholder')).toBeNull();
    orch.stop();
  });

  it('a deferred durable write resolving after navigation (generation bump) never hides', async () => {
    let resolveWrite: (() => void) | undefined;
    const d = deps({
      recordHiddenDurable: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            resolveWrite = resolve as () => void;
          }),
      ),
    });
    const orch = new FilterOrchestrator(d);
    const { main, card } = setupCard('n02bnav', 'Navigate during write');

    const batch = orch.processBatch([main]);
    await tick();

    // SPA navigation invalidates the generation.
    void (orch as unknown as { onNavigation: (url: string) => void }).onNavigation(
      'https://www.youtube.com/results?search_query=x',
    );
    resolveWrite!();
    await batch;
    await tick();

    expect(card.getAttribute('data-bts-state')).toBeNull();
    expect(card.querySelector('.bts-placeholder')).toBeNull();
    orch.stop();
  });

  it('an intact card still hides after a deferred commit (no false regression)', async () => {
    let resolveWrite: (() => void) | undefined;
    const d = deps({
      recordHiddenDurable: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            resolveWrite = resolve as () => void;
          }),
      ),
    });
    const orch = new FilterOrchestrator(d);
    const { main, card } = setupCard('n02bok', 'Unchanged card commits');

    const batch = orch.processBatch([main]);
    await tick();
    resolveWrite!();
    await batch;
    await tick();

    expect(card.getAttribute('data-bts-state')).toBe('hidden');
    expect(d.recordHiddenDurable).toHaveBeenCalledTimes(1);
    orch.stop();
  });

  it('restore() is available for cleanup wiring (presentation surface unchanged)', () => {
    const { card } = setupCard('n02bclr', 'Restore surface');
    card.setAttribute('data-bts-state', 'hidden');
    restore(card);
    expect(card.getAttribute('data-bts-state')).toBeNull();
  });
});
