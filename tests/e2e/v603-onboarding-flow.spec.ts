import { expect, test } from '@playwright/test';
import { launchHarness, readSettings, type Harness } from './utils';

/**
 * V6-03..V6-07 — the onboarding flow on the REAL extension: full walk
 * (welcome → discovery → categories → treatment → sensitivity → review →
 * apply), verifying the committed settings transaction in real storage.local.
 */

let harness: Harness;

test.describe('onboarding flow end-to-end', () => {
  test.afterEach(async () => {
    await harness?.cleanup();
  });

  test('full walk: choices are committed atomically and shown on Ready', async () => {
    harness = await launchHarness();
    const { context, extensionId } = harness;

    // The onboarding tab opens asynchronously after install; wait for it.
    let page = context.pages().find((p) => p.url().includes('/onboarding.html'));
    for (let i = 0; i < 60 && page === undefined; i++) {
      await new Promise((r) => setTimeout(r, 250));
      page = context.pages().find((p) => p.url().includes('/onboarding.html'));
    }
    expect(page).toBeDefined();
    const onboarding = page!;
    await expect(onboarding.getByRole('heading', { name: /welcome/i })).toBeVisible({
      timeout: 15_000,
    });

    // Step 1: welcome → Start.
    await onboarding.getByRole('button', { name: 'Start' }).click();

    // Step 2: discovery — answer locally (Friend or family), continue.
    await expect(onboarding.getByRole('heading', { name: /how did you find us/i })).toBeVisible();
    await onboarding.getByText('Friend or family').click();
    await onboarding.getByRole('button', { name: 'Continue' }).click();

    // Step 3: content — uncheck AI music, keep the rest (about-AI stays off).
    await expect(
      onboarding.getByRole('heading', { name: /what do you want filtered/i }),
    ).toBeVisible();
    await onboarding.getByRole('checkbox', { name: /^AI music/ }).uncheck();
    await onboarding.getByRole('button', { name: 'Continue' }).click();

    // Step 4: treatment — Warn (full label text on the radio's label).
    await expect(onboarding.getByRole('heading', { name: /what should happen/i })).toBeVisible();
    await onboarding.getByText(/^Warn/).click();
    await onboarding.getByRole('button', { name: 'Continue' }).click();

    // Step 5: sensitivity — High (click the option's label element).
    await expect(onboarding.getByRole('heading', { name: /how aggressively/i })).toBeVisible();
    await onboarding.locator('label').filter({ hasText: /High/ }).first().click();
    await onboarding.getByRole('button', { name: 'Continue' }).click();

    // Step 6: review — verify the summary mentions the discovery answer.
    await expect(onboarding.getByRole('heading', { name: /review your choices/i })).toBeVisible();
    await expect(onboarding.getByText(/Friend or family/)).toBeVisible();
    await onboarding.getByRole('button', { name: 'Apply' }).click();

    // Step 7: ready.
    await expect(onboarding.getByRole('heading', { name: /all set/i })).toBeVisible({
      timeout: 15_000,
    });

    // The committed transaction is visible in REAL storage.local.
    const settings = await readSettings(harness.page, extensionId);
    expect(settings['mode']).toBe('strict'); // High → strict
    const actions = settings['categoryActions'] as Record<string, string>;
    expect(actions['ai-music']).toBe('allow'); // unchecked → explicit allow
    expect(actions['ai-visual']).toBe('warn'); // checked + Warn treatment
    expect(actions['ai-discussion']).toBe('allow'); // about-AI was never turned on

    // The discovery answer and completion flag are durable and local.
    const ext = await context.newPage();
    await ext.goto(`chrome-extension://${extensionId}/options.html`);
    const onboardingState = await ext.evaluate(async () => {
      const result = (await browser.storage.local.get(['local:onboarding'])) as Record<
        string,
        unknown
      >;
      return result['local:onboarding'] as { completed: boolean; discoverySource?: string };
    });
    await ext.close();
    expect(onboardingState.completed).toBe(true);
    expect(onboardingState.discoverySource).toBe('friend');
  });
});
