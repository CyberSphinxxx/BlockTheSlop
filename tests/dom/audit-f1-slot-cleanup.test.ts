import { beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultSettings, type UserSettings } from '@/domain/settings';
import {
  applyDecision,
  ensureStyles,
  restore,
  setPresentationCallbacks,
} from '@/presentation/apply-decision';
import { cleanupAll, restoreRecursively } from '@/presentation/cleanup';
import { sessionRecovery } from '@/presentation/session-recovery';
import type { FilterDecision } from '@/domain/decision';
import type { NormalizedVideoCandidate, Surface } from '@/domain/video';
import { elementFromHtml } from '../fixtures/youtube';

/**
 * Audit Finding 1: `data-bts-slot="collapse"` marks an OUTER YouTube renderer
 * and the shipped CSS hides it (`display:none !important`). Every cleanup /
 * restore path MUST clear that mark, or a restored (visible) card can remain
 * inside an invisible wrapper — or a disabled-surface card can stay hidden
 * with no extension state attributes at all to explain it.
 *
 * The hard case: the wrapper may no longer contain the marked card (YouTube
 * recycles slot wrappers wholesale for OTHER videos). Cleanup must therefore
 * clear extension-owned slot marks unconditionally — they are extension-owned
 * attributes, never YouTube's — while still scoping work to marked elements.
 * YouTube-owned attributes must never be touched, and cleanup must never
 * hide or reveal an entire multi-card shelf by itself.
 */

function decision(action: 'hide' | 'warn' | 'allow'): FilterDecision {
  return {
    action,
    reason: 'user-rule',
    ruleId: 'video-block:auditf1',
    explanation: ['Hidden by your rule.'],
  };
}

function collapseSettings(): UserSettings {
  return { ...defaultSettings(), displayMode: 'collapse' };
}

function shortCandidate(id: string): NormalizedVideoCandidate {
  return {
    videoId: id,
    title: `Audit short ${id}`,
    channel: { channelId: 'UCAudit1111111111111111', displayName: 'Audit Channel' },
    surface: 'shorts-shelf' satisfies Surface,
    cardKind: 'shorts-video',
    badges: [],
    ariaLabels: [],
    metadataText: [],
    isShort: true,
    observedAt: Date.now(),
  };
}

/** Shape 2 (per-short wrappers): each Short sits in its own rich-item cell. */
function perShortWrapperGrid(): Element {
  const html = `
  <div id="contents">
    ${['A', 'B', 'C', 'D', 'E']
      .map(
        (n, i) => `<ytd-rich-item-renderer data-testid="cell-${n}">
          <div id="content">
            <ytm-shorts-lockup-view-model data-testid="short-${n}" class="shortsLockupVisibleHost">
              <a href="/shorts/auditvid${i}" aria-label="Audit short ${n}"></a>
              <span class="title">Audit short ${n}</span>
            </ytm-shorts-lockup-view-model>
          </div>
        </ytd-rich-item-renderer>`,
      )
      .join('')}
  </div>`;
  document.body.innerHTML = '';
  ensureStyles();
  const root = elementFromHtml(html);
  document.body.appendChild(root);
  return root;
}

