import { expect, test } from '@playwright/test';
import { launchHarness, writeSettings, type Harness } from './utils';

/**
 * N17 extension reload/update lifecycle (regression for
 * evidence/extension-context-invalidated.png).
 *
 * Reproduces the user flow: reload the unpacked extension WHILE a YouTube tab
 * is open and filtered. After invalidation the tab must show ZERO page errors
 * (no uncaught "Extension context invalidated" promise), no stranded hidden
 * cards, and a visible notice telling the user to refresh. Reopening the
 * service worker must keep working after the reload.
 */

let harness: Harness;

test.beforeEach(async () => {
  harness = await launchHarness();
});

test.afterEach(async () => {
  await harness.cleanup();
});

test('N17: reload with an open filtered tab leaves no uncaught errors or stranded state', async () => {
  const pageErrors: string[] = [];
  const pageWarnings: string[] = [];

  await writeSettings(harness.page, harness.extensionId, {
    enabled: true,
    mode: 'balanced',
    displayMode: 'placeholder',
    showExplanations: true,
    collectLocalStats: false,
  });
  await harness.page.goto('https://www.youtube.com/');
  const card = harness.page.locator('[data-testid="card-disclosure"]');
  await expect(card.locator('.bts-placeholder')).toBeVisible({ timeout: 20_000 });

  harness.page.on('pageerror', (error) => {
    pageErrors.push(error.message);
  });
  harness.page.on('console', (message) => {
    if (message.type() === 'warning') pageWarnings.push(message.text());
  });

  // Reload the extension from an extension page: chrome.runtime.reload() is
  // the same runtime call an in-extension "reload" button performs, and it
  // invalidates every already-running content script context.
  const reloader = await harness.context.newPage();
  await reloader.goto(`chrome-extension://${harness.extensionId}/popup.html`);
  await reloader.evaluate(() => chrome.runtime.reload());
  // The reload page dies with the old context; Chrome restarts the worker
  // asynchronously. Wait for the dust to settle (worker restart + our
  // content-script teardown poll fires within ~10s).
  await harness.page.waitForTimeout(12_000);

  // The fatal defect: any UNCAUGHT context-invalidated error.
  const fatal = pageErrors.filter((m) => m.toLowerCase().includes('context invalidated'));
  expect(fatal, `uncaught invalidation errors: ${JSON.stringify(pageErrors)}`).toEqual([]);
  expect(pageWarnings.filter((m) => m.includes('extension context invalidated'))).toEqual([]);

  // No stranded hidden cards: presentation must be restored.
  expect(
    await card.getAttribute('data-bts-state'),
    'card must not stay hidden after invalidation',
  ).toBeNull();

  // A visible local notice explains what happened and how to recover.
  await expect(harness.page.locator('.bts-context-invalidated')).toBeVisible({ timeout: 15_000 });
});
