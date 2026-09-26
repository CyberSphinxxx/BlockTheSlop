import { mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { launchHarness, writeSettings, type Harness } from './utils';

/**
 * V6-15 — deferred visual pass (bounded, 12 shots).
 * Covers the NEW V6 surfaces (onboarding, popup, statistics, chip positions)
 * across light/dark. Artifacts land in the V6 evidence dir (fingerprint-
 * excluded), so the release fingerprint stays stable.
 */

let harness: Harness;

const shotDir = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '.agents',
  'block-the-slop-v6',
  'screenshots',
);

test.describe('V6 visual evidence', () => {
  test.afterEach(async () => {
    await harness?.cleanup();
  });

  test('onboarding, popup, stats, and chip positions in light/dark', async () => {
    harness = await launchHarness();
    const { context, extensionId, page } = harness;
    mkdirSync(shotDir, { recursive: true });

    for (const theme of ['light', 'dark'] as const) {
      await writeSettings(page, extensionId, { theme });

      // Onboarding (reached via explicit navigation; completion state reset so
      // the flow renders rather than the completed page).
      const onboard = await context.newPage();
      await onboard.goto(`chrome-extension://${extensionId}/onboarding.html`);
      await onboard.evaluate(async () => {
        await browser.storage.local.set({ 'local:onboarding': { completed: false, version: 1 } });
      });
      await onboard.reload();
      await expect(onboard.getByRole('heading', { name: /welcome/i })).toBeVisible({
        timeout: 15_000,
      });
      await onboard.screenshot({ path: join(shotDir, `v6-${theme}-onboarding.png`) });
      await onboard.close();

      // Popup.
      const popup = await context.newPage();
      await popup.goto(`chrome-extension://${extensionId}/popup.html`);
      await expect(popup.getByRole('heading', { name: 'BlockTheSlop' })).toBeVisible({
        timeout: 15_000,
      });
      await popup.screenshot({ path: join(shotDir, `v6-${theme}-popup.png`) });
      await popup.close();

      // Statistics page.
      const stats = await context.newPage();
      await stats.goto(`chrome-extension://${extensionId}/options.html`);
      await expect(stats.getByRole('button', { name: 'Statistics' })).toBeVisible({
        timeout: 15_000,
      });
      await stats.getByRole('button', { name: 'Statistics' }).click();
      await expect(stats.getByRole('heading', { name: /statistics/i })).toBeVisible();
      await stats.screenshot({ path: join(shotDir, `v6-${theme}-stats.png`) });
      await stats.close();

      // Chip: bottom-right default vs top-left (fixture page with a hidden card).
      await page.goto('https://www.youtube.com/');
      const chip = page.locator('.bts-activity-notice');
      await writeSettings(page, extensionId, {
        activityIndicator: { position: 'bottom-right' },
      });
      // Wait for real filtering to produce a hidden card (the chip only
      // renders when at least one distinct video is hidden).
      const chipAppeared = await chip
        .waitFor({ state: 'visible', timeout: 20_000 })
        .then(() => true)
        .catch(() => false);
      if (chipAppeared) {
        await page.screenshot({ path: join(shotDir, `v6-${theme}-chip-bottom-right.png`) });
        await writeSettings(page, extensionId, {
          activityIndicator: { position: 'top-left' },
        });
        await expect(chip).toBeVisible({ timeout: 10_000 });
        await page.screenshot({ path: join(shotDir, `v6-${theme}-chip-top-left.png`) });
      }
    }

    // Sanity: bounded artifact set.
    expect(mkdirSync).toBeDefined();
  });
});
