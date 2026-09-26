import { expect, test } from '@playwright/test';
import { launchHarness, writeSettings, type Harness } from './utils';

/**
 * Audit A1 regression — the gap that let it ship:
 * DailyStatsState contains Sets; the background→popup channel JSON-serializes
 * them to {}. This E2E drives REAL background records and asserts the popup
 * renders real distinct counts through the actual message transport.
 */
let harness: Harness;

test.describe('daily stats over the real message channel', () => {
  test.afterEach(async () => {
    await harness?.cleanup();
  });

  test('popup renders distinct counts after real background records', async () => {
    harness = await launchHarness();
    const { context, extensionId, page } = harness;
    await writeSettings(page, extensionId, {});

    // Record two distinct hides + one repeat through the background worker
    // itself (runtime messaging from an extension page).
    const recorder = await context.newPage();
    await recorder.goto(`chrome-extension://${extensionId}/options.html`);
    await recorder.evaluate(async () => {
      await browser.runtime.sendMessage({
        type: 'stats:dailyRecord',
        payload: { outcome: 'hide', videoId: 'vidA', signature: 'sigA', observedAt: Date.now() },
      });
      await browser.runtime.sendMessage({
        type: 'stats:dailyRecord',
        payload: { outcome: 'hide', videoId: 'vidB', signature: 'sigB', observedAt: Date.now() },
      });
      // Repeat sighting of vidA must dedup to ONE distinct count.
      await browser.runtime.sendMessage({
        type: 'stats:dailyRecord',
        payload: { outcome: 'hide', videoId: 'vidA', signature: 'sigA', observedAt: Date.now() },
      });
    });

    // Open the REAL popup against the REAL background.
    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/popup.html`);
    await expect(popup.getByText(/Today \(/)).toBeVisible({ timeout: 15_000 });
    await expect(popup.getByText(/2\s*distinct videos hidden/)).toBeVisible({
      timeout: 15_000,
    });
    await recorder.close();
  });
});
