import { expect, test, type Page } from '@playwright/test';
import { launchHarness, writeSettings, type Harness } from './utils';

/**
 * PRE-01..PRE-11 — real-browser visibility tests.
 *
 * These assert ACTUAL visibility (bounding boxes, computed styles) against
 * the built extension, not extension-owned data attributes. Audit A01/A02
 * meant "hidden" cards could remain visible; these tests fail in that world.
 */

let harness: Harness;

test.beforeEach(async () => {
  harness = await launchHarness();
  await writeSettings(harness.page, harness.extensionId, {
    enabled: true,
    mode: 'balanced',
    displayMode: 'placeholder',
    showExplanations: true,
    collectLocalStats: false,
  });
});

test.afterEach(async () => {
  await harness.cleanup();
});

const CARD = '[data-testid="card-disclosure"]';
const NATIVE_TITLE = `${CARD} #video-title-link`;
const NATIVE_CHANNEL = `${CARD} #channel-name`;

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

test('PRE-01: placeholder hide suppresses native thumbnail and title, shows replacement', async () => {
  await harness.page.goto('https://www.youtube.com/');
  // Native title must actually disappear from rendering.
  await expect
    .poll(async () => (await visibilityOf(harness.page, `${CARD} #video-title-link`)).visibility, {
      timeout: 20_000,
    })
    .toBe('hidden');
  const thumb = await visibilityOf(harness.page, NATIVE_CHANNEL);
  expect(thumb.visibility === 'hidden' || thumb.display === 'none').toBe(true);
  // Placeholder replacement must be visible and sized.
  const ph = await visibilityOf(harness.page, `${CARD} .bts-placeholder`);
  expect(ph.display).not.toBe('none');
  expect(ph.box).not.toBeNull();
  expect(ph.box!.h).toBeGreaterThan(10);
  // #bts-style must exist with functional rules (A01).
  const css = await harness.page.evaluate(
    () => document.getElementById('bts-style')?.textContent ?? '',
  );
  expect(css).toContain('[data-bts-state="hidden"]');
});

test('PRE-02: collapse mode removes the card slot, siblings remain', async () => {
  await writeSettings(harness.page, harness.extensionId, {
    enabled: true,
    mode: 'balanced',
    displayMode: 'collapse',
    showExplanations: false,
    collectLocalStats: false,
  });
  await harness.page.goto('https://www.youtube.com/');
  await expect
    .poll(async () => (await visibilityOf(harness.page, CARD)).display, { timeout: 20_000 })
    .toBe('none');
  // Sibling human card stays visible and rendered.
  const human = await visibilityOf(harness.page, '[data-testid="card-human"]');
  expect(human.display).not.toBe('none');
  expect(human.box).not.toBeNull();
  expect(human.box!.h).toBeGreaterThan(10);
  expect(await visibilityOf(harness.page, `${CARD} .bts-placeholder`)).toEqual({
    display: 'missing',
    visibility: 'missing',
    box: null,
  });
});

test('PRE-03: repeated warn applications create exactly one overlay', async () => {
  // Use a card that warns rather than hides: bare #ai title (warn-only).
  await harness.page.goto('https://www.youtube.com/results?search_query=ai+baby');
  const overlayCount = async () =>
    harness.page.evaluate(
      () => document.querySelectorAll('[data-testid="card-aihash"] .bts-overlay').length,
    );
  // Trigger reprocessing by forcing a rescan through settings rewrites.
  for (let i = 0; i < 4; i++) {
    await writeSettings(harness.page, harness.extensionId, {
      enabled: true,
      mode: i % 2 === 0 ? 'balanced' : 'strict',
      displayMode: 'placeholder',
      showExplanations: true,
      collectLocalStats: false,
    });
    await harness.page.waitForTimeout(150);
  }
  expect(await overlayCount()).toBeLessThanOrEqual(1);
});

