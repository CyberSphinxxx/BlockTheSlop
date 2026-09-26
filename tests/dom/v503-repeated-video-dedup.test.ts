import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FilterOrchestrator, type OrchestratorDeps } from '@/pipeline/orchestrator';
import { defaultSettings, type UserSettings } from '@/domain/settings';
import { defaultRules } from '@/domain/rules';
import {
  setPresentationCallbacks,
  type PresentationCallbacks,
  ensureStyles,
} from '@/presentation/apply-decision';
import { HideActivityNotice } from '@/presentation/activity';
import { ATTR_STATE, ATTR_VIDEO_ID } from '@/youtube/selectors';

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

describe('V5-03: Repeated Video Dedup and Memo Fast-Path (DOM)', () => {
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

  it('duplicate cards of the same video on the same surface commit only 1 durable write and do not inflate stats', async () => {
    const recordHiddenDurable = vi.fn(async () => {});
    const applyStats = vi.fn(async () => {});
    const d = makeDeps({ recordHiddenDurable, applyStats });
    const orchestrator = new FilterOrchestrator(d);

    const main = document.createElement('main');
    main.innerHTML = `
      ${cardHtml('v_dup1', 'AI Drone Video')}
      ${cardHtml('v_dup1', 'AI Drone Video')}
    `;
    document.body.appendChild(main);

    await orchestrator.processBatch([main]);

    const cards = document.querySelectorAll(`[${ATTR_STATE}="hidden"]`);
    expect(cards).toHaveLength(2);
    expect(cards[0]?.getAttribute(ATTR_VIDEO_ID)).toBe('v_dup1');
    expect(cards[1]?.getAttribute(ATTR_VIDEO_ID)).toBe('v_dup1');

    // Crucial V5-03 assertion: exactly 1 durable write across duplicate cards
    expect(recordHiddenDurable).toHaveBeenCalledTimes(1);

    // Stats: exactly 1 hidden count, no inflation
    const hiddenStatsCalls = (
      applyStats as unknown as { mock: { calls: unknown[][] } }
    ).mock.calls.filter((call) => {
      const delta = call[0] as { hidden?: number } | undefined;
      return delta && delta.hidden === 1;
    });
    expect(hiddenStatsCalls).toHaveLength(1);

    // Activity notice: counts distinct video IDs
    const activity = new HideActivityNotice();
    activity.update();
    const notice = document.querySelector('.bts-activity-notice');
    expect(notice?.textContent).toContain('1 video hidden');
  });

  it('same video appearing across multiple surfaces on the same page commits only 1 durable write', async () => {
    const recordHiddenDurable = vi.fn(async () => {});
    const d = makeDeps({ recordHiddenDurable });
    const orchestrator = new FilterOrchestrator(d);

    // Surface 1: Home grid
    const homeSection = document.createElement('div');
    homeSection.innerHTML = cardHtml('v_multi1', 'AI Art Generation');
    document.body.appendChild(homeSection);

    // Surface 2: Sidebar
    const sidebarSection = document.createElement('div');
    sidebarSection.innerHTML = cardHtml('v_multi1', 'AI Art Generation');
    document.body.appendChild(sidebarSection);

    await orchestrator.processBatch([homeSection]);
    expect(recordHiddenDurable).toHaveBeenCalledTimes(1);

    await orchestrator.processBatch([sidebarSection]);
    // Still exactly 1 durable write!
    expect(recordHiddenDurable).toHaveBeenCalledTimes(1);
  });

  it('second sighting hits Tier 2 verdict memo and fast-paths without classification round-trips', async () => {
    const getCachedClassifications = vi.fn(async (inputs: readonly unknown[]) =>
      inputs.map(() => undefined),
    );
    const d = makeDeps({ getCachedClassifications });
    const orchestrator = new FilterOrchestrator(d);

    const section1 = document.createElement('div');
    section1.innerHTML = cardHtml('v_fast1', 'Synthetic Voice News');
    document.body.appendChild(section1);

    await orchestrator.processBatch([section1]);
    expect(getCachedClassifications).toHaveBeenCalledTimes(1);

    // Now insert a second card of the same video
    const section2 = document.createElement('div');
    section2.innerHTML = cardHtml('v_fast1', 'Synthetic Voice News');
    document.body.appendChild(section2);

    await orchestrator.processBatch([section2]);

    // Fast-path: getCachedClassifications was NOT called again!
    expect(getCachedClassifications).toHaveBeenCalledTimes(1);

    const hiddenCards = document.querySelectorAll(`[${ATTR_STATE}="hidden"]`);
    expect(hiddenCards).toHaveLength(2);
  });

  it('correction invalidates memo and older false hide immediately', async () => {
    let notAi = false;
    const getCorrections = vi.fn(async () => ({ notAi, notSlop: false }));
    const d = makeDeps({ getCorrections });
    const orchestrator = new FilterOrchestrator(d);

    const container = document.createElement('div');
    container.innerHTML = cardHtml('v_cor1', 'Human Video Misclassified');
    document.body.appendChild(container);

    await orchestrator.processBatch([container]);
    const card = container.querySelector('yt-lockup-view-model')!;
    expect(card.getAttribute(ATTR_STATE)).toBe('hidden');

    // User marks video as Not AI:
    notAi = true;
    orchestrator.invalidateVideo('v_cor1');

    // Simulate re-evaluating the card:
    card.removeAttribute('data-bts-epoch');
    card.removeAttribute('data-bts-state');
    card.removeAttribute('data-bts-collapse');

    await orchestrator.processBatch([container]);

    // Older false hide must NOT survive: card must be restored and allowed (no hidden state)
    expect(card.getAttribute(ATTR_STATE)).toBeNull();
    expect(card.hasAttribute('data-bts-collapse')).toBe(false);
  });

  it('SPA navigation resets session-scoped history dedup for legitimate new session observations', async () => {
    const recordHiddenDurable = vi.fn(async () => {});
    const d = makeDeps({ recordHiddenDurable });
    const orchestrator = new FilterOrchestrator(d);

    // Page 1: video is seen and hidden
    const page1 = document.createElement('div');
    page1.innerHTML = cardHtml('v_nav1', 'AI Content');
    document.body.appendChild(page1);

    await orchestrator.processBatch([page1]);
    expect(recordHiddenDurable).toHaveBeenCalledTimes(1);

    // Duplicate card on page 1: skipped
    const page1Dup = document.createElement('div');
    page1Dup.innerHTML = cardHtml('v_nav1', 'AI Content');
    document.body.appendChild(page1Dup);
    await orchestrator.processBatch([page1Dup]);
    expect(recordHiddenDurable).toHaveBeenCalledTimes(1);

    // SPA navigation resets session-scoped history dedup:
    (orchestrator as unknown as { onNavigation: (url: string) => void }).onNavigation(
      'https://www.youtube.com/watch?v=xyz',
    );

    // Page 2: same video recommended again in a new session view
    const page2 = document.createElement('div');
    page2.innerHTML = cardHtml('v_nav1', 'AI Content');
    document.body.appendChild(page2);

    await orchestrator.processBatch([page2]);

    // Navigation reset session dedup: new session observation is recorded (count=2)
    expect(recordHiddenDurable).toHaveBeenCalledTimes(2);
  });
});
