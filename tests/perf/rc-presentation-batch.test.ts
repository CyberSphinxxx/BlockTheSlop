import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  applyDecision,
  ensureStyles,
  restore,
  setPresentationCallbacks,
} from '@/presentation/apply-decision';
import { defaultSettings } from '@/domain/settings';
import type { NormalizedVideoCandidate } from '@/domain/video';
import type { FilterDecision } from '@/domain/decision';
import { elementFromHtml } from '../fixtures/youtube';

/**
 * §9D performance guard for the PRESENTATION layer.
 *
 * The per-card cleanup path (removeStaleState → clearOrphanedCollapseSlots)
 * currently sweeps `[data-bts-slot="collapse"]` across the whole document for
 * EVERY card it touches. On a large feed the sweep is cheap today because the
 * attribute selector matches nothing, but a regression that made it walk the
 * grid per card (or that ran per restored card in a large restore) would turn
 * batch presentation O(N²) — measurable here at orders of magnitude.
 *
 * Ceilings are generous (CI variance), mirroring tests/perf/large-grid.test.ts.
 */

function decision(): FilterDecision {
  return {
    action: 'hide',
    reason: 'user-rule',
    ruleId: 'video-block:perf',
    explanation: ['Hidden by your rule.'],
  };
}

function settings() {
  return { ...defaultSettings(), displayMode: 'collapse' as const };
}

function candidate(i: number): NormalizedVideoCandidate {
  return {
    videoId: `perfrc${String(i).padStart(4, '0')}`,
    title: `Perf RC video ${i}`,
    channel: { channelId: 'UCPerfRc000000000000000' },
    surface: 'home',
    cardKind: 'video',
    badges: [],
    ariaLabels: [],
    metadataText: [],
    isShort: false,
    observedAt: Date.now(),
  };
}

describe('§9D: batch presentation stays far from O(N²)', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    ensureStyles();
    setPresentationCallbacks({
      showOnce: vi.fn(),
      why: vi.fn(),
      allowVideo: vi.fn(),
      allowChannel: vi.fn(),
    });
  });

  it('hide + restore 500 cards within budget (document-wide sweeps stay cheap)', () => {
    const els: Element[] = [];
    const container = document.createElement('main');
    document.body.appendChild(container);
    for (let i = 0; i < 500; i++) {
      const el = elementFromHtml(
        `<yt-lockup-view-model data-testid="p${i}">` +
          `<a id="video-title-link" href="/watch?v=perfrc${String(i).padStart(4, '0')}">` +
          `<span id="video-title">Perf RC video ${i}</span></a></yt-lockup-view-model>`,
      );
      container.appendChild(el);
      els.push(el);
    }
    const started = Date.now();
    for (let i = 0; i < els.length; i++) {
      applyDecision(els[i]!, decision(), candidate(i), settings());
    }
    for (let i = 0; i < els.length; i++) {
      restore(els[i]!);
    }
    const elapsed = Date.now() - started;
    // Generous ceiling: typical local run is tens of ms. An O(N²) regression
    // (per-card whole-grid work that walks all N cards) fails by orders of
    // magnitude, matching the philosophy of tests/perf/large-grid.test.ts.
    expect(elapsed).toBeLessThan(20_000);
  });

  it('collapse-slot CSS actually removes the rendered slot (layout contract, not just attributes)', () => {
    const container = document.createElement('main');
    document.body.appendChild(container);
    container.innerHTML = `<ytd-rich-item-renderer data-testid="slotwrap"><yt-lockup-view-model>
      <a id="video-title-link" href="/watch?v=slotvid01"><span id="video-title">Slot card</span></a>
    </yt-lockup-view-model></ytd-rich-item-renderer>
    <ytd-rich-item-renderer data-testid="slotneighbor"><yt-lockup-view-model>
      <a id="video-title-link" href="/watch?v=slotvid02"><span id="video-title">Neighbor card</span></a>
    </yt-lockup-view-model></ytd-rich-item-renderer>`;
    const card = container.querySelector('yt-lockup-view-model')!;
    const wrapper = container.querySelector('[data-testid="slotwrap"]')!;
    const neighbor = container.querySelector('[data-testid="slotneighbor"]')!;

    applyDecision(card, decision(), candidate(0), settings());
    // The single-card wrapper is the collapsed slot; the neighbor is not.
    expect(wrapper.getAttribute('data-bts-slot')).toBe('collapse');
    expect(neighbor.getAttribute('data-bts-slot')).toBeNull();

    // Restore clears the mark on the wrapper (and nothing else).
    restore(card);
    expect(wrapper.getAttribute('data-bts-slot')).toBeNull();
    expect(neighbor.getAttribute('data-bts-slot')).toBeNull();
  });
});
