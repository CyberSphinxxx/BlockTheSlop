import { expect, test } from '@playwright/test';
import { launchHarness, waitForCardState, writeSettings } from './utils';

test('native context action saves a personal block, collapses the video, and updates the page count', async () => {
  const harness = await launchHarness();
  try {
    await harness.page.goto('https://www.youtube.com/');
    await writeSettings(harness.page, harness.extensionId, {
      enabled: true,
      mode: 'balanced',
      displayMode: 'collapse',
      history: { enabled: true, retentionDays: 30 },
    });
    await waitForCardState(harness.page, 'card-disclosure', 'hidden');
    await expect(harness.page.locator('.bts-activity-notice')).toContainText('1 video hidden');

    const card = harness.page.locator('[data-testid="card-human"]');
    await expect(card.locator('.bts-manual-action')).toHaveCount(0);
    const ext = await harness.context.newPage();
    await ext.goto(`chrome-extension://${harness.extensionId}/popup.html`);
    const manifest = await ext.evaluate(() => chrome.runtime.getManifest());
    expect(manifest.permissions).toContain('contextMenus');
    await card.locator('a#video-title-link').click({ button: 'right' });
    // Playwright cannot select a native Chromium menu item; send the same
    // background-to-content command after the real contextmenu event.
    await ext.evaluate(async () => {
      const [tab] = await chrome.tabs.query({ url: 'https://www.youtube.com/' });
      await chrome.tabs.sendMessage(tab.id!, { type: 'context:hideVideo' });
    });
    expect(harness.page.url()).toBe('https://www.youtube.com/');
    await waitForCardState(harness.page, 'card-human', 'hidden');
    await expect(harness.page.locator('.bts-activity-notice')).toContainText('2 videos hidden');

    const blocked = await ext.evaluate(async () => {
      const row = await browser.storage.local.get('local:rules');
      return (row['local:rules'] as { blockedVideoIds: string[] }).blockedVideoIds;
    });
    await ext.close();
    expect(blocked).toContain('human100');

    await harness.page.reload();
    await waitForCardState(harness.page, 'card-human', 'hidden');
    await expect(card).toBeHidden();

    await writeSettings(harness.page, harness.extensionId, { enabled: false });
    await expect(harness.page.locator('.bts-activity-notice')).toHaveCount(0);
    await expect.poll(() => card.getAttribute('data-bts-state')).toBeNull();
  } finally {
    await harness.cleanup();
  }
});
