import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FilterOrchestrator, type OrchestratorDeps } from '@/pipeline/orchestrator';
import {
  applyDecision,
  ensureStyles,
  identityRestoreMode,
  restore,
  setPresentationCallbacks,
} from '@/presentation/apply-decision';
import { defaultSettings, type UserSettings } from '@/domain/settings';
import { defaultRules } from '@/domain/rules';
import { sessionRecovery } from '@/presentation/session-recovery';
import { parseCardElement } from '@/youtube/parse/card';
import { identityOf } from '@/domain/video';
import type { FilterDecision } from '@/domain/decision';
import {
  elementFromHtml,
  RECYCLED_NODE_BEFORE_HTML,
  RECYCLED_NODE_AFTER_HTML,
} from '../fixtures/youtube';

/**
 * Release blocker B: a saved recovery identity for a card WITH YouTube's
 * official altered/synthetic disclosure validated the disclosure boolean but
 * never reconstructed it into officialDisclosure. identityOf(saved) therefore
 * disagreed with identityOf(current) for exactly those cards, and a genuinely
 * matching card got the 'unverified' restore path — revealed WITHOUT the
 * show-once override, so the next rescan re-hid it (loaded-extension repro:
 * restored:true, no override, display:none again after rescan).
 *
 * Contract under test (identityRestoreMode tri-state, unchanged elsewhere):
 *  - 'verified'  — ours, stamp current, saved identity == freshly parsed
 *                  identity across EVERY slot (incl. officialDisclosure).
 *  - 'unverified' — ours but not provably the same content: empty/malformed
 *                  signature, recycled card, or any identity-slot change.
 *  - 'foreign'   — no evidence stamp: restore must not touch the element.
 */

function decision(): FilterDecision {
  return {
    action: 'hide',
    reason: 'user-rule',
    ruleId: 'video-block:rcb',
    explanation: ['Hidden by your rule.'],
  };
}

function collapseSettings(): UserSettings {
  return { ...defaultSettings(), displayMode: 'collapse' };
}

interface CardOpts {
  title: string;
  videoId?: string;
  channelName?: string;
  channelId?: string;
  handle?: string;
  description?: string;
  disclosure?: boolean;
  shorts?: boolean;
}

function cardHtml(opts: CardOpts): string {
  const href =
    opts.shorts === true
      ? `/shorts/${opts.videoId ?? 'rcbshort01'}`
      : `/watch?v=${opts.videoId ?? 'rcbvid01'}`;
  const parts = [`<a id="video-title-link" href="${href}" aria-label="${opts.title}">`];
  parts.push(`<span id="video-title">${opts.title}</span></a>`);
  if (opts.description !== undefined) {
    parts.push(`<div id="snippet-text">${opts.description}</div>`);
  }
  if (opts.channelName !== undefined || opts.channelId !== undefined || opts.handle !== undefined) {
    const channelHref =
      opts.channelId !== undefined
        ? `/channel/${opts.channelId}`
        : opts.handle !== undefined
          ? `/@${opts.handle}`
          : '/@fallback';
    parts.push(
      `<div id="channel-name"><a href="${channelHref}" aria-label="${opts.channelName ?? opts.handle ?? ''}">${opts.channelName ?? opts.handle ?? ''}</a></div>`,
    );
  }
  if (opts.disclosure === true) {
    parts.push(
      '<div class="badges"><span class="badge badge-shape-wiz__text">Altered or synthetic content</span></div>',
    );
  }
  const inner = parts.join('');
  return opts.shorts === true
    ? `<ytm-shorts-lockup-view-model class="shortsLockupVisibleHost">${inner}</ytm-shorts-lockup-view-model>`
    : `<yt-lockup-view-model>${inner}</yt-lockup-view-model>`;
}

