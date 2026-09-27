/**
 * Manual live-YouTube smoke tool (NOT part of `npm run verify`).
 *
 * Loads the freshly built extension into a THROWAWAY Chromium profile
 * (mkdtemp — nothing from the owner's browser is touched), visits real
 * YouTube surfaces signed out, exercises recovery/disable/re-enable/reload,
 * and records per-surface observations + screenshots to
 * `.agents/block-the-slop-v7/live-smoke/`.
 *
 * Usage: node scripts/live-smoke.mjs
 * Evidence class: LIVE (never cite fixture evidence as live, or vice versa).
 */
import { chromium } from 'playwright';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(root, '.agents', 'block-the-slop-v7', 'live-smoke');
const EXTENSION = join(root, '.output', 'chrome-mv3');

if (!existsSync(EXTENSION)) {
  console.error('Build the extension first: npm run build');
  process.exit(1);
}
mkdirSync(OUT, { recursive: true });

const observations = [];
const consoleErrors = { page: [], extension: [] };
const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');

function observe(surface, url, notes) {
  observations.push({ surface, url, notes, at: new Date().toISOString() });
  console.log(`[${surface}] ${notes}`);
}

async function pageStats(page) {
  return page.evaluate(() => {
    const hidden = document.querySelectorAll(
      '[data-bts-collapse], [data-bts-state="hidden"]',
    ).length;
    const placeholders = document.querySelectorAll('.bts-placeholder').length;
    const warnMarkers = document.querySelectorAll('.bts-warn-marker').length;
    const chips = document.querySelectorAll('.bts-status').length;
    const notice = document.querySelector('.bts-activity-notice')?.textContent ?? '';
    return { hidden, placeholders, warnMarkers, chips, notice: notice.slice(0, 80) };
  });
}

const profile = mkdtempSync(join(tmpdir(), 'bts-live-smoke-'));
const browser = await chromium.launchPersistentContext(profile, {
  headless: false,
  viewport: { width: 1280, height: 800 },
  args: [`--disable-extensions-except=${EXTENSION}`, `--load-extension=${EXTENSION}`],
});

let extensionId = '';
for (let i = 0; i < 40; i++) {
  const sw = browser.serviceWorkers().find((w) => w.url().includes('background.js'));
  if (sw) {
    extensionId = new URL(sw.url()).host;
    break;
  }
  await new Promise((r) => setTimeout(r, 250));
}
if (!extensionId) {
  console.error('Extension service worker never appeared');
  await browser.close();
  process.exit(1);
}
console.log(`extension id: ${extensionId}`);

const [page] = browser.pages();
const userAgent = await page.evaluate(() => navigator.userAgent).catch(() => 'unknown');
page.on('pageerror', (err) => consoleErrors.page.push(String(err)));
page.on('console', (msg) => {
  if (msg.type() === 'error') consoleErrors.page.push(msg.text());
});
for (const sw of browser.serviceWorkers()) {
  sw.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.extension.push(msg.text());
  });
}

