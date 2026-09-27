import { beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultSettings, type UserSettings } from '@/domain/settings';
import {
  applyDecision,
  ensureStyles,
  restore,
  setPresentationCallbacks,
} from '@/presentation/apply-decision';
import { clearOrphanedCollapseSlots } from '@/presentation/apply-decision';
import { cleanupAll, restoreRecursively } from '@/presentation/cleanup';
import { sessionRecovery } from '@/presentation/session-recovery';
import type { FilterDecision } from '@/domain/decision';
import type { NormalizedVideoCandidate, Surface } from '@/domain/video';
import { elementFromHtml } from '../fixtures/youtube';

/**
 * V7 defect (live repro, Strict + Collapse on YouTube search results):
 *   div.ytGridShelfViewModelGridShelfRow
 *     > div.ytGridShelfViewModelGridShelfItem      <- the 216x463 grid CELL
 *       > ytm-shorts-lockup-view-model-v2
 *         > ytm-shorts-lockup-view-model           <- the discovered CARD
 *
 * Hiding the inner Short left the OUTER GridShelfItem fully sized — a blank
 * slot in the results grid. The slot-marking walk (markCollapseSlot) did not
 * recognize the V2 Shorts wrappers, so no slot mark was set and the empty
 * cell stayed in layout. The fix must mark the narrowest single-card wrapper
 * (the GridShelfItem) — never the multi-item Row (whole-shelf protection) —
 * and every restore/cleanup path must clear the new marks.
 */

const ROW_ITEMS = ['A', 'B', 'C', 'D', 'E'] as const;

function v2ShelfHtml(): string {
  return `
  <div id="contents">
    <div class="ytGridShelfViewModelGridShelfRow" data-testid="v2-row">
      ${ROW_ITEMS.map(
        (n, i) => `<div class="ytGridShelfViewModelGridShelfItem" data-testid="v2-item-${n}">
          <ytm-shorts-lockup-view-model-v2 data-testid="v2-lockup-${n}">
            <ytm-shorts-lockup-view-model data-testid="v2-short-${n}" class="shortsLockupVisibleHost">
              <a href="/shorts/aiv2short${i + 1}" aria-label="AI generated clip ${n}"></a>
              <span class="title">Insane AI video ${n}</span>
            </ytm-shorts-lockup-view-model>
          </ytm-shorts-lockup-view-model-v2>
        </div>`,
      ).join('')}
    </div>
  </div>`;
}

function decision(action: 'hide' | 'warn' | 'allow'): FilterDecision {
  return {
    action,
    reason: 'user-rule',
    ruleId: 'video-block:v7v2slot',
    explanation: ['Hidden by your rule.'],
  };
}

function collapseSettings(): UserSettings {
  return { ...defaultSettings(), displayMode: 'collapse' };
}

function placeholderSettings(): UserSettings {
  return { ...defaultSettings(), displayMode: 'placeholder' };
}

function shortCandidate(id: string): NormalizedVideoCandidate {
  return {
    videoId: id,
    title: `Insane AI video ${id}`,
    channel: { channelId: 'UCV2Shorts00000000000000', displayName: 'AI Slop Mill' },
    surface: 'search' satisfies Surface,
    cardKind: 'shorts-video',
    badges: [],
    ariaLabels: [],
    metadataText: [],
    isShort: true,
    observedAt: Date.now(),
  };
}

interface Setup {
  root: Element;
  short: (n: string) => Element;
  item: (n: string) => Element;
  row: () => Element;
  slotMarks: () => Element[];
}

function setup(): Setup {
  document.body.innerHTML = '';
  ensureStyles();
  setPresentationCallbacks({
    showOnce: vi.fn(),
    why: vi.fn(),
    allowVideo: vi.fn(),
    allowChannel: vi.fn(),
  });
  sessionRecovery.clear();
  const root = elementFromHtml(v2ShelfHtml());
  document.body.appendChild(root);
  return {
    root,
    short: (n) => {
      const el = root.querySelector(`[data-testid="v2-short-${n}"]`);
      if (el === null) throw new Error(`v2-short-${n} missing`);
      return el;
    },
    item: (n) => {
      const el = root.querySelector(`[data-testid="v2-item-${n}"]`);
      if (el === null) throw new Error(`v2-item-${n} missing`);
      return el;
    },
    row: () => {
      const el = root.querySelector('[data-testid="v2-row"]');
      if (el === null) throw new Error('v2-row missing');
      return el;
    },
    slotMarks: () => [...document.querySelectorAll('[data-bts-slot="collapse"]')],
  };
}

function hide(card: Element, id: string): void {
  applyDecision(card, decision('hide'), shortCandidate(id), collapseSettings());
}

