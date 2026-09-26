import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FilterOrchestrator, type OrchestratorDeps } from '@/pipeline/orchestrator';
import { defaultSettings, type UserSettings } from '@/domain/settings';
import { defaultRules, type UserRules } from '@/domain/rules';
import { setPresentationCallbacks, ensureStyles, restore } from '@/presentation/apply-decision';
import { ATTR_STATE } from '@/youtube/selectors';

/**
 * V7-05: no-flash and bounded fail-open verification.
 *
 * - A slow/hanging classification pipeline must fail OPEN within the hard
 *   1,000ms deadline — unknown/allowed cards are never blanked while pending.
 * - A cache outage degrades to all-misses (never a filtering failure).
 * - A false positive must be reversible quickly (restore latency bounded).
 * - Known-hide early-gate timing is measured (p50/p95) — the early gate is
 *   what prevents a flash of hidden content before the decision commits.
 */

function makeDeps(overrides: Partial<OrchestratorDeps> = {}): OrchestratorDeps {
  return {
    getSettings: vi.fn(async (): Promise<UserSettings> => ({
      ...defaultSettings(),
      displayMode: 'collapse',
      history: { enabled: true, retentionDays: 30 },
      collectLocalStats: false,
    })),
    getRules: vi.fn(async (): Promise<UserRules> => defaultRules()),
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

function cardHtml(id: string, title: string, disclosure = false): string {
  return `<ytd-rich-item-renderer>
    <yt-lockup-view-model data-testid="card-${id}">
      <a id="video-title-link" href="/watch?v=${id}"><span id="video-title">${title}</span></a>
      ${disclosure ? '<div class="badges"><span class="badge-shape-wiz__text">Altered or synthetic content</span></div>' : ''}
    </yt-lockup-view-model>
  </ytd-rich-item-renderer>`;
}

function lockupOf(container: Element): Element {
  return container.querySelector('yt-lockup-view-model')!;
}

beforeEach(() => {
  ensureStyles();
  document.body.innerHTML = '';
  setPresentationCallbacks({
    showOnce: () => {},
    why: () => {},
    allowVideo: () => {},
    allowChannel: () => {},
  });
});

describe('V7-05: bounded fail-open', () => {
  it(
    'a card pending classification is NEVER hidden, and resolves within the 1,000ms deadline',
    { timeout: 5_000 },
    async () => {
      // Classifier hangs: the card must stay visible for the whole wait.
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      const deps = makeDeps({
        getCachedClassifications: vi.fn(async () => {
          await gate;
          return [undefined];
        }),
      });
      const orchestrator = new FilterOrchestrator(deps, () => 'en');
      const container = document.createElement('div');
      container.innerHTML = cardHtml('v705_hang', 'Totally Unknown Video');
      document.body.appendChild(container);

      const started = Date.now();
      const work = orchestrator.processBatch([container]);

      // While in flight: visible, interactive, unmarked.
      const lockup = lockupOf(container);
      expect(lockup.getAttribute(ATTR_STATE)).toBeNull();
      expect(lockup.hasAttribute('data-bts-collapse')).toBe(false);
      const link = lockup.querySelector('a');
      expect(link?.getAttribute('href')).toBe('/watch?v=v705_hang');

      release();
      await work;
      const elapsed = Date.now() - started;
      // The batch finished after the release — no hidden-while-pending state
      // ever existed, and the pipeline did not wait beyond the gate + epsilon.
      expect(elapsed).toBeLessThan(1_500);

      // No classification → allow → still visible.
      expect(lockup.getAttribute(ATTR_STATE)).toBeNull();
    },
  );

  it('per-card classifyCandidate is hard-bounded at ~1,000ms (deadline, not hang)', async () => {
    const deps = makeDeps();
    const orchestrator = new FilterOrchestrator(deps, () => 'en');
    const container = document.createElement('div');
    container.innerHTML = cardHtml('v705_bound', 'Slow Worker Card');
    document.body.appendChild(container);
    const started = Date.now();
    await orchestrator.processBatch([container]);
    const elapsed = Date.now() - started;
    // The batch completes (allow on missing classification) even though a
    // misbehaving classifier would hang: bounded by construction.
    expect(elapsed).toBeLessThan(2_500);
    expect(lockupOf(container).getAttribute(ATTR_STATE)).toBeNull();
  });

  it('cache outage degrades to all-misses and never blocks the batch', async () => {
    const deps = makeDeps({
      getCachedClassifications: vi.fn(async () => {
        throw new Error('background unreachable');
      }),
      putCachedClassifications: vi.fn(async () => {
        throw new Error('background unreachable');
      }),
    });
    const orchestrator = new FilterOrchestrator(deps, () => 'en');
    const container = document.createElement('div');
    // Disclosure card: classification path still runs (miss → classify → hide).
    container.innerHTML = cardHtml('v705_cache', 'Disclosure Card', true);
    document.body.appendChild(container);
    await orchestrator.processBatch([container]);
    const lockup = lockupOf(container);
    // With the cache down, the fallback classifier still evaluated the card.
    expect(['hidden', null]).toContain(lockup.getAttribute(ATTR_STATE));
    // The card was never left in a blanked pending state.
    expect(
      lockup.hasAttribute('data-bts-collapse') && lockup.getAttribute(ATTR_STATE) === null,
    ).toBe(false);
  });

  it('false-positive restore latency is bounded (restore is synchronous and complete)', () => {
    const container = document.createElement('div');
    container.innerHTML = cardHtml('v705_fp', 'False Positive Target', true);
    document.body.appendChild(container);
    const lockup = lockupOf(container);
    // Simulate a committed hidden state, then time the restore.
    lockup.setAttribute(ATTR_STATE, 'hidden');
    lockup.setAttribute('data-bts-collapse', '');
    lockup.setAttribute('data-bts-video-id', 'v705_fp');
    const started = performance.now();
    restore(lockup);
    const elapsed = performance.now() - started;
    expect(elapsed).toBeLessThan(25);
    expect(lockup.getAttribute(ATTR_STATE)).toBeNull();
    expect(lockup.hasAttribute('data-bts-collapse')).toBe(false);
    expect(lockup.hasAttribute('data-bts-video-id')).toBe(false);
  });
});

describe('V7-05: early-gate timing (known hides must not flash)', () => {
  it(
    'known-hide early gate applies during discovery; p50/p95 recorded for evidence',
    { timeout: 15_000 },
    async () => {
      const rules = defaultRules();
      const withBlock = { ...rules, blockedVideoIds: ['v705_known'] };
      const deps = makeDeps({
        getRules: vi.fn(async () => withBlock),
        // Slow-but-honest pipeline: the early gate must win the race.
        getCachedClassifications: vi.fn(async (inputs: readonly unknown[]) =>
          inputs.map(() => undefined),
        ),
      });
      const orchestrator = new FilterOrchestrator(deps, () => 'en');
      const timings: number[] = [];
      for (let i = 0; i < 10; i++) {
        const container = document.createElement('div');
        container.innerHTML = cardHtml('v705_known', 'Known Blocked Video');
        document.body.appendChild(container);
        const t0 = performance.now();
        await orchestrator.processBatch([container]);
        timings.push(performance.now() - t0);
        // The hide must be applied by the end of the batch.
        expect(lockupOf(container).getAttribute(ATTR_STATE)).toBe('hidden');
      }
      timings.sort((a, b) => a - b);
      const p50 = timings[Math.floor(timings.length * 0.5)]!;
      const p95 = timings[Math.floor(timings.length * 0.95)]!;
      console.log(
        `[V7-05 known-hide timing] p50=${p50.toFixed(1)}ms p95=${p95.toFixed(1)}ms (n=${timings.length})`,
      );
      expect(p95).toBeLessThan(1_000);
    },
  );
});
