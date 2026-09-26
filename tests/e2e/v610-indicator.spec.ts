import { expect, test } from '@playwright/test';
import { launchHarness, writeSettings, type Harness } from './utils';

/**
 * V6-10 — the movable on-page activity chip, on the REAL extension:
 * position changes apply live; Off removes the chip; computed bounds are
 * asserted (not just attributes).
 */

let harness: Harness;

test.describe('activity chip positioning', () => {
  test.afterEach(async () => {
    await harness?.cleanup();
  });

  test('position applies live with real bounds; Off removes the chip', async () => {
    harness = await launchHarness();
    const { context, extensionId, page } = harness;
    void context;

    // Give the extension a completed-onboarding profile so setup doesn't nag.
    await writeSettings(page, extensionId, {});

    await page.goto('https://www.youtube.com/');
    await page.waitForTimeout(1_000);

    // Drive a hide on the fixture page via the context menu path is complex;
    // instead directly verify the chip lifecycle by evaluating the content
    // script's own DOM: seed a hidden card through storage-driven rescan.
    // Simpler honest route: the fixture home.html has matched cards; wait for
    // the chip to appear from real filtering.
    const chip = page.locator('.bts-activity-notice');
    await expect(chip).toBeVisible({ timeout: 20_000 });

    // Default: bottom-right — assert computed bounds are in the bottom-right quadrant.
    let box = await chip.boundingBox();
    expect(box).not.toBeNull();
    if (box) {
      const viewport = page.viewportSize()!;
      expect(box.x + box.width).toBeGreaterThan(viewport.width / 2);
      expect(box.y + box.height).toBeGreaterThan(viewport.height / 2);
    }

    // Switch to top-left: chip must MOVE live (no reload).
    await writeSettings(page, extensionId, {
      activityIndicator: { position: 'top-left' },
    });
    await expect(chip).toBeVisible({ timeout: 10_000 });
    box = await chip.boundingBox();
    expect(box).not.toBeNull();
    if (box) {
      const viewport = page.viewportSize()!;
      expect(box.x).toBeLessThan(viewport.width / 2);
      expect(box.y).toBeLessThan(viewport.height / 2);
    }

    // Off: the chip must be removed entirely (no placeholder UI left behind).
    await writeSettings(page, extensionId, {
      activityIndicator: { position: 'off' },
    });
    await expect(chip).toHaveCount(0, { timeout: 10_000 });
  });
});