beforeEach(() => {
  document.body.innerHTML = '';
  ensureStyles();
  setPresentationCallbacks({
    showOnce: vi.fn(),
    why: vi.fn(),
    allowVideo: vi.fn(),
    allowChannel: vi.fn(),
  });
  sessionRecovery.clear();
});

describe('V7 Shorts V2: blank-slot repro (GridShelfItem must leave the grid)', () => {
  it('REPRODUCES: hiding the inner Short marks its GridShelfItem slot and removes its box', () => {
    const s = setup();
    const first = s.short('A');
    hide(first, 'aiv2short1');
    // The card itself carries the collapse mark…
    expect(first.getAttribute('data-bts-collapse')).toBe('');
    // …and the narrowest single-card wrapper (the GridShelfItem) is marked so
    // the 216x463 cell leaves the grid instead of rendering blank.
    expect(s.item('A').getAttribute('data-bts-slot')).toBe('collapse');
    // The lockup-v2 intermediate element is NOT a grid cell and must not be marked.
    expect(s.root.querySelector('[data-testid="v2-lockup-A"]')?.hasAttribute('data-bts-slot')).toBe(
      false,
    );
    // Computed visibility (jsdom honors the shipped stylesheet):
    expect(getComputedStyle(first).display).toBe('none');
    expect(getComputedStyle(s.item('A')).display).toBe('none');
    // No placeholder / recovery bar in collapse mode.
    expect(s.item('A').querySelector('.bts-placeholder')).toBeNull();
    expect(s.item('A').querySelector('.bts-status')).toBeNull();
  });

  it('first, middle, and last Shorts each collapse their own item; the row is never marked', () => {
    const s = setup();
    for (const n of ['A', 'C', 'E'] as const) {
      hide(s.short(n), `aiv2short${n}`);
      expect(s.item(n).getAttribute('data-bts-slot')).toBe('collapse');
    }
    expect(s.slotMarks().map((m) => m.getAttribute('data-testid'))).toEqual([
      'v2-item-A',
      'v2-item-C',
      'v2-item-E',
    ]);
    // Whole-shelf protection: the multi-item Row must NEVER carry a mark.
    expect(s.row().hasAttribute('data-bts-slot')).toBe(false);
    expect(getComputedStyle(s.row()).display).not.toBe('none');
  });

  it('two adjacent hides mark exactly two items; no marked item contains a visible Short', () => {
    const s = setup();
    hide(s.short('B'), 'aiv2short2');
    hide(s.short('C'), 'aiv2short3');
    const marks = s.slotMarks();
    expect(marks.map((m) => m.getAttribute('data-testid'))).toEqual(['v2-item-B', 'v2-item-C']);
    for (const visible of ['A', 'D', 'E'] as const) {
      expect(s.short(visible).getAttribute('data-bts-collapse')).toBeNull();
      expect(s.short(visible).hasAttribute('data-bts-state')).toBe(false);
      for (const mark of marks) {
        expect(mark.contains(s.short(visible))).toBe(false);
      }
    }
  });

  it('ALL Shorts in the row hidden: every item collapses, the row still stays visible', () => {
    const s = setup();
    for (const n of ROW_ITEMS) {
      hide(s.short(n), `aiv2short-${n}`);
    }
    expect(s.slotMarks()).toHaveLength(ROW_ITEMS.length);
    expect(s.row().hasAttribute('data-bts-slot')).toBe(false);
    // The row's computed display is untouched (its children are display:none).
    expect(getComputedStyle(s.row()).display).not.toBe('none');
  });
});