function cellOf(root: Element, n: string): { cell: Element; short: Element } {
  const cell = root.querySelector(`[data-testid="cell-${n}"]`);
  const short = root.querySelector(`[data-testid="short-${n}"]`);
  if (cell === null || short === null) throw new Error(`cell/short ${n} missing`);
  return { cell, short };
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

describe('Finding 1: every cleanup path clears extension-owned collapse slot marks', () => {
  it('REPRODUCES the audit finding: restoreRecursively on the marked WRAPPER clears the slot mark', () => {
    const root = perShortWrapperGrid();
    const { cell, short } = cellOf(root, 'A');
    hide(short, 'auditvid0');
    expect(short.getAttribute('data-bts-collapse')).toBe('');
    expect(cell.getAttribute('data-bts-slot')).toBe('collapse');

    // A wrapper-scoped restore (card already gone — YouTube recycled the
    // wrapper's contents for a different video) is a real cleanup path.
    short.remove();
    restoreRecursively(cell);
    expect(cell.hasAttribute('data-bts-slot')).toBe(false);
  });

  it('restore() on the card clears the mark even after the card moved OUT of the wrapper', () => {
    const root = perShortWrapperGrid();
    const { cell, short } = cellOf(root, 'B');
    hide(short, 'auditvid1');
    expect(cell.getAttribute('data-bts-slot')).toBe('collapse');
    // Recycled wrapper: the marked card was moved elsewhere (or replaced) —
    // the slot mark now hides a wrapper with NO marked card inside.
    document.body.appendChild(short);
    restore(short);
    expect(short.hasAttribute('data-bts-collapse')).toBe(false);
    expect(cell.hasAttribute('data-bts-slot')).toBe(false);
  });

  it('cleanupAll clears slot marks while preserving YouTube-owned attributes', () => {
    const root = perShortWrapperGrid();
    const { cell, short } = cellOf(root, 'C');
    hide(short, 'auditvid2');
    // YouTube's own attribute on the same wrapper must survive cleanup.
    cell.setAttribute('visibility', 'HAS_DATA');
    hide(cellOf(root, 'D').short, 'auditvid3');
    expect(document.querySelectorAll('[data-bts-slot="collapse"]').length).toBeGreaterThanOrEqual(
      2,
    );

    cleanupAll();
    expect(document.querySelectorAll('[data-bts-slot]').length).toBe(0);
    expect(cell.getAttribute('visibility')).toBe('HAS_DATA');
  });

  it('cleanupAll also clears slot marks on wrappers that no longer contain their card', () => {
    const root = perShortWrapperGrid();
    const { cell, short } = cellOf(root, 'A');
    hide(short, 'auditvid0');
    short.remove(); // wrapper recycled: marked cell now holds other content
    expect(cell.getAttribute('data-bts-slot')).toBe('collapse');
    cleanupAll();
    expect(document.querySelectorAll('[data-bts-slot]').length).toBe(0);
  });

  it('restoreRecursively never touches slot marks of unrelated cards', () => {
    const root = perShortWrapperGrid();
    const a = cellOf(root, 'A');
    const b = cellOf(root, 'B');
    hide(a.short, 'auditvid0');
    hide(b.short, 'auditvid1');
    expect(a.cell.getAttribute('data-bts-slot')).toBe('collapse');
    expect(b.cell.getAttribute('data-bts-slot')).toBe('collapse');

    restoreRecursively(a.cell); // scoped restore of ONE slot
    expect(a.cell.hasAttribute('data-bts-slot')).toBe(false);
    expect(b.cell.getAttribute('data-bts-slot')).toBe('collapse');
    expect(b.short.getAttribute('data-bts-collapse')).toBe('');
  });

  it('a visible (restored) card never remains inside a marked wrapper (Apply Allow transition)', () => {
    const root = perShortWrapperGrid();
    const { cell, short } = cellOf(root, 'E');
    hide(short, 'auditvid4');
    applyDecision(short, decision('allow'), shortCandidate('auditvid4'), collapseSettings());
    expect(short.hasAttribute('data-bts-state')).toBe(false);
    expect(short.hasAttribute('data-bts-collapse')).toBe(false);
    expect(cell.hasAttribute('data-bts-slot')).toBe(false);
  });

  it('restoreAll through the session-recovery store leaves no slot marks', () => {
    const root = perShortWrapperGrid();
    const { cell, short } = cellOf(root, 'A');
    hide(short, 'auditvid0');
    sessionRecovery.record(short, shortCandidate('auditvid0'), decision('hide'), 'sig-audit-0');
    expect(cell.getAttribute('data-bts-slot')).toBe('collapse');

    sessionRecovery.restoreAll((el) => restore(el));
    expect(short.hasAttribute('data-bts-collapse')).toBe(false);
    expect(cell.hasAttribute('data-bts-slot')).toBe(false);
  });
});

describe('Finding 1: computed-visibility contract (jsdom)', () => {
  it('after cleanupAll a previously collapsed card renders visible and its wrapper unmarked', () => {
    const root = perShortWrapperGrid();
    const { cell, short } = cellOf(root, 'B');
    hide(short, 'auditvid1');
    expect(getComputedStyle(short).display).toBe('none');
    expect(getComputedStyle(cell).display).toBe('none');

    cleanupAll();
    expect(getComputedStyle(short).display).not.toBe('none');
    expect(getComputedStyle(cell).display).not.toBe('none');
    expect(cell.hasAttribute('data-bts-slot')).toBe(false);
  });

  it('multi-card shelf: cleanup never hides or reveals the WHOLE shelf', () => {
    // Whole-shelf shape: one rich-item wraps five lockups. The wrapper must
    // never carry a slot mark, so cleanup cannot be what reveals/hides it.
    const html = `
    <div id="contents">
      <ytd-rich-item-renderer data-testid="shelf-item">
        <div id="content"><ytd-rich-shelf-renderer><div id="contents">
          ${['1', '2', '3']
            .map(
              (n, i) => `<ytm-shorts-lockup-view-model data-testid="shelf-short-${n}">
              <a href="/shorts/shelfaudit${i}" aria-label="Shelf short ${n}"></a>
            </ytm-shorts-lockup-view-model>`,
            )
            .join('')}
        </div></ytd-rich-shelf-renderer></div>
      </ytd-rich-item-renderer>
    </div>`;
    document.body.innerHTML = '';
    ensureStyles();
    const root = elementFromHtml(html);
    document.body.appendChild(root);
    const shelf = root.querySelector('[data-testid="shelf-item"]')!;
    const s1 = root.querySelector('[data-testid="shelf-short-1"]')!;
    hide(s1, 'shelfaudit0');
    expect(shelf.hasAttribute('data-bts-slot')).toBe(false);
    cleanupAll();
    expect(shelf.hasAttribute('data-bts-slot')).toBe(false);
    expect(getComputedStyle(shelf).display).not.toBe('none');
  });
});