try {
  // ---- 1. Home (signed out) ----
  await page.goto('https://www.youtube.com/', { waitUntil: 'domcontentloaded', timeout: 45_000 });
  await page.waitForTimeout(6_000);
  let stats = await pageStats(page);
  observe(
    'home',
    page.url(),
    `hidden=${stats.hidden} placeholders=${stats.placeholders} warn=${stats.warnMarkers} notice="${stats.notice}"`,
  );
  await page.screenshot({ path: join(OUT, '01-home.png') });

  // Corner notice → Session recovery panel (if anything is hidden).
  const noticeVisible = (await page.locator('.bts-activity-notice').count()) > 0;
  if (noticeVisible) {
    await page.click('.bts-activity-notice');
    await page.waitForTimeout(1_000);
    const panelRows = await page.locator('.bts-activity-item').count();
    observe('home', page.url(), `session-recovery panel rows=${panelRows}`);
    if (panelRows > 0) {
      await page.locator('.bts-activity-item .bts-button:has-text("Restore")').first().click();
      await page.waitForTimeout(2_000);
      stats = await pageStats(page);
      observe('home', page.url(), `after restore: hidden=${stats.hidden}`);
      await page.screenshot({ path: join(OUT, '02-home-after-restore.png') });
    }
    await page.keyboard.press('Escape');
  } else {
    observe('home', page.url(), 'no on-page notice (nothing hidden on this load)');
  }

  // ---- 2. Search: plain + "ai generated video" ----
  await page.goto('https://www.youtube.com/results?search_query=lofi+study+music', {
    waitUntil: 'domcontentloaded',
    timeout: 45_000,
  });
  await page.waitForTimeout(6_000);
  stats = await pageStats(page);
  observe(
    'search',
    page.url(),
    `hidden=${stats.hidden} placeholders=${stats.placeholders} warn=${stats.warnMarkers}`,
  );
  await page.screenshot({ path: join(OUT, '03-search.png') });

  await page.goto('https://www.youtube.com/results?search_query=ai+generated+video', {
    waitUntil: 'domcontentloaded',
    timeout: 45_000,
  });
  await page.waitForTimeout(8_000);
  stats = await pageStats(page);
  observe(
    'search:ai-generated',
    page.url(),
    `hidden=${stats.hidden} placeholders=${stats.placeholders} warn=${stats.warnMarkers}`,
  );
  await page.screenshot({ path: join(OUT, '04-search-ai-generated.png') });

  // Scroll/load-more behavior.
  for (let i = 0; i < 3; i++) {
    await page.mouse.wheel(0, 2_500);
    await page.waitForTimeout(2_000);
  }
  stats = await pageStats(page);
  observe(
    'search:ai-generated',
    page.url(),
    `after scroll: hidden=${stats.hidden} chips=${stats.chips}`,
  );
  await page.screenshot({ path: join(OUT, '05-search-after-scroll.png') });

  // ---- 3. Shorts shelf ----
  await page.goto('https://www.youtube.com/feed/subscriptions', {
    waitUntil: 'domcontentloaded',
    timeout: 45_000,
  });
  await page.waitForTimeout(6_000);
  stats = await pageStats(page);
  observe(
    'subscriptions',
    page.url(),
    `hidden=${stats.hidden} (shorts shelf usually present here)`,
  );
  await page.screenshot({ path: join(OUT, '06-subscriptions.png') });

  // ---- 4. Watch recommendations ----
  const watchUrl = 'https://www.youtube.com/watch?v=jNQXAC9IVRw'; // "Me at the zoo" (stable, signed out)
  await page.goto(watchUrl, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  await page.waitForTimeout(8_000);
  stats = await pageStats(page);
  observe('watch', page.url(), `sidebar hidden=${stats.hidden} placeholders=${stats.placeholders}`);
  await page.screenshot({ path: join(OUT, '07-watch.png') });

  // ---- 5. Manual video block via popup relay + rescan ----
  await page.bringToFront();
  const extPage = await browser.newPage();
  await extPage.goto(`chrome-extension://${extensionId}/popup.html`);
  await extPage.waitForTimeout(1_000);
  const blocked = await extPage.evaluate(() => {
    // The popup exposes quick controls; use the rules store directly through
    // the same storage the popup writes.
    return browser.storage.local.get('local:rules').then((data) => {
      const rules = data['local:rules'] ?? {
        allowedVideoIds: [],
        blockedVideoIds: [],
        allowedChannelIds: [],
        blockedChannelIds: [],
        fallbackAllowedHandles: [],
        fallbackBlockedHandles: [],
        blockedPhrases: [],
        blockedPhraseRules: [],
        channelRulesMeta: {},
      };
      rules.blockedVideoIds.push('dQw4w9WgXcQ');
      return browser.storage.local
        .set({ 'local:rules': rules })
        .then(() => rules.blockedVideoIds.length);
    });
  });
  observe('manual-block', watchUrl, `popup storage rules updated (blocked count=${blocked})`);
  await extPage.close();
  await page.bringToFront();
  await page.goto('https://www.youtube.com/watch?v=dQw4w9WgXcQ', {
    waitUntil: 'domcontentloaded',
    timeout: 45_000,
  });
  await page.waitForTimeout(5_000);
  observe(
    'manual-block',
    page.url(),
    'blocked video page opened — extension does not block watch pages themselves (filtering is for discovery surfaces); verify no errors',
  );

  // ---- 6. Global disable/re-enable (popup storage toggle) ----
  const settingsBefore = await page.evaluate(() => true);
  void settingsBefore;
  const extPage2 = await browser.newPage();
  await extPage2.goto(`chrome-extension://${extensionId}/popup.html`);
  await extPage2.waitForTimeout(1_000);
  await extPage2.evaluate(() =>
    browser.storage.local.get('local:settings').then(async (data) => {
      const key = Object.keys(data)[0] ?? 'local:settings';
      const settings = data[key] ?? {};
      settings.enabled = false;
      await browser.storage.local.set({ [key]: settings });
    }),
  );
  await extPage2.close();
  await page.bringToFront();
  await page.goto('https://www.youtube.com/', { waitUntil: 'domcontentloaded', timeout: 45_000 });
  await page.waitForTimeout(6_000);
  stats = await pageStats(page);
  observe('disabled', page.url(), `filtering OFF: hidden=${stats.hidden} (must be 0)`);
  await page.screenshot({ path: join(OUT, '08-disabled.png') });

  // ---- 7. Extension reload with a YouTube tab open ----
  const [sw] = browser.serviceWorkers();
  if (sw) await sw.evaluate(() => location.reload()).catch(() => {});
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 45_000 });
  await page.waitForTimeout(6_000);
  stats = await pageStats(page);
  observe('reload', page.url(), `after reload (still disabled): hidden=${stats.hidden}`);
  await extPage2.evaluate(() => undefined).catch(() => {});
  const extPage3 = await browser.newPage();
  await extPage3.goto(`chrome-extension://${extensionId}/popup.html`);
  await extPage3.waitForTimeout(1_000);
  await extPage3.evaluate(() =>
    browser.storage.local.get(null).then(async (data) => {
      const key = Object.keys(data).find((k) => k.endsWith('settings')) ?? 'local:settings';
      const settings = data[key] ?? {};
      settings.enabled = true;
      await browser.storage.local.set({ [key]: settings });
    }),
  );
  await extPage3.close();
  await page.waitForTimeout(4_000);
  stats = await pageStats(page);
  observe(
    're-enabled',
    page.url(),
    `filtering back ON: hidden=${stats.hidden} notice="${stats.notice}"`,
  );
  await page.screenshot({ path: join(OUT, '09-re-enabled.png') });
} catch (error) {
  observe('ERROR', '', String(error));
  process.exitCode = 1;
} finally {
  const summary = {
    generatedAt: new Date().toISOString(),
    extensionBuild: { manifest: sha(join(EXTENSION, 'manifest.json')) },
    chromeVersion: userAgent,
    observations,
    consoleErrors,
    evidenceBoundary:
      'LIVE YouTube evidence (logged out, temporary profile). Establishes real-surface behavior and stability, NOT detector accuracy or full surface compatibility.',
  };
  writeFileSync(join(OUT, 'live-smoke-evidence.json'), JSON.stringify(summary, null, 2));
  console.log(`\nevidence: ${join(OUT, 'live-smoke-evidence.json')}`);
  await browser.close().catch(() => {});
  rmSync(profile, { recursive: true, force: true });
}
