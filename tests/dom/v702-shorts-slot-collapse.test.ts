import { beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultSettings, type UserSettings } from '@/domain/settings';
import {
  applyDecision,
  setPresentationCallbacks,
  ensureStyles,
  restore,
} from '@/presentation/apply-decision';
import { PRESENTATION_CSS } from '@/presentation/style';
import { sessionRecovery } from '@/presentation/session-recovery';
import type { FilterDecision } from '@/domain/decision';
import type { NormalizedVideoCandidate, Surface } from '@/domain/video';
import { elementFromHtml } from '../fixtures/youtube';

/**
 * V7-01/V7-02: gap-free collapse on Shorts shelves.
 *
 * User-reported regression (screenshot): with Collapse selected, hidden
 * Shorts left small "Hidden by BlockTheSlop"-style boxes and a tall empty
 * area — the slot was never removed, and neighbor Shorts did not reflow.
 *
 * YouTube ships two real shelf shapes; both must collapse without gaps:
 *  - WHOLE-SHELF: one ytd-rich-item-renderer wraps the entire shelf; each
 *    ytm-shorts-lockup-view-model is itself the grid cell. The card's own
 *    collapse mark must remove the cell. Marking the outer rich-item would
 *    over-hide the WHOLE shelf (visible Shorts included) — forbidden.
 *  - PER-SHORT WRAPPERS: every Short sits in its own ytd-rich-item-renderer.
 *    Hiding only the inner lockup leaves an empty outer cell — the blank-slot
 *    regression — so the single-card wrapper must carry the slot mark.
 */

const SHORT = (id: string, n: string) => `
  <ytm-shorts-lockup-view-model data-testid="short-${n}" class="shortsLockupVisibleHost">
    <a href="/shorts/${id}" aria-label="Recipe short ${n}"></a>
    <span class="title">Quick recipe hack ${n}</span>
  </ytm-shorts-lockup-view-model>`;

/** Shape 1: the shelf is ONE rich-item; lockups are direct grid children. */
const WHOLE_SHELF_HTML = `
<div id="contents">
  <ytd-rich-item-renderer data-testid="shelf-item">
    <div id="content">
      <ytd-rich-shelf-renderer>
        <div id="contents">
          ${SHORT('shortAAA01', 'A')}${SHORT('shortBBB02', 'B')}${SHORT('shortCCC03', 'C')}${SHORT('shortDDD04', 'D')}${SHORT('shortEEE05', 'E')}
        </div>
      </ytd-rich-shelf-renderer>
    </div>
  </ytd-rich-item-renderer>
  <yt-lockup-view-model data-testid="rich-video-next">
    <a id="video-title-link" href="/watch?v=richvid01" aria-label="A normal long video">
      <span id="video-title">A normal long video</span>
    </a>
    <div id="channel-name"><a href="/channel/UCNormal111111111111111">Normal Channel</a></div>
  </yt-lockup-view-model>
</div>
`;

/** Shape 2: every Short is wrapped in its own rich-item renderer cell. */
const PER_SHORT_WRAPPERS_HTML = `
<div id="contents">
  ${['A', 'B', 'C', 'D', 'E']
    .map(
      (n, i) => `<ytd-rich-item-renderer data-testid="cell-${n}">
        <div id="content">
          ${SHORT(`short${n}${n}${n}${String(i).padStart(2, '0')}`, n)}
        </div>
      </ytd-rich-item-renderer>`,
    )
    .join('')}
</div>
`;

function decision(action: 'hide' | 'warn' | 'allow'): FilterDecision {
  return {
    action,
    reason: 'automatic',
    explanation: ['Synthetic media disclosure detected.'],
    rulesVersion: 'v1',
    classifierVersion: 'v1',
  };
}

function shortCandidate(id: string): NormalizedVideoCandidate {
  return {
    videoId: id,
    title: `Quick recipe hack ${id}`,
    channel: { channelId: 'UCShorts9999999999999999', displayName: 'Quick Bites' },
    surface: 'shorts-shelf' satisfies Surface,
    cardKind: 'shorts-video',
    badges: [],
    ariaLabels: [],
    metadataText: [],
    isShort: true,
    observedAt: Date.now(),
  };
}

