import { expect, test } from '@playwright/test';
import { launchHarness, writeSettings, type Harness } from './utils';

/**
 * QA-10 (bounded): SPA navigation / recycle / scroll soak.
 *
 * 45 seconds of continuous navigation churn with mid-run settings flips.
 * Invariants: no unhandled page errors, card states stay correct, and DOM
 * node count stays bounded (no unbounded retained heap from leaked
 * placeholders/overlays).
 */

let harness: Harness;

test.beforeEach(async () => {
  harness = await launchHarness();
});

test.afterEach(async () => {
  await harness.cleanup();
});

const BASE = 'https://www.youtube.com';

test('QA-10 bounded soak: navigation churn stays stable and bounded', async () => {
  const pageErrors: string[] = [];
  harness.page.on('pageerror', (error) => pageErrors.push(String(error)));

  await writeSettings(harness.page, harness.extensionId, {
    enabled: true,
    mode: 'balanced',
    categoryActions: {},
    displayMode: 'placeholder',
    showExplanations: true,
    collectLocalStats: false,
    density: 'comfortable',
    theme: 'system',
    rulePacks: { fil: true },
    history: { enabled: true, retentionDays: 30 },
    shortsGuard: { enabled: false },
    performance: { preset: 'quality' },
    youtubeFeedback: { enabled: false },
    remoteProvider: { enabled: false, timeoutMs: 5000 },
  });

  const deadline = Date.now() + 45_000;
  let flips = 0;
  let navigations = 0;
  while (Date.now() < deadline) {
    await harness.page.goto(`${BASE}/`);
    await harness.page.waitForTimeout(200);
    navigations += 1;
    if (navigations % 3 === 0) {
      await harness.page.goto(`${BASE}/results`);
      await harness.page.waitForTimeout(200);
    }
    // Mid-run live settings flip (content script must keep up).
    if (navigations % 5 === 0) {
      flips += 1;
      await writeSettings(harness.page, harness.extensionId, {
        enabled: flips % 2 === 0,
        mode: 'balanced',
        categoryActions: {},
        displayMode: flips % 2 === 0 ? 'collapse' : 'placeholder',
        showExplanations: true,
        collectLocalStats: false,
        density: flips % 2 === 0 ? 'compact' : 'comfortable',
        theme: 'system',
        rulePacks: { fil: true },
        history: { enabled: true, retentionDays: 30 },
        shortsGuard: { enabled: false },
        performance: { preset: 'quality' },
        youtubeFeedback: { enabled: false },
        remoteProvider: { enabled: false, timeoutMs: 5000 },
      });
    }
  }

  // No unhandled errors during the soak.
  expect(pageErrors).toEqual([]);

  // Final state converges: filtering active on the home fixture.
  await writeSettings(harness.page, harness.extensionId, {
    enabled: true,
    mode: 'balanced',
    categoryActions: {},
    displayMode: 'placeholder',
    showExplanations: true,
    collectLocalStats: false,
    density: 'comfortable',
    theme: 'system',
    rulePacks: { fil: true },
    history: { enabled: true, retentionDays: 30 },
    shortsGuard: { enabled: false },
    performance: { preset: 'quality' },
    youtubeFeedback: { enabled: false },
    remoteProvider: { enabled: false, timeoutMs: 5000 },
  });
  await harness.page.goto(`${BASE}/`);
  await harness.page.waitForSelector('[data-testid="card-disclosure"][data-bts-state="hidden"]', {
    timeout: 15_000,
  });

  // Bounded DOM: owned elements must not accumulate across navigations.
  const counts = await harness.page.evaluate(() => ({
    nodes: document.querySelectorAll('*').length,
    owned: document.querySelectorAll('.bts-placeholder, .bts-overlay').length,
    states: document.querySelectorAll('[data-bts-state]').length,
  }));
  expect(counts.owned).toBeLessThanOrEqual(counts.states + 2);
  expect(counts.nodes).toBeLessThan(5000);
});
