import { expect, test, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchHarness, waitForCardState, writeSettings, type Harness } from './utils';

/**
 * V4-06 — aggressive-mode end-to-end + screenshot matrix.
 *
 * Asserts REAL computed visibility against the freshly built extension
 * (never just data attributes), verifies the new aggressive mode reacts to
 * LIVE settings changes on already-scanned cards, and produces a bounded
 * screenshot matrix (Light/Dark × mode × displayMode × main surfaces).
 * Everything runs on local fixtures under the routed youtube.com origin.
 */

let harness: Harness;

test.beforeEach(async () => {
  harness = await launchHarness();
});

test.afterEach(async () => {
  await harness.cleanup();
});

const CARD = '[data-testid="card-disclosure"]';
const HUMAN = '[data-testid="card-human"]';
const DISCUSSION = '[data-testid="card-discussion"]';
const AGGRESSIVE_ONLY = '[data-testid="card-aggressive-only"]';

/** Compute actual rendered visibility of an element (box + styles). */
function visibilityOf(
  page: Page,
  selector: string,
): Promise<{
  display: string;
  visibility: string;
  box: { w: number; h: number } | null;
}> {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (el === null) return { display: 'missing', visibility: 'missing', box: null };
    const cs = getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    return {
      display: cs.display,
      visibility: cs.visibility,
      box: { w: rect.width, h: rect.height },
    };
  }, selector);
}

test('V4-06: aggressive setting hides a previously visible fixture card without navigation', async () => {
  await harness.page.goto('https://www.youtube.com/');
  await writeSettings(harness.page, harness.extensionId, {
    enabled: true,
    mode: 'balanced',
    displayMode: 'placeholder',
    showExplanations: true,
    collectLocalStats: false,
  });
  // Wait for the extension to process the page in balanced mode: the
  // disclosure card hides (very-high confidence official label).
  await expect
    .poll(async () => (await visibilityOf(harness.page, `${CARD} .bts-placeholder`)).display, {
      timeout: 20_000,
    })
    .not.toBe('none');
  const humanBefore = await visibilityOf(harness.page, HUMAN);
  expect(humanBefore.display).not.toBe('none');
  // The disclosure and this card share the same first scan. Balanced may
  // either allow or warn the weaker signal; it must leave its video visible.
  expect(
    (await visibilityOf(harness.page, `${AGGRESSIVE_ONLY} #video-title-link`)).display,
  ).not.toBe('none');
  expect((await visibilityOf(harness.page, `${AGGRESSIVE_ONLY} .bts-placeholder`)).display).toBe(
    'missing',
  );

  // Flip to aggressive on the open fixture page (no navigation): setting →
  // live rescan on existing cards. The disclosure card stays hidden, and the
  // human + discussion cards stay visible (aggressive preserves gates).
  await writeSettings(harness.page, harness.extensionId, {
    enabled: true,
    mode: 'aggressive',
    displayMode: 'placeholder',
    showExplanations: true,
    collectLocalStats: false,
  });
  await waitForCardState(harness.page, 'card-aggressive-only', 'hidden');
  const nativeTitle = await visibilityOf(harness.page, `${AGGRESSIVE_ONLY} #video-title-link`);
  expect(nativeTitle.display).toBe('none');
  const newlyHidden = await visibilityOf(harness.page, `${AGGRESSIVE_ONLY} .bts-placeholder`);
  expect(newlyHidden.display).not.toBe('none');
  expect(newlyHidden.box?.h).toBeGreaterThan(10);
  await expect
    .poll(async () => (await visibilityOf(harness.page, HUMAN)).display, {
      timeout: 20_000,
    })
    .not.toBe('none');
  expect((await visibilityOf(harness.page, DISCUSSION)).display).not.toBe('none');
  expect((await visibilityOf(harness.page, `${CARD} .bts-placeholder`)).display).not.toBe('none');
  // Placeholder explanation must still be rendered (recoverability surface).
  const ph = await visibilityOf(harness.page, `${CARD} .bts-placeholder`);
  expect(ph.box).not.toBeNull();
  expect(ph.box!.h).toBeGreaterThan(10);
  await harness.page
    .locator(`${AGGRESSIVE_ONLY} .bts-placeholder`)
    .getByRole('button', { name: 'Reveal once' })
    .click();
  await expect
    .poll(
      async () =>
        (await visibilityOf(harness.page, `${AGGRESSIVE_ONLY} #video-title-link`)).display,
    )
    .not.toBe('none');
  expect((await visibilityOf(harness.page, `${AGGRESSIVE_ONLY} .bts-placeholder`)).display).toBe(
    'missing',
  );
});

test('V4-06 screenshot matrix: Light/Dark × mode × display × surfaces (bounded)', async () => {
  const shotDir = join(
    dirname(fileURLToPath(import.meta.url)),
    '..',
    '..',
    '.agents',
    'block-the-slop-v4',
    'screenshots',
  );
  mkdirSync(shotDir, { recursive: true });

  const themes = ['light', 'dark'] as const;
  const modes = ['safe', 'aggressive'] as const;
  const displays = ['placeholder', 'collapse'] as const;
  const routes: Array<{ path: string; label: string }> = [
    { path: '/', label: 'home' },
    { path: '/results', label: 'search' },
    { path: '/shorts/fixtureid01', label: 'shorts' },
  ];

  for (const theme of themes) {
    for (const mode of modes) {
      for (const display of displays) {
        await writeSettings(harness.page, harness.extensionId, {
          enabled: true,
          mode,
          displayMode: display,
          showExplanations: true,
          collectLocalStats: false,
          theme,
        });
        for (const r of routes) {
          await harness.page.goto(`https://www.youtube.com${r.path}`);
          await expect
            .poll(() => harness.page.locator('html').getAttribute('data-bts-theme'))
            .toBe(theme);
          if (r.label === 'home') {
            await waitForCardState(harness.page, 'card-disclosure', 'hidden');
            await expect
              .poll(async () => (await visibilityOf(harness.page, HUMAN)).display)
              .not.toBe('none');
          } else if (r.label === 'search') {
            await waitForCardState(harness.page, 'card-search-disclosure', 'hidden');
            await expect
              .poll(
                async () =>
                  (await visibilityOf(harness.page, '[data-testid="card-search-human"]')).display,
              )
              .not.toBe('none');
          } else {
            await expect(harness.page.locator('#shorts-player')).toBeVisible();
          }
          await harness.page.screenshot({
            path: join(shotDir, `${theme}-${mode}-${display}-${r.label}.png`),
          });
        }
      }
    }
  }
  // The matrix is bounded (2×2×2×3 = 24 shots). Basic sanity: the extension
  // must have processed the home fixture in the last configuration too.
  await harness.page.goto('https://www.youtube.com/');
  await expect
    .poll(async () => (await visibilityOf(harness.page, HUMAN)).display, { timeout: 20_000 })
    .not.toBe('none');
});