function collapseSettings(): UserSettings {
  return { ...defaultSettings(), displayMode: 'collapse' };
}

interface Setup {
  shorts: () => Element[];
  visibleShorts: () => Element[];
  slotMarks: () => Element[];
}

function setup(html: string): Setup {
  document.body.innerHTML = '';
  ensureStyles();
  setPresentationCallbacks({
    showOnce: vi.fn(),
    why: vi.fn(),
    allowVideo: vi.fn(),
    allowChannel: vi.fn(),
  });
  sessionRecovery.clear();
  const root = elementFromHtml(html);
  document.body.appendChild(root);
  const all = () => [...root.querySelectorAll('ytm-shorts-lockup-view-model')];
  return {
    shorts: all,
    visibleShorts: () => all().filter((s) => s.getAttribute('data-bts-collapse') === null),
    slotMarks: () => [...document.querySelectorAll('[data-bts-slot="collapse"]')],
  };
}

describe('V7-02: Shorts shelf, WHOLE-SHELF shape (lockup is the grid cell)', () => {
  let s: Setup;
  beforeEach(() => {
    s = setup(WHOLE_SHELF_HTML);
    expect(s.shorts()).toHaveLength(5);
  });

  it('hiding one Short collapses the Short itself and NEVER marks a slot containing visible Shorts', () => {
    const first = s.shorts()[0]!;
    applyDecision(first, decision('hide'), shortCandidate('shortAAA01'), collapseSettings());
    expect(first.getAttribute('data-bts-state')).toBe('hidden');
    expect(first.getAttribute('data-bts-collapse')).toBe('');
    // Over-hide regression guard: the shelf's rich-item contains five Shorts,
    // so it must NOT be marked (the old :has() CSS would have hidden it all).
    expect(s.slotMarks()).toHaveLength(0);
    for (const visible of s.visibleShorts()) {
      expect(visible.getAttribute('data-bts-collapse')).toBeNull();
      expect(visible.hasAttribute('data-bts-state')).toBe(false);
      expect(visible.querySelector('.bts-placeholder')).toBeNull();
    }
  });

  it('two adjacent hides + one restore leave exactly the hidden pair collapsed', () => {
    const [a, b] = s.shorts();
    applyDecision(a!, decision('hide'), shortCandidate('shortAAA01'), collapseSettings());
    applyDecision(b!, decision('hide'), shortCandidate('shortBBB02'), collapseSettings());
    expect(a!.getAttribute('data-bts-collapse')).toBe('');
    expect(b!.getAttribute('data-bts-collapse')).toBe('');
    expect(s.slotMarks()).toHaveLength(0);
    // Restore A: it comes back, B stays collapsed.
    restore(a!);
    expect(a!.getAttribute('data-bts-collapse')).toBeNull();
    expect(a!.hasAttribute('data-bts-state')).toBe(false);
    expect(b!.getAttribute('data-bts-collapse')).toBe('');
    expect(s.visibleShorts().map((el) => el.getAttribute('data-testid'))).toEqual(
      expect.arrayContaining(['short-A', 'short-C', 'short-D', 'short-E']),
    );
  });

  it('placeholder mode shows the styled box and never collapses', () => {
    const settings: UserSettings = { ...defaultSettings(), displayMode: 'placeholder' };
    const first = s.shorts()[0]!;
    applyDecision(first, decision('hide'), shortCandidate('shortAAA01'), settings);
    expect(first.getAttribute('data-bts-collapse')).toBeNull();
    expect(first.querySelector('.bts-placeholder')?.textContent).toContain(
      'Hidden by BlockTheSlop',
    );
    expect(s.slotMarks()).toHaveLength(0);
  });
});