describe('V7 Shorts V2: restore, transition, and cleanup paths clear the new marks', () => {
  it('restore() returns the Short and clears its item mark; other items stay collapsed', () => {
    const s = setup();
    hide(s.short('A'), 'aiv2short1');
    hide(s.short('B'), 'aiv2short2');
    restore(s.short('A'));
    expect(s.short('A').hasAttribute('data-bts-collapse')).toBe(false);
    expect(s.short('A').hasAttribute('data-bts-state')).toBe(false);
    expect(s.item('A').hasAttribute('data-bts-slot')).toBe(false);
    expect(getComputedStyle(s.item('A')).display).not.toBe('none');
    // B remains hidden and its item stays marked.
    expect(s.short('B').getAttribute('data-bts-collapse')).toBe('');
    expect(s.item('B').getAttribute('data-bts-slot')).toBe('collapse');
    expect(s.slotMarks()).toHaveLength(1);
  });

  it('placeholder -> collapse transition marks the item; collapse -> placeholder unmarks it', () => {
    const s = setup();
    const first = s.short('A');
    // Placeholder mode: layout slot stays, placeholder inside the card.
    // (V7 default is collapse, so the mode is set EXPLICITLY here.)
    applyDecision(first, decision('hide'), shortCandidate('aiv2short1'), placeholderSettings());
    expect(first.querySelector('.bts-placeholder')).not.toBeNull();
    expect(s.item('A').hasAttribute('data-bts-slot')).toBe(false);
    expect(getComputedStyle(s.item('A')).display).not.toBe('none');
    // Switch to collapse on the already-hidden card (displayMode transition).
    applyDecision(first, decision('hide'), shortCandidate('aiv2short1'), collapseSettings());
    expect(first.querySelector('.bts-placeholder')).toBeNull();
    expect(first.getAttribute('data-bts-collapse')).toBe('');
    expect(s.item('A').getAttribute('data-bts-slot')).toBe('collapse');
    expect(getComputedStyle(s.item('A')).display).toBe('none');
    // And back to placeholder: the slot mark must go (N04 blocker-4).
    applyDecision(first, decision('hide'), shortCandidate('aiv2short1'), placeholderSettings());
    expect(s.item('A').hasAttribute('data-bts-slot')).toBe(false);
    expect(getComputedStyle(s.item('A')).display).not.toBe('none');
    expect(first.querySelector('.bts-placeholder')).not.toBeNull();
  });

  it('allow (surface/global disable path) reveals the card and clears the item mark', () => {
    const s = setup();
    hide(s.short('A'), 'aiv2short1');
    applyDecision(
      s.short('A'),
      decision('allow'),
      shortCandidate('aiv2short1'),
      collapseSettings(),
    );
    expect(s.short('A').hasAttribute('data-bts-state')).toBe(false);
    expect(s.short('A').hasAttribute('data-bts-collapse')).toBe(false);
    expect(s.item('A').hasAttribute('data-bts-slot')).toBe(false);
    expect(getComputedStyle(s.item('A')).display).not.toBe('none');
  });

  it('wrapper recycling: orphan sweep clears the mark after the card left its item', () => {
    const s = setup();
    const first = s.short('A');
    hide(first, 'aiv2short1');
    expect(s.item('A').getAttribute('data-bts-slot')).toBe('collapse');
    // YouTube recycled the wrapper: the marked card is moved out (or replaced).
    document.body.appendChild(first);
    // Batch finalizer runs the orphaned-mark sweep (orchestrator.processBatch).
    clearOrphanedCollapseSlots(s.root);
    expect(s.item('A').hasAttribute('data-bts-slot')).toBe(false);
  });

  it('restore() clears the item mark even when the card moved OUT of its item', () => {
    const s = setup();
    const first = s.short('A');
    hide(first, 'aiv2short1');
    document.body.appendChild(first); // recycled wrapper scenario
    restore(first);
    expect(first.hasAttribute('data-bts-collapse')).toBe(false);
    expect(s.item('A').hasAttribute('data-bts-slot')).toBe(false);
  });

  it('cleanupAll and restoreRecursively clear GridShelfItem marks', () => {
    const s = setup();
    hide(s.short('A'), 'aiv2short1');
    hide(s.short('B'), 'aiv2short2');
    restoreRecursively(s.item('A'));
    expect(s.item('A').hasAttribute('data-bts-slot')).toBe(false);
    expect(s.item('B').getAttribute('data-bts-slot')).toBe('collapse');
    cleanupAll();
    expect(document.querySelectorAll('[data-bts-slot]').length).toBe(0);
    expect(s.short('B').hasAttribute('data-bts-collapse')).toBe(false);
  });

  it('session-recovery restoreAll leaves no slot marks on the V2 shelf', () => {
    const s = setup();
    const first = s.short('A');
    hide(first, 'aiv2short1');
    sessionRecovery.record(first, shortCandidate('aiv2short1'), decision('hide'), 'sig-v2-a');
    expect(s.item('A').getAttribute('data-bts-slot')).toBe('collapse');
    sessionRecovery.restoreAll((el) => restore(el));
    expect(first.hasAttribute('data-bts-collapse')).toBe(false);
    expect(s.item('A').hasAttribute('data-bts-slot')).toBe(false);
  });

  it('warn state never marks the V2 item', () => {
    const s = setup();
    applyDecision(s.short('A'), decision('warn'), shortCandidate('aiv2short1'), collapseSettings());
    expect(s.short('A').getAttribute('data-bts-state')).toBe('warn');
    expect(s.short('A').hasAttribute('data-bts-collapse')).toBe(false);
    expect(s.slotMarks()).toHaveLength(0);
  });
});
