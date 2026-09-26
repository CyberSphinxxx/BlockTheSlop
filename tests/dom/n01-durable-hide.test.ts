import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FilterOrchestrator, type OrchestratorDeps } from '@/pipeline/orchestrator';
import { defaultSettings, type UserSettings } from '@/domain/settings';
import { defaultRules } from '@/domain/rules';
import { parseDiscovered } from '@/youtube/discover';
import { pageContextFromUrl } from '@/youtube/routes';
import {
  setPresentationCallbacks,
  announcePersistenceError,
  restore,
  type PresentationCallbacks,
} from '@/presentation/apply-decision';

/**
 * N01 durable-hide protocol.
 *
 * A hide may only be applied AFTER its recovery record is durably committed.
 * On persistence failure the card stays VISIBLE (fail open) and a visible
 * local error is announced. An `{error}` response from the background is a
 * failure, not a success. History-OFF is an explicit user choice: the hide
 * applies with session-only recovery, never counted as durable history.
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

function setupCard(id: string, title: string): Element {
  document.body.innerHTML = `<main>${cardHtml(id, title)}</main>`;
  return document.querySelector('main')!;
}

describe('N01: hide waits for durable commit', () => {
  beforeEach(() => {
    // This file must wire its own presentation callbacks: applyDecision is a
    // no-op while callbacks are null, and module state is per-worker.
    setPresentationCallbacks({
      showOnce: () => {},
      why: () => {},
      allowVideo: () => {},
      allowChannel: () => {},
    } satisfies PresentationCallbacks);
    document.body.innerHTML = '';
  });

  it('applies hidden state only after recordHiddenDurable resolves', async () => {
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
    const main = setupCard('n01wait01', 'Deferred durable write');
    const card = main.querySelector('yt-lockup-view-model')!;

    const batch = orch.processBatch([main]);
    await tick();
    // Write still pending: the card must NOT be hidden yet.
    expect(card.getAttribute('data-bts-state')).toBeNull();
    resolveWrite!();
    await batch;
    await tick();
    expect(card.getAttribute('data-bts-state')).toBe('hidden');
    expect(d.recordHiddenDurable).toHaveBeenCalledTimes(1);
    orch.stop();
  });

  it('fails open with a visible error when the durable write rejects', async () => {
    const d = deps({
      recordHiddenDurable: vi.fn(async () => {
        throw new Error('QuotaExceededError');
      }),
    });
    const orch = new FilterOrchestrator(d);
    // The content script owns this wiring (announce + restore); mirror it.
    orch.onHidePersistenceFailed = (element) => {
      restore(element);
      announcePersistenceError(element);
    };
    const main = setupCard('n01fail01', 'Quota failure card');
    const card = main.querySelector('yt-lockup-view-model')!;

    await orch.processBatch([main]);
    await tick();

    // FAIL OPEN: no hidden state, no placeholder; a status announcement exists.
    expect(card.getAttribute('data-bts-state')).toBeNull();
    expect(card.querySelector('.bts-placeholder')).toBeNull();
    const announcement = document.querySelector('.bts-persist-error');
    expect(announcement).not.toBeNull();
    expect(announcement?.getAttribute('role')).toBe('status');
    orch.stop();
  });

  it('fails open when the background answers {error} (handler rejection decoded)', async () => {
    // Simulates the background's {error: String(err)} shape through the port.
    const d = deps({
      recordHiddenDurable: vi.fn(async () => {
        throw new Error('message handler failed: history:record');
      }),
    });
    const orch = new FilterOrchestrator(d);
    orch.onHidePersistenceFailed = (element) => {
      restore(element);
      announcePersistenceError(element);
    };
    const main = setupCard('n01err01', 'Error response card');
    const card = main.querySelector('yt-lockup-view-model')!;

    await orch.processBatch([main]);
    await tick();

    expect(card.getAttribute('data-bts-state')).toBeNull();
    expect(document.querySelector('.bts-persist-error')).not.toBeNull();
    orch.stop();
  });

  it('history-OFF hides with session-only recovery and never claims durability', async () => {
    // Explicitly disable history: this is the user choice under test.
    const d = deps({
      getSettings: vi.fn(async () => settings({ history: { enabled: false, retentionDays: 30 } })),
    });
    const orch = new FilterOrchestrator(d);
    const main = setupCard('n01off01', 'History disabled card');
    const card = main.querySelector('yt-lockup-view-model')!;

    // history.enabled=false → hide applies without durable write (user's
    // explicit choice); Show once remains available in the placeholder.
    await orch.processBatch([main]);
    await tick();
    expect(card.getAttribute('data-bts-state')).toBe('hidden');
    expect(d.recordHiddenDurable).not.toHaveBeenCalled();
    expect(document.querySelector('.bts-persist-error')).toBeNull();
    orch.stop();
  });

  it('rapid repeated hides of the same video do not double-write per pass', async () => {
    const d = deps();
    const orch = new FilterOrchestrator(d);
    const main = setupCard('n01dup01', 'Duplicate hide card');
    const card = main.querySelector('yt-lockup-view-model')!;

    await orch.processBatch([main, main, main]);
    await tick();
    expect(card.getAttribute('data-bts-state')).toBe('hidden');
    // Identity layer marks the card processed; one durable write for one card.
    expect(d.recordHiddenDurable).toHaveBeenCalledTimes(1);
    orch.stop();
  });

  // N01/N03 blocker-3: Collapse + history-OFF removes the placeholder and its
  // Reveal button. There is no durable history to restore from, so the card
  // must keep a session-only recovery bar (accessible Reveal once) on page.
  it('history-OFF + collapse keeps an accessible session recovery route', async () => {
    const d = deps({
      getSettings: vi.fn(async () =>
        settings({
          history: { enabled: false, retentionDays: 30 },
          displayMode: 'collapse',
        }),
      ),
    });
    const orch = new FilterOrchestrator(d);
    const main = setupCard('n01col01', 'Collapse without history card');
    const card = main.querySelector('yt-lockup-view-model')!;

    // Callbacks must be wired BEFORE the hide renders (production does the
    // same); the placeholder captures them at creation time.
    const parsed = parseDiscovered(
      { element: card, kind: 'card' },
      pageContextFromUrl('https://www.youtube.com/').surface,
      Date.now(),
    );
    const { identityOf } = await import('@/domain/video');
    setPresentationCallbacks({
      showOnce: (el) => orch.showOnce(el, identityOf(parsed)),
      why: () => {},
      allowVideo: () => {},
      allowChannel: () => {},
    } satisfies PresentationCallbacks);

    await orch.processBatch([main]);
    await tick();

    expect(card.getAttribute('data-bts-state')).toBe('hidden');
    // V5-02: Gap-free collapse completely removes the slot without an inline bar.
    expect(card.getAttribute('data-bts-collapse')).toBe('');
    expect(card.querySelector('.bts-collapse-recovery')).toBeNull();
    expect(card.querySelector('.bts-placeholder')).toBeNull();
    // Recovery via showOnce restores the card for this page view.
    orch.showOnce(card, identityOf(parsed));
    await tick();
    expect(card.getAttribute('data-bts-state')).toBeNull();
    orch.stop();
  });

  it('history-ON + collapse removes the slot entirely (durable recovery route)', async () => {
    const d = deps({
      getSettings: vi.fn(async () =>
        settings({
          history: { enabled: true, retentionDays: 30 },
          displayMode: 'collapse',
        }),
      ),
    });
    const orch = new FilterOrchestrator(d);
    const main = setupCard('n01col02', 'Collapse with history card');
    const card = main.querySelector('yt-lockup-view-model')!;

    await orch.processBatch([main]);
    await tick();
    expect(card.getAttribute('data-bts-state')).toBe('hidden');
    expect(card.getAttribute('data-bts-collapse')).toBe('');
    expect(d.recordHiddenDurable).toHaveBeenCalledTimes(1);
    orch.stop();
  });
});
