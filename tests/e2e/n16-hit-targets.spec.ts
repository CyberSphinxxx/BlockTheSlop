import { expect, test } from '@playwright/test';
import { launchHarness, writeSettings, type Harness } from './utils';

/**
 * N16 hover-proof review interaction (regression for
 * evidence/hover-preview-obscures-controls.png).
 *
 * The warn UI is now an IN-FLOW marker rendered after the thumbnail — it must
 * remain clickable while YouTube's hover preview would cover overlay-style
 * controls, expose real pointer hit targets at every button center
 * (document.elementFromPoint), and never trigger video navigation when the
 * user clicks its controls.
 */

let harness: Harness;

test.beforeEach(async () => {
  harness = await launchHarness();
});

test.afterEach(async () => {
  await harness.cleanup();
});

test('N16-A: warn marker controls are real pointer hit targets (elementFromPoint)', async () => {
  await writeSettings(harness.page, harness.extensionId, {
    enabled: true,
    mode: 'balanced',
    displayMode: 'placeholder',
    showExplanations: true,
    collectLocalStats: false,
  });
  // Search surface card that WARNS (bare #ai title), not hides.
  await harness.page.goto('https://www.youtube.com/results?search_query=ai+baby');
  const marker = harness.page.locator('[data-testid="card-search-aihash"] .bts-warn-marker');
  await expect(marker).toBeVisible({ timeout: 20_000 });

  const buttons = marker.locator('button.bts-button');
  const count = await buttons.count();
  expect(count).toBeGreaterThanOrEqual(2);

  for (let i = 0; i < count; i++) {
    const hit = await buttons.nth(i).evaluate((el) => {
      const r = el.getBoundingClientRect();
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      const top = document.elementFromPoint(cx, cy);
      // The topmost element at the button center must be the button itself
      // (or a node INSIDE it): nothing may cover the control.
      return {
        topIsInside: top !== null && (top === el || el.contains(top)),
        width: r.width,
        height: r.height,
      };
    });
    expect(hit.topIsInside, `button ${i} must be the top element at its center`).toBe(true);
    expect(hit.height, `button ${i} hit height >= 24px`).toBeGreaterThanOrEqual(24);
  }
});

test('N16-B: clicking marker controls does not navigate or start playback', async () => {
  await writeSettings(harness.page, harness.extensionId, {
    enabled: true,
    mode: 'balanced',
    displayMode: 'placeholder',
    showExplanations: true,
    collectLocalStats: false,
  });
  const urlBefore = 'https://www.youtube.com/results?search_query=ai+baby';
  await harness.page.goto(urlBefore);
  const marker = harness.page.locator('[data-testid="card-search-aihash"] .bts-warn-marker');
  await expect(marker).toBeVisible({ timeout: 20_000 });

  // Click "Why hidden?" — opens details in place, no navigation, no playback.
  await marker.locator('button:has-text("Why hidden?")').click();
  await expect(marker.locator('.bts-why-details')).toBeVisible();
  expect(harness.page.url()).toBe(urlBefore);
  expect(await harness.page.locator('video').count()).toBe(0);

  // "Reveal once" restores the card inline — still no navigation.
  await marker.locator('button:has-text("Reveal once")').click();
  const state = await harness.page
    .locator('[data-testid="card-search-aihash"]')
    .getAttribute('data-bts-state');
  expect(state).not.toBe('hidden');
  expect(harness.page.url()).toBe(urlBefore);
});

test('N16-C: details toggle keeps tab order and returns no duplicate controls after rescan', async () => {
  await writeSettings(harness.page, harness.extensionId, {
    enabled: true,
    mode: 'balanced',
    displayMode: 'placeholder',
    showExplanations: true,
    collectLocalStats: false,
  });
  await harness.page.goto('https://www.youtube.com/results?search_query=ai+baby');
  const marker = harness.page.locator('[data-testid="card-search-aihash"] .bts-warn-marker');
  await expect(marker).toBeVisible({ timeout: 20_000 });

  // Keyboard: Tab reaches the marker buttons; Enter opens the Why details.
  await marker.locator('button:has-text("Why hidden?")').focus();
  await harness.page.keyboard.press('Enter');
  await expect(marker.locator('.bts-why-details')).toBeVisible();
  await harness.page.keyboard.press('Enter');
  await expect(marker.locator('.bts-why-details')).toHaveCount(0);

  // DOM reuse: rescans must never duplicate marker controls.
  for (let i = 0; i < 3; i++) {
    await writeSettings(harness.page, harness.extensionId, {
      enabled: true,
      mode: i % 2 === 0 ? 'balanced' : 'strict',
      displayMode: 'placeholder',
      showExplanations: true,
      collectLocalStats: false,
    });
    await harness.page.waitForTimeout(150);
  }
  expect(
    await harness.page.locator('[data-testid="card-search-aihash"] .bts-warn-marker').count(),
  ).toBe(1);
});