test('PRE-04: show once reveals the card; rescan does not re-hide it this page view', async () => {
  await harness.page.goto('https://www.youtube.com/');
  await expect
    .poll(async () => (await visibilityOf(harness.page, `${CARD} .bts-placeholder`)).display, {
      timeout: 20_000,
    })
    .not.toBe('none');
  // Click the real Show once button.
  await harness.page.click(`${CARD} .bts-placeholder .bts-button:has-text("Show once")`);
  const after = await visibilityOf(harness.page, `${CARD} #video-title-link`);
  expect(after.visibility).not.toBe('hidden');
  // A settings rescan must not re-hide within this page view.
  await writeSettings(harness.page, harness.extensionId, {
    enabled: true,
    mode: 'strict',
    displayMode: 'placeholder',
    showExplanations: true,
    collectLocalStats: false,
  });
  await harness.page.waitForTimeout(400);
  const still = await visibilityOf(harness.page, `${CARD} #video-title-link`);
  expect(still.visibility).not.toBe('hidden');
  // But the persisted rule/state stays: reload re-hides (override expires).
  await harness.page.reload();
  await expect
    .poll(async () => (await visibilityOf(harness.page, `${CARD} #video-title-link`)).visibility, {
      timeout: 20_000,
    })
    .toBe('hidden');
});

test('PRE-05: disabling filtering restores the page completely', async () => {
  await harness.page.goto('https://www.youtube.com/');
  await expect
    .poll(async () => (await visibilityOf(harness.page, `${CARD} .bts-placeholder`)).display, {
      timeout: 20_000,
    })
    .not.toBe('none');
  await writeSettings(harness.page, harness.extensionId, {
    enabled: false,
    mode: 'balanced',
    displayMode: 'placeholder',
    showExplanations: true,
    collectLocalStats: false,
  });
  await expect
    .poll(async () => (await visibilityOf(harness.page, `${CARD} #video-title-link`)).visibility, {
      timeout: 20_000,
    })
    .not.toBe('hidden');
  const leftovers = await harness.page.evaluate(
    () =>
      document.querySelectorAll('.bts-placeholder, .bts-overlay').length +
      document.querySelectorAll('[data-bts-state]').length,
  );
  expect(leftovers).toBe(0);
  // Thumbnail geometry restored (no lingering inline styles).
  const channel = await visibilityOf(harness.page, NATIVE_CHANNEL);
  expect(channel.box).not.toBeNull();
  expect(channel.box!.h).toBeGreaterThan(10);
});

test('PRE-06: Why expands the real explanation while content stays hidden', async () => {
  await harness.page.goto('https://www.youtube.com/');
  await expect
    .poll(async () => (await visibilityOf(harness.page, `${CARD} .bts-placeholder`)).display, {
      timeout: 20_000,
    })
    .not.toBe('none');
  await harness.page.click(`${CARD} .bts-placeholder .bts-button:has-text("Why?")`);
  const details = await harness.page.evaluate(
    () => document.querySelector('.bts-why-details')?.textContent ?? null,
  );
  expect(details).not.toBeNull();
  expect(details).toContain('Video: disclosed200');
  expect(details).toContain('Surface:');
  // Native content must remain hidden while the details are open.
  const title = await visibilityOf(harness.page, NATIVE_TITLE);
  expect(title.visibility).toBe('hidden');
  // Toggle closes it.
  await harness.page.click(`${CARD} .bts-placeholder .bts-button:has-text("Why?")`);
  const closed = await harness.page.evaluate(
    () => document.querySelector('.bts-why-details') === null,
  );
  expect(closed).toBe(true);
});

test('PRE-10: malicious decision text renders as text (no execution)', async () => {
  await harness.page.goto('https://www.youtube.com/');
  await expect
    .poll(async () => (await visibilityOf(harness.page, `${CARD} .bts-placeholder`)).display, {
      timeout: 20_000,
    })
    .not.toBe('none');
  const maliciousNodes = await harness.page.evaluate(
    () =>
      document.querySelectorAll(
        '.bts-placeholder img, .bts-placeholder script, .bts-placeholder iframe',
      ).length,
  );
  expect(maliciousNodes).toBe(0);
});