/** Create, attach, hide (collapse), and record a card like the pipeline does. */
function hideCard(opts: CardOpts): {
  el: Element;
  candidate: ReturnType<typeof parseCardElement>;
  signature: string;
} {
  const el = elementFromHtml(cardHtml(opts));
  document.body.appendChild(el);
  const candidate = parseCardElement(el, 'home', Date.now());
  applyDecision(el, decision(), candidate, collapseSettings());
  sessionRecovery.record(el, candidate, decision(), identityOf(candidate));
  return { el, candidate, signature: identityOf(candidate) };
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

describe('RC blocker B: saved identity matches disclosed cards (verified restore)', () => {
  it('REPRODUCES the blocker: official-disclosure card restores as verified', () => {
    const { el, signature } = hideCard({
      title: 'Disclosed video',
      videoId: 'rcbdisc01',
      channelId: 'UCRcb1111111111111111',
      channelName: 'RCB Channel',
      disclosure: true,
    });
    expect(el.getAttribute('data-bts-collapse')).not.toBeNull();
    // Old code: 'unverified' (saved identity lacked officialDisclosure).
    expect(identityRestoreMode(el, signature)).toBe('verified');
  });

  it('no-disclosure card still restores as verified', () => {
    const { el, signature } = hideCard({
      title: 'Plain video',
      videoId: 'rcbplain1',
      channelId: 'UCRcb2222222222222222',
      channelName: 'RCB Two',
    });
    expect(identityRestoreMode(el, signature)).toBe('verified');
  });

  it('Shorts card identity with disclosure restores as verified', () => {
    const { el, signature } = hideCard({
      title: 'Disclosed short',
      videoId: 'rcbshrt01',
      channelId: 'UCRcb3333333333333333',
      channelName: 'RCB Shorts',
      disclosure: true,
      shorts: true,
    });
    expect(identityRestoreMode(el, signature)).toBe('verified');
  });

  it('Shorts card identity without disclosure restores as verified', () => {
    const { el, signature } = hideCard({
      title: 'Plain short',
      videoId: 'rcbshrt02',
      handle: 'rcbhandle',
      shorts: true,
    });
    expect(identityRestoreMode(el, signature)).toBe('verified');
  });

  it('missing optional metadata (no videoId/channel/description) with disclosure still verifies', () => {
    const { el, signature } = hideCard({ title: 'Bare disclosed card', disclosure: true });
    expect(identityRestoreMode(el, signature)).toBe('verified');
  });

  it('a saved identity that disagrees on ANY slot (title changed) stays unverified', () => {
    const { el, signature } = hideCard({
      title: 'Original title',
      videoId: 'rcbmutat1',
      channelId: 'UCRcb4444444444444444',
      disclosure: true,
    });
    // The card content changed after the hide: identity must not match even
    // though the stamp may be re-validated by a fresh parse of same content…
    el.querySelector('#video-title')!.textContent = 'Mutated title';
    // NOTE: the stamp is content-only (id/title/channel), so the title change
    // also invalidates the stamp — assert the strict outcome either way.
    expect(identityRestoreMode(el, signature)).toBe('unverified');
  });
});

describe('RC blocker B: protections preserved (no blanket acceptance)', () => {
  it('A→B node recycling is still unverified', () => {
    const el = elementFromHtml(RECYCLED_NODE_BEFORE_HTML);
    document.body.appendChild(el);
    const candidate = parseCardElement(el, 'home', Date.now());
    applyDecision(el, decision(), candidate, collapseSettings());
    const signature = identityOf(candidate);
    const after = elementFromHtml(RECYCLED_NODE_AFTER_HTML);
    el.replaceChildren(...[...after.childNodes]);
    expect(identityRestoreMode(el, signature)).toBe('unverified');
  });

  it('malformed and empty signatures stay unverified; stamped stranger stays foreign', () => {
    const { el } = hideCard({
      title: 'Protections card',
      videoId: 'rcbprot01',
      channelId: 'UCRcb5555555555555555',
      disclosure: true,
    });
    expect(identityRestoreMode(el, '')).toBe('unverified');
    expect(identityRestoreMode(el, '["not","a","real","signature"]')).toBe('unverified');
    const stranger = elementFromHtml(RECYCLED_NODE_AFTER_HTML);
    document.body.appendChild(stranger);
    expect(identityRestoreMode(stranger, '')).toBe('foreign');
  });
});

describe('RC blocker B: behavioral restore via the real orchestrator (rescan survival)', () => {
  function deps(): OrchestratorDeps {
    return {
      getSettings: vi.fn(async () => collapseSettings()),
      getRules: vi.fn(async () => defaultRules()),
      getCachedClassifications: vi.fn(async (inputs: readonly unknown[]) =>
        inputs.map(() => undefined),
      ),
      putCachedClassifications: vi.fn(async () => {}),
      getCorrections: vi.fn(async () => ({ notAi: false, notSlop: false })),
      recordHiddenDurable: vi.fn(async () => {}),
      applyStats: vi.fn(async () => {}),
      isRemoteProviderEnabled: () => false,
    };
  }

  /** Mirror of the content script's validatedRestore + onDecisionApplied wiring. */
  function wire(orch: FilterOrchestrator): void {
    orchestratorWired = orch;
    orch.onDecisionApplied = (element, dec, candidate, signature) => {
      if (dec.action === 'hide') sessionRecovery.record(element, candidate, dec, signature);
      else sessionRecovery.removeByElement(element);
    };
  }
  let orchestratorWired: FilterOrchestrator | null = null;

  function validatedRestore(el: Element, sig: string): void {
    const mode = identityRestoreMode(el, sig);
    if (mode === 'verified' && orchestratorWired !== null) {
      orchestratorWired.showOnce(el, sig);
    } else if (mode === 'unverified') {
      restore(el);
    }
  }

  it('disclosed card: hide → restore → explicit rescan STAYS visible (override granted)', async () => {
    const d = deps();
    const orch = new FilterOrchestrator(d);
    wire(orch);
    document.body.innerHTML = `<main>${cardHtml({
      title: 'Behavioral disclosed card',
      videoId: 'rcbbehv01',
      channelId: 'UCRcb6666666666666666',
      disclosure: true,
    })}</main>`;
    const main = document.querySelector('main')!;
    const card = main.querySelector('yt-lockup-view-model')!;

    await orch.processBatch([main]);
    expect(card.getAttribute('data-bts-collapse')).not.toBeNull();

    // Restore through the session-recovery path (same wiring as production).
    const entry = sessionRecovery.list()[0]!;
    const outcome = sessionRecovery.restore(entry.id, validatedRestore);
    expect(outcome).toBe('restored');
    expect(card.getAttribute('data-bts-collapse')).toBeNull();
    expect(card.getAttribute('data-bts-state')).toBeNull();

    // Explicit rescan: the show-once override must suppress re-hiding.
    await orch.processBatch([main]);
    expect(card.getAttribute('data-bts-collapse')).toBeNull();
    expect(card.getAttribute('data-bts-state')).toBeNull();
    orch.stop();
  });

  it('unrelated DOM mutations do not re-hide a restored disclosed card', async () => {
    const d = deps();
    const orch = new FilterOrchestrator(d);
    wire(orch);
    document.body.innerHTML = `<main>${cardHtml({
      title: 'Mutation-stable card',
      videoId: 'rcbmutst1',
      channelId: 'UCRcb7777777777777777',
      disclosure: true,
    })}${cardHtml({
      title: 'Other blocked video',
      videoId: 'rcbother1',
      channelId: 'UCRcb8888888888888888',
    })}</main>`;
    const main = document.querySelector('main')!;
    const card = main.querySelector('yt-lockup-view-model')!;

    await orch.processBatch([main]);
    expect(card.getAttribute('data-bts-collapse')).not.toBeNull();

    const entry = sessionRecovery.list().find((e) => e.videoId === 'rcbmutst1')!;
    expect(sessionRecovery.restore(entry.id, validatedRestore)).toBe('restored');
    expect(card.getAttribute('data-bts-collapse')).toBeNull();

    // Unrelated mutation elsewhere on the page + rescan.
    const other = main.querySelectorAll('yt-lockup-view-model')[1]!;
    other.querySelector('#video-title')!.textContent = 'Other blocked video (edited)';
    await orch.processBatch([main]);
    expect(card.getAttribute('data-bts-collapse')).toBeNull();
    orch.stop();
  });

  it('a recycled element does not inherit the override: the new video re-hides', async () => {
    const d = deps();
    const orch = new FilterOrchestrator(d);
    wire(orch);
    document.body.innerHTML = `<main>${cardHtml({
      title: 'Recycle-override card',
      videoId: 'rcbcyc01',
      channelId: 'UCRcb9999999999999999',
      disclosure: true,
    })}</main>`;
    const main = document.querySelector('main')!;
    const card = main.querySelector('yt-lockup-view-model')!;

    await orch.processBatch([main]);
    const entry = sessionRecovery.list()[0]!;
    expect(sessionRecovery.restore(entry.id, validatedRestore)).toBe('restored');
    expect(card.getAttribute('data-bts-collapse')).toBeNull();

    // Recycle the element to a DIFFERENT blocked video, then rescan: the
    // override must not transfer — the new content is filtered normally.
    card.querySelector('a')!.setAttribute('href', '/watch?v=rcbcyc02');
    card.querySelector('#video-title')!.textContent = 'Recycled into the slot';
    await orch.processBatch([main]);
    expect(card.getAttribute('data-bts-collapse')).not.toBeNull();
    orch.stop();
  });
});

describe('RC blocker B: restore() distinguishes a real restore from “entry existed”', () => {
  it('a foreign-mode restore (stranger element) returns false and drops the entry', () => {
    // Record an entry, then swap the element for a stranger card we never
    // stamped (simulates a lost/foreign node): the callback performs NO
    // restore, so report failure instead of counting a successful restore.
    const { el, signature } = hideCard({
      title: 'Foreign-mode card',
      videoId: 'rcbfrgn01',
      channelId: 'UCRcb0000000000000001',
    });
    const stranger = elementFromHtml(RECYCLED_NODE_AFTER_HTML);
    document.body.appendChild(stranger);
    // The recorded element is replaced by an unmarked node at the same spot:
    // emulate by detaching the original element from the entry's perspective.
    el.remove();
    void signature;

    // Re-record using the stranger element so the entry points at a card we
    // never decided on (foreign mode at restore time).
    const strangerCandidate = parseCardElement(stranger, 'home', Date.now());
    sessionRecovery.record(stranger, strangerCandidate, decision(), '');
    const entry = sessionRecovery.list().find((e) => e.title === strangerCandidate.title)!;
    const restoreCalls: Array<[Element, string]> = [];
    const ok = sessionRecovery.restore(entry.id, (element, sig) => {
      restoreCalls.push([element, sig]);
      // Production validatedRestore: foreign → touch nothing, report obsolete
      // (demonstrably unrelated content — the entry is discarded).
      if (identityRestoreMode(element, sig) === 'foreign') return 'obsolete';
      restore(element);
      return true;
    });
    expect(restoreCalls).toHaveLength(1);
    expect(identityRestoreMode(restoreCalls[0]![0], restoreCalls[0]![1])).toBe('foreign');
    expect(ok).toBe('obsolete');
    expect(sessionRecovery.list()).toHaveLength(0);
  });

  it('a verified restore returns true exactly when the element was actually revealed', () => {
    const { el, signature } = hideCard({
      title: 'Real restore card',
      videoId: 'rcbreal01',
      channelId: 'UCRcb0000000000000002',
      disclosure: true,
    });
    const entry = sessionRecovery.list()[0]!;
    const ok = sessionRecovery.restore(entry.id, (element, sig) => {
      if (identityRestoreMode(element, sig) === 'verified') {
        restore(element);
        return true;
      }
    });
    expect(ok).toBe('restored');
    expect(el.getAttribute('data-bts-collapse')).toBeNull();
    void signature;
  });
});
