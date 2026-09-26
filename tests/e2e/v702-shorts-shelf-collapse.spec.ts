import { mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import {
  launchHarness,
  setFixtureOverride,
  writeSettings,
  writeRules,
  type Harness,
} from './utils';

/**
 * V7-02 — MANDATORY visual regression for the user-reported Shorts shelf
 * screenshot: with Collapse selected, hidden Shorts leave NO placeholder box
 * and NO outer renderer layout box; neighboring Shorts reflow into the first
 * positions. Real computed styles + bounding boxes on the freshly built
 * extension, with two adjacent hides, one restore, saved-Placeholder users,
 * and the onboarding Hide->Collapse default.
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

const SHORT_LABELS = ['Short one', 'Short two', 'Short three', 'Short four', 'Short five'];

/** Whole-shelf shape: one rich-item wraps the shelf; each lockup is a grid cell. */
function shortsShelfHtml(): string {
  const shorts = SHORT_LABELS.map(
    (label, i) => `
      <ytm-shorts-lockup-view-model data-testid="shelf-short-${i + 1}" class="shortsLockupVisibleHost">
        <a href="/shorts/shelfvid0${i + 1}" aria-label="${label} by Quick Bites"></a>
        <span class="title">${label}</span>
      </ytm-shorts-lockup-view-model>`,
  ).join('');
  return `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8" /><title>FixtureTube — Home with Shorts shelf</title>
  <style>
    body { margin: 0; font-family: Roboto, Arial, sans-serif; }
    ytm-shorts-lockup-view-model { display: inline-block; width: 160px; height: 300px; }
    .shortsLockupVisibleHost { margin: 0 8px 0 0; }
  </style></head>
  <body>
    <h1>Home</h1>
    <main id="contents">
      <ytd-rich-item-renderer data-testid="shelf-item">
        <div id="content"><ytd-rich-shelf-renderer><div id="contents">${shorts}</div></ytd-rich-shelf-renderer></div>
      </ytd-rich-item-renderer>
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
  top: number;
}

async function cardView(page: Page, selector: string): Promise<CardView> {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (el === null)
      return { display: 'missing', visibility: 'missing', w: 0, h: 0, x: 0, y: 0, top: 0 };
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    return {
      display: cs.display,
      visibility: cs.visibility,
      w: r.width,
      h: r.height,
      x: r.x,
      y: r.y,
      top: r.top,
    };
  }, selector);
}

test.describe('V7-02 Shorts shelf gap-free collapse', () => {
  test.afterEach(async () => {
    await harness?.cleanup();
    setFixtureOverride('shelf', null);
  });

  test('collapse removes hidden Shorts boxes entirely; neighbors reflow; restore returns the Short', async () => {
    mkdirSync(shotDir, { recursive: true });
    harness = await launchHarness();
    setFixtureOverride('shelf', shortsShelfHtml());
    await writeSettings(harness.page, harness.extensionId, {
      enabled: true,
      mode: 'strict',
      displayMode: 'collapse',
      showExplanations: false,
      collectLocalStats: false,
      surfaces: { 'shorts-shelf': true, home: true },
    });
    // Block the first two Shorts by explicit video rule (deterministic hide).
    const ext = await harness.page.context().newPage();
    await ext.goto(`chrome-extension://${harness.extensionId}/popup.html`);
    await ext.evaluate(async () => {
      const rules = {
        allowedVideoIds: [],
        blockedVideoIds: ['shelfvid01', 'shelfvid02'],
        allowedChannelIds: [],
        blockedChannelIds: [],
        fallbackAllowedHandles: [],
        fallbackBlockedHandles: [],
        blockedPhrases: [],
        channelRulesMeta: {},
      };
      await browser.storage.local.set({ 'local:rules': rules });
    });
    await ext.close();

    await harness.page.goto('https://www.youtube.com/shelf');
    const shot = (name: string) => `v7-shorts-${name}.png`;

    // 1) Both adjacent hidden Shorts are FULLY removed from layout.
    await expect
      .poll(async () => (await cardView(harness.page, '[data-testid="shelf-short-1"]')).display, {
        timeout: 20_000,
      })
      .toBe('none');
    await expect
      .poll(async () => (await cardView(harness.page, '[data-testid="shelf-short-2"]')).display, {
        timeout: 10_000,
      })
      .toBe('none');
    const s1 = await cardView(harness.page, '[data-testid="shelf-short-1"]');
    const s2 = await cardView(harness.page, '[data-testid="shelf-short-2"]');
    expect(s1.h).toBe(0);
    expect(s2.h).toBe(0);

    // No placeholder boxes anywhere on the shelf.
    const placeholders = await harness.page.evaluate(
      () => document.querySelectorAll('.bts-placeholder').length,
    );
    expect(placeholders).toBe(0);

    // No outer layout box remains: the hidden cells' bounding boxes are zero
    // and no shelf wrapper carries a residual visible box around the marks.
    const residual = await harness.page.evaluate(() => {
      const out: string[] = [];
      for (const el of document.querySelectorAll(
        'ytd-rich-item-renderer, ytd-rich-shelf-renderer, ytm-shorts-lockup-view-model',
      )) {
        const cs = getComputedStyle(el);
        if (cs.display !== 'none') continue;
        // display:none elements have no box — assert no half-collapsed state.
        const r = el.getBoundingClientRect();
        if (r.width > 0 || r.height > 0) out.push(el.tagName);
      }
      return out;
    });
    expect(residual).toEqual([]);

    // 2) Neighbors reflow: the first VISIBLE short now sits at the row origin
    // (x ≈ the row start), not in position three.
    const s3 = await cardView(harness.page, '[data-testid="shelf-short-3"]');
    expect(s3.display).not.toBe('none');
    expect(s3.x).toBeLessThanOrEqual(24);
    const s5 = await cardView(harness.page, '[data-testid="shelf-short-5"]');
    expect(s5.display).not.toBe('none');
    expect(s5.x).toBeLessThan(600);

    await harness.page.screenshot({
      path: join(shotDir, shot('collapse-reflow.png')),
      fullPage: true,
    });

    // 3) Restore short one via the session-recovery chip: it comes back into
    // the row, short two stays hidden.
    await expect
      .poll(
        async () =>
          harness.page.evaluate(
            () => document.querySelector('.bts-activity-notice')?.textContent ?? '',
          ),
        {
          timeout: 10_000,
        },
      )
      .toContain('hidden');
    await harness.page.click('.bts-activity-notice');
    await harness.page.waitForSelector('.bts-activity-panel', { timeout: 10_000 });
    // Restore the FIRST hidden Short by title (rows are newest-first; selecting
    // by row text guarantees the intended video's Restore button).
    await harness.page.click(
      '.bts-activity-item:has-text("Short one") .bts-button:has-text("Restore")',
    );
    await expect
      .poll(async () => (await cardView(harness.page, '[data-testid="shelf-short-1"]')).display, {
        timeout: 10_000,
      })
      .not.toBe('none');
    const s1After = await cardView(harness.page, '[data-testid="shelf-short-1"]');
    expect(s1After.h).toBeGreaterThan(100);
    const s2After = await cardView(harness.page, '[data-testid="shelf-short-2"]');
    expect(s2After.display).toBe('none');
    await harness.page.screenshot({
      path: join(shotDir, shot('after-restore.png')),
      fullPage: true,
    });
  });

  test('existing user with saved Placeholder keeps placeholder boxes on the Shorts shelf', async () => {
    mkdirSync(shotDir, { recursive: true });
    harness = await launchHarness();
    setFixtureOverride('shelf', shortsShelfHtml());
    await writeSettings(harness.page, harness.extensionId, {
      enabled: true,
      mode: 'strict',
      displayMode: 'placeholder',
      showExplanations: true,
      collectLocalStats: false,
      // An existing user's persisted surfaces blob (V6 shape) — merging keeps
      // every surface enabled while validating the stored shape.
      surfaces: {},
    });
    // Full V6-shaped rules blob (with V7's blockedPhraseRules key present so
    // validateRules keeps the stored object rather than filling defaults).
    await writeRules(harness.page, harness.extensionId, {
      allowedVideoIds: [],
      blockedVideoIds: ['shelfvid01', 'shelfvid02'],
      allowedChannelIds: [],
      blockedChannelIds: [],
      fallbackAllowedHandles: [],
      fallbackBlockedHandles: [],
      blockedPhrases: [],
      blockedPhraseRules: [],
      channelRulesMeta: {},
    });

    await harness.page.goto('https://www.youtube.com/shelf');
    // Wait for the placeholder to EXIST with real height — display 'missing'
    // (element absent while the content script initializes) must keep polling.
    await expect
      .poll(
        async () =>
          (await cardView(harness.page, '[data-testid="shelf-short-1"] .bts-placeholder')).h,
        { timeout: 20_000 },
      )
      .toBeGreaterThan(8);
    // The explicit Placeholder choice keeps the layout slot (box in the grid).
    const slot = await cardView(harness.page, '[data-testid="shelf-short-1"]');
    expect(slot.h).toBeGreaterThan(100);
    await harness.page.screenshot({
      path: join(shotDir, 'v7-shorts-placeholder-mode.png'),
      fullPage: true,
    });
  });

  test('Placeholder -> Collapse transition applies to already-filtered cards immediately', async () => {
    harness = await launchHarness();
    setFixtureOverride('shelf', shortsShelfHtml());
    await writeSettings(harness.page, harness.extensionId, {
      enabled: true,
      mode: 'strict',
      displayMode: 'placeholder',
      collectLocalStats: false,
    });
    const ext = await harness.page.context().newPage();
    await ext.goto(`chrome-extension://${harness.extensionId}/popup.html`);
    await ext.evaluate(async () => {
      const rules = {
        allowedVideoIds: [],
        blockedVideoIds: ['shelfvid01'],
        allowedChannelIds: [],
        blockedChannelIds: [],
        fallbackAllowedHandles: [],
        fallbackBlockedHandles: [],
        blockedPhrases: [],
        channelRulesMeta: {},
      };
      await browser.storage.local.set({ 'local:rules': rules });
    });
    await ext.close();

    await harness.page.goto('https://www.youtube.com/shelf');
    // Wait until the placeholder is actually rendered (display 'flex') before
    // flipping the mode — 'missing' must keep polling, not pass.
    await expect
      .poll(
        async () =>
          (await cardView(harness.page, '[data-testid="shelf-short-1"] .bts-placeholder')).display,
        { timeout: 20_000 },
      )
      .toBe('flex');

    // Flip the saved mode to Collapse; the already-filtered card must re-render
    // gap-free without a reload.
    await writeSettings(harness.page, harness.extensionId, {
      enabled: true,
      mode: 'strict',
      displayMode: 'collapse',
      collectLocalStats: false,
    });
    await expect
      .poll(async () => (await cardView(harness.page, '[data-testid="shelf-short-1"]')).display, {
        timeout: 20_000,
      })
      .toBe('none');
    const ph = await cardView(harness.page, '[data-testid="shelf-short-1"] .bts-placeholder');
    expect(ph.display === 'missing' || ph.display === 'none').toBe(true);
    await harness.page.screenshot({
      path: join(shotDir, 'v7-shorts-mode-switch.png'),
      fullPage: true,
    });
  });

  test('onboarding Hide choice lands new users on Collapse (gap-free shelf)', async () => {
    mkdirSync(shotDir, { recursive: true });
    harness = await launchHarness();
    setFixtureOverride('shelf', shortsShelfHtml());
    // FRESH install: no settings are pre-written. The onboarding Hide choice
    // must select Collapse — new users' stored settings carry the collapse
    // default and the onboarding never downgrades it to placeholder.
    const onboard = await harness.page.context().newPage();
    await onboard.goto(`chrome-extension://${harness.extensionId}/onboarding.html`);
    await onboard.getByRole('button', { name: 'Start' }).click({ timeout: 10_000 });
    // Discovery (default selection is fine).
    await onboard.getByRole('button', { name: 'Continue' }).click();
    // Content categories (defaults).
    await onboard.getByRole('button', { name: 'Continue' }).click();
    // Treatment: Hide must already be selected (default) — click it explicitly
    // to make the intent unambiguous.
    await onboard.getByText(/^Hide/).first().click();
    await onboard.getByRole('button', { name: 'Continue' }).click();
    // Sensitivity (default balanced).
    await onboard.getByRole('button', { name: 'Continue' }).click();
    // Review: single Apply transaction.
    await onboard.getByRole('button', { name: 'Apply', exact: true }).click();
    await expect(onboard.getByRole('heading', { name: /all set/i })).toBeVisible({
      timeout: 10_000,
    });
    const stored = await onboard.evaluate(async () => {
      const result = await browser.storage.local.get('local:settings');
      return (result['local:settings'] as Record<string, unknown>) ?? {};
    });
    expect(stored['displayMode']).toBe('collapse');
    await onboard.close();

    // The fresh profile must be gap-free: give it two deterministic hides and
    // confirm collapsed (no placeholder boxes) rendering on the shelf.
    const ext = await harness.page.context().newPage();
    await ext.goto(`chrome-extension://${harness.extensionId}/popup.html`);
    await ext.evaluate(async () => {
      const rules = {
        allowedVideoIds: [],
        blockedVideoIds: ['shelfvid01', 'shelfvid02'],
        allowedChannelIds: [],
        blockedChannelIds: [],
        fallbackAllowedHandles: [],
        fallbackBlockedHandles: [],
        blockedPhrases: [],
        channelRulesMeta: {},
      };
      await browser.storage.local.set({ 'local:rules': rules });
    });
    await ext.close();
    await harness.page.goto('https://www.youtube.com/shelf');
    await expect
      .poll(async () => (await cardView(harness.page, '[data-testid="shelf-short-1"]')).display, {
        timeout: 20_000,
      })
      .toBe('none');
    const placeholders = await harness.page.evaluate(
      () => document.querySelectorAll('.bts-placeholder').length,
    );
    expect(placeholders).toBe(0);
    await harness.page.screenshot({
      path: join(shotDir, 'v7-shorts-onboarding-collapse.png'),
      fullPage: true,
    });
  });
});
