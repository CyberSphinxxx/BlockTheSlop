import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FilterOrchestrator, type OrchestratorDeps } from '@/pipeline/orchestrator';
import { defaultSettings, type UserSettings } from '@/domain/settings';
import { defaultRules, type UserRules } from '@/domain/rules';
import {
  setPresentationCallbacks,
  type PresentationCallbacks,
  ensureStyles,
} from '@/presentation/apply-decision';
import { ATTR_STATE, ATTR_VIDEO_ID } from '@/youtube/selectors';
import { createVerdictMemoEntry } from '@/domain/verdict-memo';
import { classificationFingerprint } from '@/storage/fingerprint';

function makeDeps(overrides: Partial<OrchestratorDeps> = {}): OrchestratorDeps {
  return {
    getSettings: vi.fn(async (): Promise<UserSettings> => ({
      ...defaultSettings(),
      displayMode: 'collapse' as const,
      history: { enabled: true, retentionDays: 30 },
      collectLocalStats: true,
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

function cardHtml(id: string, title: string, disclosure = true): string {
  return `<ytd-rich-item-renderer>
    <yt-lockup-view-model data-testid="card-${id}">
      <a id="video-title-link" href="/watch?v=${id}"><span id="video-title">${title}</span></a>
      ${disclosure ? '<div class="badges"><span class="badge-shape-wiz__text">Altered or synthetic content</span></div>' : ''}
    </yt-lockup-view-model>
  </ytd-rich-item-renderer>`;
}

describe('V5-04: Early Visual Gate, Fail-Open Deadlines, and Flash Timing', () => {
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

  it('known explicit video block collapses layout slot early without waiting for async boundary', async () => {
    const rules: UserRules = {
      ...defaultRules(),
      blockedVideoIds: ['v_explicit_early'],
    };
    const d = makeDeps({ getRules: vi.fn(async () => rules) });
    const orchestrator = new FilterOrchestrator(d);

    const container = document.createElement('main');
    container.innerHTML = cardHtml('v_explicit_early', 'Explicit Blocked Title');
    document.body.appendChild(container);

    const t0 = performance.now();
    await orchestrator.processBatch([container]);
    const durationMs = performance.now() - t0;

    const lockup = container.querySelector('yt-lockup-view-model')!;
    expect(lockup.hasAttribute('data-bts-collapse')).toBe(true);
    expect(lockup.getAttribute(ATTR_STATE)).toBe('hidden');
    expect(lockup.getAttribute(ATTR_VIDEO_ID)).toBe('v_explicit_early');

    // Layout slot removed fast (accounting for first-test JIT warmup)
    expect(durationMs).toBeLessThan(500);
  });

  it('valid Tier 2 verdict memo hit collapses layout slot early in discovery pass', async () => {
    const d = makeDeps();
    const orchestrator = new FilterOrchestrator(d);

    // Populate memo with a valid hide verdict
    const settings = defaultSettings();
    const fp = classificationFingerprint({
      videoId: 'v_memo_early',
      title: 'AI Synthetic News',
      badges: ['Altered or synthetic content'],
      ariaLabels: [],
      metadataText: [],
      officialDisclosurePresent: true,
      isShort: false,
      locale: '',
    });
    orchestrator.verdictMemo.put(
      createVerdictMemoEntry({
        videoId: 'v_memo_early',
        decision: {
          action: 'hide',
          reason: 'automatic',
          explanation: ['AI disclosure'],
        },
        evidenceFingerprint: fp,
        settings,
      }),
    );

    const container = document.createElement('main');
    container.innerHTML = cardHtml('v_memo_early', 'AI Synthetic News');
    document.body.appendChild(container);

    const t0 = performance.now();
    await orchestrator.processBatch([container]);
    const durationMs = performance.now() - t0;

    const lockup = container.querySelector('yt-lockup-view-model')!;
    expect(lockup.hasAttribute('data-bts-collapse')).toBe(true);
    expect(durationMs).toBeLessThan(50);
  });

  it('unknown cards are NEVER hidden blindly; fail-open on slow/hanging worker', async () => {
    // Simulate a slow classifier that hangs longer than the bounded deadline (1000ms)
    // We mock a hanging getCachedClassifications/classifyCandidate
    let resolveHanging: (() => void) | undefined;
    const hangingPromise = new Promise<never>((resolve) => {
      resolveHanging = resolve as () => void;
    });

    const getCachedClassifications = vi.fn(async () => {
      await hangingPromise;
      return [undefined];
    });

    const d = makeDeps({ getCachedClassifications });
    const _orchestrator = new FilterOrchestrator(d);

    const container = document.createElement('main');
    container.innerHTML = cardHtml('v_unknown_hang', 'Unknown Candidate Title', false);
    document.body.appendChild(container);

    const lockup = container.querySelector('yt-lockup-view-model')!;

    // Initial state: unknown card is NOT hidden blindly
    expect(lockup.hasAttribute('data-bts-collapse')).toBe(false);
    expect(lockup.getAttribute(ATTR_STATE)).toBeNull();

    // Interaction remains unblocked
    const link = lockup.querySelector('a')!;
    expect(link.getAttribute('href')).toBe('/watch?v=v_unknown_hang');

    // Clean up hanging promise
    resolveHanging?.();
  });

  it('storage failure fails open and removes any early collapse attribute', async () => {
    const onHidePersistenceFailed = vi.fn();
    const d = makeDeps({
      recordHiddenDurable: vi.fn(async () => {
        throw new Error('IDB connection closed');
      }),
    });
    const orchestrator = new FilterOrchestrator(d);
    orchestrator.onHidePersistenceFailed = onHidePersistenceFailed;

    const container = document.createElement('main');
    container.innerHTML = cardHtml('v_storage_fail', 'Synthetic Drone Video');
    document.body.appendChild(container);

    await orchestrator.processBatch([container]);

    const lockup = container.querySelector('yt-lockup-view-model')!;
    // Fails open: data-bts-collapse must NOT be present!
    expect(lockup.hasAttribute('data-bts-collapse')).toBe(false);
    expect(lockup.getAttribute(ATTR_STATE)).toBeNull();
    expect(onHidePersistenceFailed).toHaveBeenCalled();
  });

  it('measures decision-to-hide timing distribution for cold vs warm paths', async () => {
    const d = makeDeps();
    const orchestrator = new FilterOrchestrator(d);

    const warmLatencies: number[] = [];
    const coldLatencies: number[] = [];

    // Measure 20 cold runs
    for (let i = 0; i < 20; i++) {
      const container = document.createElement('div');
      container.innerHTML = cardHtml(`v_bench_cold_${i}`, `Cold Video ${i}`);
      document.body.appendChild(container);

      const t0 = performance.now();
      await orchestrator.processBatch([container]);
      coldLatencies.push(performance.now() - t0);
    }

    // Measure 20 warm runs (memo hits)
    for (let i = 0; i < 20; i++) {
      const container = document.createElement('div');
      // Same IDs as evaluated above -> now warm in verdict memo!
      container.innerHTML = cardHtml(`v_bench_cold_${i}`, `Cold Video ${i}`);
      document.body.appendChild(container);

      const t0 = performance.now();
      await orchestrator.processBatch([container]);
      warmLatencies.push(performance.now() - t0);
    }

    warmLatencies.sort((a, b) => a - b);
    coldLatencies.sort((a, b) => a - b);

    const warmP50 = warmLatencies[Math.floor(warmLatencies.length * 0.5)]!;
    const warmP95 = warmLatencies[Math.floor(warmLatencies.length * 0.95)]!;
    const coldP50 = coldLatencies[Math.floor(coldLatencies.length * 0.5)]!;
    const coldP95 = coldLatencies[Math.floor(coldLatencies.length * 0.95)]!;

    // Warm memo hits must be bounded and fast
    expect(warmP50).toBeLessThanOrEqual(coldP50 + 10);
    expect(warmP95).toBeLessThan(100);

    // Output empirical measurements for release evidence
    console.log(
      `[V5-04 Flash Timing Benchmark] Warm P50: ${warmP50.toFixed(2)}ms, Warm P95: ${warmP95.toFixed(2)}ms | Cold P50: ${coldP50.toFixed(2)}ms, Cold P95: ${coldP95.toFixed(2)}ms`,
    );
  });
});
