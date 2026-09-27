import { expect, test, type Page } from '@playwright/test';
import { launchHarness, setFixtureOverride, writeSettings, type Harness } from './utils';

/**
 * Audit Finding 1 — loaded-extension Chromium E2E.
 *
 * `data-bts-slot="collapse"` hides an OUTER wrapper via CSS. When filtering
 * stops (global disable; the same cleanupAll path serves extension-context
 * teardown and navigation resets), that mark MUST be cleared: a visible card
 * must never sit inside an invisible marked wrapper, and a disabled page must
 * show real rendered content (computed styles + bounding boxes, not
 * attributes). Both YouTube shelf shapes are exercised:
 *  - WHOLE-SHELF: one rich-item wraps the shelf (never marked, never hidden);
 *  - PER-SHORT WRAPPERS: each Short has its own rich-item slot (marked when
 *    its Short is hidden; cleared by cleanup).
 */

interface Box {
  display: string;
  visibility: string;
  w: number;
  h: number;
}

async function boxOf(page: Page, selector: string): Promise<Box> {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (el === null) return { display: 'missing', visibility: 'missing', w: 0, h: 0 };
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    return { display: cs.display, visibility: cs.visibility, w: r.width, h: r.height };
  }, selector);
}

function auditPageHtml(): string {
  const short = (id: string, testid: string) =>
    `<ytm-shorts-lockup-view-model data-testid="${testid}" class="shortsLockupVisibleHost">
       <a href="/shorts/${id}" aria-label="Short ${testid}"></a>
       <span class="title">Short ${testid}</span>
     </ytm-shorts-lockup-view-model>`;
  // Whole-shelf shape: ONE rich-item wraps five shorts.
  const shelfShorts = ['f1shelf01', 'f1shelf02', 'f1shelf03', 'f1shelf04', 'f1shelf05']
    .map((id, i) => short(id, `shelf-short-${i + 1}`))
    .join('');
  // Per-short-wrapper shape: each short in its OWN rich-item cell.
  const cells = ['f1cell01', 'f1cell02', 'f1cell03', 'f1cell04', 'f1cell05']
    .map((id, i) => {
      const n = i + 1;
      return `<ytd-rich-item-renderer data-testid="cell-${n}">
        <div id="content">${short(id, `cell-short-${n}`)}</div>
      </ytd-rich-item-renderer>`;
    })
    .join('');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8" /><title>FixtureTube — audit F1</title>
<style>
  body { margin: 0; font-family: Roboto, Arial, sans-serif; }
  ytm-shorts-lockup-view-model { display: inline-block; width: 160px; height: 300px; }
  .shortsLockupVisibleHost { margin: 0 8px 0 0; }
  ytd-rich-item-renderer { display: block; margin-bottom: 12px; }
</style></head>
<body><h1>Home</h1>
<main id="contents">
  <ytd-rich-item-renderer data-testid="shelf-item">
    <div id="content"><ytd-rich-shelf-renderer><div id="contents">${shelfShorts}</div></ytd-rich-shelf-renderer></div>
  </ytd-rich-item-renderer>
  ${cells}
</main>
</body></html>`;
}

const BLOCKED = ['f1shelf01', 'f1shelf02', 'f1cell01', 'f1cell02'];

test.describe('Audit F1: cleanup clears collapse slot marks (loaded extension)', () => {
  let harness: Harness;

  test.afterEach(async () => {
    await harness?.cleanup();
    setFixtureOverride('shelf', null);
  });

  test('disable restores every hidden slot; shelf wrapper is never hidden or revealed as a whole', async () => {
    harness = await launchHarness();
    setFixtureOverride('shelf', auditPageHtml());
    await writeSettings(harness.page, harness.extensionId, {
      enabled: true,
      mode: 'strict',
      displayMode: 'collapse',
      showExplanations: false,
      collectLocalStats: false,
      surfaces: { 'shorts-shelf': true, home: true },
    });
    const ext = await harness.page.context().newPage();
    await ext.goto(`chrome-extension://${harness.extensionId}/popup.html`);
    await ext.evaluate(async (ids) => {
      await browser.storage.local.set({
        'local:rules': {
          allowedVideoIds: [],
          blockedVideoIds: ids,
          allowedChannelIds: [],
          blockedChannelIds: [],
          fallbackAllowedHandles: [],
          fallbackBlockedHandles: [],
          blockedPhrases: [],
          blockedPhraseRules: [],
          channelRulesMeta: {},
        },
      });
    }, BLOCKED);
    await ext.close();

    await harness.page.goto('https://www.youtube.com/shelf');

    // Both shapes collapse exactly the blocked shorts; per-short slots marked.
    await expect
      .poll(async () => (await boxOf(harness.page, '[data-testid="shelf-short-1"]')).display, {
        timeout: 20_000,
      })
      .toBe('none');
    await expect
      .poll(async () => (await boxOf(harness.page, '[data-testid="cell-short-1"]')).display, {
        timeout: 10_000,
      })
      .toBe('none');
    // The per-short wrapper slot must actually be marked and hidden (poll —
    // never a bare read, per the v702 missing-vs-none lesson).
    await expect
      .poll(async () => (await boxOf(harness.page, '[data-testid="cell-1"]')).display, {
        timeout: 10_000,
      })
      .toBe('none');
    const cell1 = await boxOf(harness.page, '[data-testid="cell-1"]');
    expect(cell1.display).toBe('none');
    expect(cell1.h).toBe(0);
    // The whole-shelf wrapper must NOT be marked or hidden (over-hide guard).
    const shelfSlotMarks = await harness.page.evaluate(
      () =>
        document.querySelector('[data-testid="shelf-item"]')?.getAttribute('data-bts-slot') ?? null,
    );
    expect(shelfSlotMarks).toBeNull();
    const shelfBox = await boxOf(harness.page, '[data-testid="shelf-item"]');
    expect(shelfBox.display).not.toBe('none');
    expect(shelfBox.h).toBeGreaterThan(100);

    // ---- Disable global filtering: cleanupAll runs. Every slot mark must go.
    await writeSettings(harness.page, harness.extensionId, { enabled: false });

    await expect
      .poll(
        async () =>
          harness.page.evaluate(
            () => document.querySelectorAll('[data-bts-slot="collapse"]').length,
          ),
        { timeout: 20_000 },
      )
      .toBe(0);
    await expect
      .poll(
        async () =>
          harness.page.evaluate(() => document.querySelectorAll('[data-bts-collapse]').length),
        { timeout: 10_000 },
      )
      .toBe(0);

    // Real rendered recovery: every previously collapsed short is VISIBLE.
    for (const testid of ['shelf-short-1', 'shelf-short-2', 'cell-short-1', 'cell-short-2']) {
      const b = await boxOf(harness.page, `[data-testid="${testid}"]`);
      expect(b.display, testid).not.toBe('none');
      expect(b.h, testid).toBeGreaterThan(100);
    }
    // No invisible wrapper may remain around a visible card.
    const invisibleAroundVisible = await harness.page.evaluate(() => {
      const out: string[] = [];
      for (const el of document.querySelectorAll('[data-bts-slot]')) {
        if ((el as HTMLElement).getBoundingClientRect().height > 0) continue;
        out.push(el.tagName);
      }
      return out;
    });
    expect(invisibleAroundVisible).toEqual([]);
    // The whole shelf stays visible through the transition (never over-hidden,
    // and cleanup must not "reveal" it by hiding anything).
    const shelfAfter = await boxOf(harness.page, '[data-testid="shelf-item"]');
    expect(shelfAfter.display).not.toBe('none');
    expect(shelfAfter.h).toBeGreaterThan(100);

    // ---- Re-enable with the same rules: filtering resumes on the live page.
    await writeSettings(harness.page, harness.extensionId, {
      enabled: true,
      mode: 'strict',
      displayMode: 'collapse',
      showExplanations: false,
      collectLocalStats: false,
      surfaces: { 'shorts-shelf': true, home: true },
    });
    await expect
      .poll(async () => (await boxOf(harness.page, '[data-testid="shelf-short-1"]')).display, {
        timeout: 20_000,
      })
      .toBe('none');
    await expect
      .poll(async () => (await boxOf(harness.page, '[data-testid="cell-short-1"]')).display, {
        timeout: 10_000,
      })
      .toBe('none');
    // Visible shorts stay visible; the shelf wrapper stays visible.
    const shelfResumed = await boxOf(harness.page, '[data-testid="shelf-item"]');
    expect(shelfResumed.display).not.toBe('none');
    for (const testid of ['shelf-short-3', 'cell-short-3']) {
      const b = await boxOf(harness.page, `[data-testid="${testid}"]`);
      expect(b.display, testid).not.toBe('none');
    }
  });
});
