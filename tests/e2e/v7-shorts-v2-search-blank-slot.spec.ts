import { mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { launchHarness, setFixtureOverride, writeSettings, type Harness } from './utils';

/**
 * V7 Shorts V2 — live-repro regression on the SEARCH RESULTS surface
 * (Strict + Collapse): the observed DOM is
 *   div.ytGridShelfViewModelGridShelfRow
 *     > div.ytGridShelfViewModelGridShelfItem   (216x463 grid cell)
 *       > ytm-shorts-lockup-view-model-v2 > ytm-shorts-lockup-view-model.
 *
 * DEFECT: hiding the inner Short left the outer GridShelfItem fully sized —
 * blank slots in the results grid. FIXED behavior asserted here with REAL
 * computed styles + bounding boxes on the freshly built extension: the hidden
 * Short's item collapses to a zero box, neighbors reflow, restore brings the
 * Short AND its cell back, placeholder mode still keeps the slot, and a
 * placeholder->collapse mode switch applies live.
 */

let harness: Harness;

const shotDir = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '.agents',
  'block-the-slop-v7',
  'screenshots',
);

// Neutral titles: only the explicit video rules may trigger hides (a phrase
// like "AI generated" would trip the strict classifier and hide everything).
const LABELS = ['Short one', 'Short two', 'Short three', 'Short four', 'Short five'];

/** The observed Shorts V2 search-results shape with realistic cell sizing. */
function searchResultsHtml(): string {
  const items = LABELS.map(
    (label, i) => `
      <div class="ytGridShelfViewModelGridShelfItem" data-testid="v2e2e-item-${i + 1}">
        <ytm-shorts-lockup-view-model-v2 data-testid="v2e2e-lockup-${i + 1}">
          <ytm-shorts-lockup-view-model data-testid="v2e2e-short-${i + 1}" class="shortsLockupVisibleHost">
            <a href="/shorts/aiv2e2e0${i + 1}" aria-label="${label} by Quick Bites"></a>
            <span class="title">${label}</span>
          </ytm-shorts-lockup-view-model>
        </ytm-shorts-lockup-view-model-v2>
      </div>`,
  ).join('');
  return `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8" /><title>FixtureTube — search results</title>
  <style>
    body { margin: 0; font-family: Roboto, Arial, sans-serif; }
    #contents { padding: 24px; }
    .ytGridShelfViewModelGridShelfRow { display: flex; gap: 8px; }
    .ytGridShelfViewModelGridShelfItem { width: 216px; height: 463px; flex: 0 0 auto; }
    ytm-shorts-lockup-view-model-v2, ytm-shorts-lockup-view-model { width: 100%; height: 100%; display: block; }
  </style></head>
  <body>
    <h1>Results for "ai generated video"</h1>
    <main id="contents">
      <div class="ytGridShelfViewModelGridShelfRow" data-testid="v2e2e-row">${items}</div>
    </main>
  </body>
</html>`;
}

interface CardView {
  display: string;
  visibility: string;
  w: number;
  h: number;
  x: number;
  y: number;
}

async function cardView(page: Page, selector: string): Promise<CardView> {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (el === null) return { display: 'missing', visibility: 'missing', w: 0, h: 0, x: 0, y: 0 };
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    return {
      display: cs.display,
      visibility: cs.visibility,
      w: r.width,
      h: r.height,
      x: r.x,
      y: r.y,
    };
  }, selector);
}

async function writeSearchRules(harnessInner: Harness, blockedVideoIds: string[]): Promise<void> {
  const ext = await harnessInner.page.context().newPage();
  await ext.goto(`chrome-extension://${harnessInner.extensionId}/popup.html`);
  await ext.evaluate((ids) => {
    void browser.storage.local.set({
      'local:rules': {
        allowedVideoIds: [],
        blockedVideoIds: ids,
        allowedChannelIds: [],
        blockedChannelIds: [],
        fallbackAllowedHandles: [],
        fallbackBlockedHandles: [],
        blockedPhrases: [],
        channelRulesMeta: {},
      },
    });
  }, blockedVideoIds);
  await ext.close();
}