describe('V7-02: Shorts shelf, PER-SHORT WRAPPER shape (outer cell must leave the grid)', () => {
  let s: Setup;
  beforeEach(() => {
    s = setup(PER_SHORT_WRAPPERS_HTML);
    expect(s.shorts()).toHaveLength(5);
  });

  it('hiding a Short marks its single-card outer renderer as the collapsed slot', () => {
    const first = s.shorts()[0]!;
    applyDecision(first, decision('hide'), shortCandidate('shortAAA01'), collapseSettings());
    expect(first.getAttribute('data-bts-collapse')).toBe('');
    const marks = s.slotMarks();
    expect(marks).toHaveLength(1);
    expect(marks[0]!.matches('ytd-rich-item-renderer')).toBe(true);
    expect(marks[0]!.contains(first)).toBe(true);
    expect(marks[0]!.getAttribute('data-testid')).toBe('cell-A');
  });

  it('two adjacent hides collapse exactly two cells; visible Shorts keep untouched cells', () => {
    const shorts = s.shorts();
    applyDecision(shorts[0]!, decision('hide'), shortCandidate('shortAAA01'), collapseSettings());
    applyDecision(shorts[1]!, decision('hide'), shortCandidate('shortBBB02'), collapseSettings());
    const marks = s.slotMarks();
    expect(marks).toHaveLength(2);
    expect(marks.map((m) => m.getAttribute('data-testid')).sort()).toEqual(['cell-A', 'cell-B']);
    for (const visible of shorts.slice(2)) {
      expect(visible.getAttribute('data-bts-collapse')).toBeNull();
      expect(visible.hasAttribute('data-bts-state')).toBe(false);
    }
    // No marked cell contains a visible Short.
    for (const mark of marks) {
      for (const visible of shorts.slice(2)) {
        expect(mark.contains(visible)).toBe(false);
      }
    }
  });

  it('restore removes the slot marks so the card reflows back into the grid', () => {
    const first = s.shorts()[0]!;
    applyDecision(first, decision('hide'), shortCandidate('shortAAA01'), collapseSettings());
    expect(s.slotMarks()).toHaveLength(1);
    restore(first);
    expect(s.slotMarks()).toHaveLength(0);
    expect(first.getAttribute('data-bts-collapse')).toBeNull();
    expect(first.hasAttribute('data-bts-state')).toBe(false);
  });

  it('warn state never marks slots or collapses the cell', () => {
    const first = s.shorts()[0]!;
    applyDecision(first, decision('warn'), shortCandidate('shortAAA01'), collapseSettings());
    expect(first.getAttribute('data-bts-state')).toBe('warn');
    expect(first.getAttribute('data-bts-collapse')).toBeNull();
    expect(s.slotMarks()).toHaveLength(0);
  });
});

describe('V7-02: collapse CSS covers Shorts cells without the over-hiding :has() rules', () => {
  it('PRESENTATION_CSS ships the slot rule and a direct Shorts lockup rule', () => {
    expect(PRESENTATION_CSS).toContain('[data-bts-slot="collapse"]');
    expect(PRESENTATION_CSS).toContain('ytm-shorts-lockup-view-model');
    expect(PRESENTATION_CSS).toContain('ytd-reel-item-renderer');
  });

  it('the generic rich-item :has() over-hide rules are gone', () => {
    expect(PRESENTATION_CSS).not.toContain('ytd-rich-item-renderer:has([data-bts-collapse])');
    expect(PRESENTATION_CSS).not.toContain(
      'ytd-rich-item-renderer:has(> #content > [data-bts-collapse])',
    );
    expect(PRESENTATION_CSS).not.toContain('ytd-rich-item-renderer:has(> [data-bts-collapse])');
  });

  it('runtime stylesheet carries the same rules', () => {
    setup(WHOLE_SHELF_HTML);
    const css = document.getElementById('bts-style')?.textContent ?? '';
    expect(css).toContain('[data-bts-slot="collapse"]');
    expect(css).toContain('ytm-shorts-lockup-view-model[data-bts-collapse]');
  });
});
