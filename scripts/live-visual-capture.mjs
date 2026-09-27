/**
 * RC2 issue 5 — targeted live VISUAL capture (manual evidence tool).
 *
 * The earlier live-smoke screenshots did not include the recovery UI. This
 * captures, on real YouTube (logged out, throwaway profile):
 *   1. search results with the corner counter,
 *   2. the session-recovery PANEL open (Restore buttons visible),
 *   3. the page after a restore (card rendered again),
 *   4. an admission-refusal notice if one can be triggered (capacity wedge
 *      is hard to reach live — recorded as not-observed otherwise).
 * Screenshots land in .agents/block-the-slop-v7/live-smoke/ for inspection.
 */
import { chromium } from 'playwright';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(root, '.agents', 'block-the-slop-v7', 'live-smoke');
const EXTENSION = join(root, '.output', 'chrome-mv3');
if (!existsSync(EXTENSION)) {
  console.error('Build first: npm run build');
  process.exit(1);
}
mkdirSync(OUT, { recursive: true });

const shots = [];
const profile = mkdtempSync(join(tmpdir(), 'bts-live-vis-'));
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

const [page] = browser.pages();
try {
  await page.goto('https://www.youtube.com/results?search_query=ai+generated+video', {
    waitUntil: 'domcontentloaded',
    timeout: 45_000,
  });
  await page.waitForTimeout(9_000);
  await page.screenshot({ path: join(OUT, 'v1-search-counter.png') });
  shots.push('v1-search-counter.png');

  // Open the session-recovery panel via the corner notice.
  const notice = page.locator('.bts-activity-notice').first();
  if ((await notice.count()) > 0) {
    await notice.click();
    await page.waitForTimeout(1_200);
    const panelOpen = (await page.locator('.bts-activity-panel').count()) > 0;
    await page.screenshot({ path: join(OUT, 'v2-recovery-panel.png') });
    shots.push('v2-recovery-panel.png');
    if (panelOpen) {
      const restoreBtn = page.locator('.bts-activity-item .bts-button:has-text("Restore")').first();
      if ((await restoreBtn.count()) > 0) {
        await restoreBtn.click();
        await page.waitForTimeout(2_500);
        await page.screenshot({ path: join(OUT, 'v3-after-restore.png') });
        shots.push('v3-after-restore.png');
      }
    }
  }
  const counts = await page.evaluate(() => ({
    hidden: document.querySelectorAll('[data-bts-collapse]').length,
    notice: document.querySelector('.bts-activity-notice')?.textContent ?? '',
    refusalChips: document.querySelectorAll('.bts-persist-error').length,
  }));
  writeFileSync(
    join(OUT, 'live-visual-capture.json'),
    JSON.stringify({ generatedAt: new Date().toISOString(), extensionId, shots, counts }, null, 2),
  );
  console.log('captured:', shots.join(', '), JSON.stringify(counts));
} catch (error) {
  console.error('capture error:', error);
  process.exitCode = 1;
} finally {
  await browser.close().catch(() => {});
  rmSync(profile, { recursive: true, force: true });
}
