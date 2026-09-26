import { expect, test } from '@playwright/test';
import { launchHarness, type Harness } from './utils';

/**
 * V6-02 — First-install-only onboarding lifecycle, on the REAL extension.
 *
 * Chromium loads the freshly built unpacked extension into a temp profile;
 * every assertion here runs against actual browser behavior (real
 * runtime.onInstalled, real tabs, real storage.local), not fixtures.
 */

let harness: Harness;

async function countOnboardingTabs(context: Harness['context']): Promise<number> {
  return context.pages().filter((p) => p.url().includes('/onboarding.html')).length;
}

test.describe('onboarding lifecycle', () => {
  test.afterEach(async () => {
    await harness?.cleanup();
  });

  test('a true first install opens onboarding exactly once', async () => {
    harness = await launchHarness();
    const { context, extensionId } = harness;

    // The harness launch IS a fresh install: the worker registers
    // onInstalled and fires it immediately for this profile.
    await expect
      .poll(async () => countOnboardingTabs(context), {
        timeout: 15_000,
        intervals: [250, 500, 1_000],
      })
      .toBe(1);

    // The page renders real content, not a blank tab.
    const onboarding = context.pages().find((p) => p.url().includes('/onboarding.html'));
    expect(onboarding).toBeDefined();
    await expect(onboarding!.getByRole('heading', { name: /welcome/i })).toBeVisible({
      timeout: 15_000,
    });

    // No duplicate tabs appear after the worker settles.
    await new Promise((r) => setTimeout(r, 1_500));
    expect(await countOnboardingTabs(context)).toBe(1);
    expect(extensionId).toBeTruthy();
  });

  test('completed setup never re-opens, even when reload refires onInstalled', async () => {
    harness = await launchHarness();
    const { context, extensionId } = harness;

    await expect.poll(async () => countOnboardingTabs(context), { timeout: 15_000 }).toBe(1);

    // The user completes (or skips) setup: completion is recorded in the
    // extension's real storage, mirroring OnboardingStore.markCompleted().
    const recorder = await context.newPage();
    await recorder.goto(`chrome-extension://${extensionId}/options.html`);
    await recorder.evaluate(async () => {
      const raw = (await browser.storage.local.get('local:onboarding'))['local:onboarding'] as
        Record<string, unknown> | undefined;
      const version = Math.max(Number(raw?.['version'] ?? 0), 1);
      await browser.storage.local.set({ 'local:onboarding': { ...raw, completed: true, version } });
    });

    // Real update/reload path: browser.runtime.reload() restarts the worker.
    // Depending on Chrome's behavior this fires onInstalled('install'|'update')
    // — either way, completed state must keep the flow closed.
    await recorder.evaluate(() => {
      browser.runtime.reload();
    });
    await recorder.waitForEvent('close', { timeout: 15_000 }).catch(() => {});

    // Give the restarted worker ample time to (wrongly) open onboarding.
    await new Promise((r) => setTimeout(r, 4_000));
    expect(await countOnboardingTabs(context)).toBe(0);
  });
});