test.describe('V7 Shorts V2 search results: blank-slot collapse', () => {
  test.afterEach(async () => {
    await harness?.cleanup();
    setFixtureOverride('results', null);
  });

  test('collapse removes the hidden Shorts AND their 216x463 cells; neighbors reflow; restore returns the cell', async () => {
    mkdirSync(shotDir, { recursive: true });
    harness = await launchHarness();
    setFixtureOverride('results', searchResultsHtml());
    await writeSettings(harness.page, harness.extensionId, {
      enabled: true,
      mode: 'strict',
      displayMode: 'collapse',
      showExplanations: false,
      collectLocalStats: false,
      surfaces: { search: true, home: true },
    });
    await writeSearchRules(harness, ['aiv2e2e01', 'aiv2e2e02']);

    await harness.page.goto('https://www.youtube.com/results?search_query=ai+generated+video');

    // 1) Both adjacent hidden Shorts are fully removed from layout.
    await expect
      .poll(async () => (await cardView(harness.page, '[data-testid="v2e2e-short-1"]')).display, {
        timeout: 20_000,
      })
      .toBe('none');
    await expect
      .poll(async () => (await cardView(harness.page, '[data-testid="v2e2e-short-2"]')).display, {
        timeout: 10_000,
      })
      .toBe('none');
    const s1 = await cardView(harness.page, '[data-testid="v2e2e-short-1"]');
    expect(s1.h).toBe(0);
    expect(s1.w).toBe(0);

    // 2) THE DEFECT: no blank slot may remain. The outer GridShelfItem that
    // used to occupy 216x463 must itself be display:none with a zero box.
    // POLLED: the card collapses first via the V5-04 early pre-mark; the item
    // slot mark lands when the decision is finally presented (after the durable
    // write), so this assertion must synchronize on the ITEM, not the card.
    for (const n of [1, 2]) {
      await expect
        .poll(
          async () => (await cardView(harness.page, `[data-testid="v2e2e-item-${n}"]`)).display,
          {
            timeout: 20_000,
          },
        )
        .toBe('none');
      const item = await cardView(harness.page, `[data-testid="v2e2e-item-${n}"]`);
      expect(item.w).toBe(0);
      expect(item.h).toBe(0);
    }
    // No placeholder boxes anywhere.
    const placeholders = await harness.page.evaluate(
      () => document.querySelectorAll('.bts-placeholder').length,
    );
    expect(placeholders).toBe(0);

    // 3) Neighbors reflow: the first VISIBLE Short sits at the row origin.
    const s3 = await cardView(harness.page, '[data-testid="v2e2e-short-3"]');
    expect(s3.display).not.toBe('none');
    expect(s3.x).toBeLessThanOrEqual(32);
    const s5 = await cardView(harness.page, '[data-testid="v2e2e-short-5"]');
    expect(s5.display).not.toBe('none');
    expect(s5.x).toBeLessThan(700);

    await harness.page.screenshot({
      path: join(shotDir, 'v7-shorts-v2-search-collapse.png'),
      fullPage: true,
    });

    // 4) Restore the first Short via the session-recovery panel: the Short AND
    // its grid cell come back; the second stays hidden.
    await expect
      .poll(
        async () =>
          harness.page.evaluate(
            () => document.querySelector('.bts-activity-notice')?.textContent ?? '',
          ),
        { timeout: 10_000 },
      )
      .toContain('hidden');
    await harness.page.click('.bts-activity-notice');
    await harness.page.waitForSelector('.bts-activity-panel', { timeout: 10_000 });
    await harness.page.click(
      '.bts-activity-item:has-text("Short one") .bts-button:has-text("Restore")',
    );
    await expect
      .poll(async () => (await cardView(harness.page, '[data-testid="v2e2e-short-1"]')).display, {
        timeout: 10_000,
      })
      .not.toBe('none');
    const s1After = await cardView(harness.page, '[data-testid="v2e2e-short-1"]');
    expect(s1After.h).toBeGreaterThan(100);
    const item1After = await cardView(harness.page, '[data-testid="v2e2e-item-1"]');
    expect(item1After.display).not.toBe('none');
    expect(item1After.h).toBeGreaterThan(400);
    const s2After = await cardView(harness.page, '[data-testid="v2e2e-short-2"]');
    expect(s2After.display).toBe('none');
    await harness.page.screenshot({
      path: join(shotDir, 'v7-shorts-v2-search-after-restore.png'),
      fullPage: true,
    });
  });

  test('existing user with saved Placeholder keeps the grid slot on search results', async () => {
    mkdirSync(shotDir, { recursive: true });
    harness = await launchHarness();
    setFixtureOverride('results', searchResultsHtml());
    await writeSettings(harness.page, harness.extensionId, {
      enabled: true,
      mode: 'strict',
      displayMode: 'placeholder',
      showExplanations: true,
      collectLocalStats: false,
      surfaces: {},
    });
    await writeSearchRules(harness, ['aiv2e2e01']);

    await harness.page.goto('https://www.youtube.com/results?search_query=ai+generated+video');
    await expect
      .poll(
        async () =>
          (await cardView(harness.page, '[data-testid="v2e2e-short-1"] .bts-placeholder')).h,
        { timeout: 20_000 },
      )
      .toBeGreaterThan(8);
    // Placeholder mode KEEPS the layout slot (the box stays in the grid).
    const slot = await cardView(harness.page, '[data-testid="v2e2e-item-1"]');
    expect(slot.h).toBeGreaterThan(400);
    expect(slot.display).not.toBe('none');
    await harness.page.screenshot({
      path: join(shotDir, 'v7-shorts-v2-search-placeholder.png'),
      fullPage: true,
    });
  });

  test('placeholder -> collapse switch applies live to already-filtered V2 search cards', async () => {
    harness = await launchHarness();
    setFixtureOverride('results', searchResultsHtml());
    await writeSettings(harness.page, harness.extensionId, {
      enabled: true,
      mode: 'strict',
      displayMode: 'placeholder',
      collectLocalStats: false,
    });
    await writeSearchRules(harness, ['aiv2e2e01']);

    await harness.page.goto('https://www.youtube.com/results?search_query=ai+generated+video');
    await expect
      .poll(
        async () =>
          (await cardView(harness.page, '[data-testid="v2e2e-short-1"] .bts-placeholder')).display,
        { timeout: 20_000 },
      )
      .toBe('flex');

    // Flip the saved mode to Collapse; the already-filtered card AND its grid
    // cell must collapse gap-free without a reload.
    await writeSettings(harness.page, harness.extensionId, {
      enabled: true,
      mode: 'strict',
      displayMode: 'collapse',
      collectLocalStats: false,
    });
    await expect
      .poll(async () => (await cardView(harness.page, '[data-testid="v2e2e-item-1"]')).display, {
        timeout: 20_000,
      })
      .toBe('none');
    const item = await cardView(harness.page, '[data-testid="v2e2e-item-1"]');
    expect(item.h).toBe(0);
    const ph = await cardView(harness.page, '[data-testid="v2e2e-short-1"] .bts-placeholder');
    expect(ph.display === 'missing' || ph.display === 'none').toBe(true);
    await harness.page.screenshot({
      path: join(shotDir, 'v7-shorts-v2-search-mode-switch.png'),
      fullPage: true,
    });
  });
});
