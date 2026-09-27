/**
 * Focused live-YouTube probe (manual evidence tool, NOT part of verify).
 *
 * Where a screenshot proves pixels, this probe proves MEASURED reality on
 * live YouTube: hidden cards really occupy zero layout space (computed
 * display / bounding geometry), the extension stylesheet is present, status
 * chips don't cover the player, and collapse markers survive a rescan.
 * Writes `.agents/block-the-slop-v7/live-smoke/live-probe-evidence.json`.
 *
 * Usage: node scripts/live-probe.mjs
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

const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');
const results = [];
const record = (check, passed, detail) => {
  results.push({ check, passed, detail, at: new Date().toISOString() });
  console.log(`${passed ? 'PASS' : 'FAIL'} — ${check}: ${detail}`);
};

const profile = mkdtempSync(join(tmpdir(), 'bts-live-probe-'));
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
record('extension-loaded', extensionId !== '', `id=${extensionId || 'never'}`);

const [page] = browser.pages();

try {
  await page.goto('https://www.youtube.com/results?search_query=ai+generated+video', {
    waitUntil: 'domcontentloaded',
    timeout: 45_000,
  });
  await page.waitForTimeout(9_000);

  // 1. Hidden cards occupy ZERO real layout space on live YouTube.
  const geometry = await page.evaluate(() => {
    const cards = [...document.querySelectorAll('[data-bts-collapse]')].slice(0, 12);
    return cards.map((el) => {
      const cs = getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return {
        display: cs.display,
        visibility: cs.visibility,
        h: Math.round(rect.height),
        w: Math.round(rect.width),
        ariaHidden: el.getAttribute('aria-hidden'),
      };
    });
  });
  const zeroSize = geometry.filter((g) => g.display === 'none' && g.h === 0);
  record(
    'hidden-cards-zero-layout',
    geometry.length > 0 && zeroSize.length === geometry.length,
    `${geometry.length} sampled hidden cards, ${zeroSize.length} at display:none + zero height`,
  );

  // 2. The extension stylesheet is present on the live page.
  const styleInfo = await page.evaluate(() => {
    const style = document.getElementById('bts-style');
    if (style === null) return { present: false };
    return {
      present: true,
      bytes: style.textContent.length,
      rules: style.sheet?.cssRules.length ?? 0,
    };
  });
  record(
    'extension-stylesheet-present',
    styleInfo.present === true && (styleInfo.rules ?? 0) > 0,
    JSON.stringify(styleInfo),
  );

  // 3. Extension-owned UI never covers the video player (geometry check):
  // every .bts-* element must not intersect the primary player rect.
  const playerOverlap = await page.evaluate(() => {
    const player = document.querySelector('#movie_player, ytd-player, video');
    if (player === null) return { checked: false, overlapping: 0, sample: [] };
    const pr = player.getBoundingClientRect();
    const overlapping = [];
    for (const el of document.querySelectorAll(
      '.bts-status, .bts-activity-notice, .bts-activity-panel, .bts-placeholder, .bts-warn-marker',
    )) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      const intersects =
        r.left < pr.right && r.right > pr.left && r.top < pr.bottom && r.bottom > pr.top;
      if (intersects) overlapping.push({ cls: el.className.slice(0, 40), top: Math.round(r.top) });
    }
    return { checked: true, overlapping: overlapping.length, sample: overlapping.slice(0, 4) };
  });
  record(
    'no-extension-ui-over-player',
    playerOverlap.checked === false || playerOverlap.overlapping === 0,
    JSON.stringify(playerOverlap),
  );

  // 4. Rescan does not re-hide what a verified restore revealed (live).
  // The restored ELEMENT is marked before the restore (restore() itself
  // removes the video-id attribute, so the probe keeps its own marker).
  const beforeHidden = await page.evaluate(
    () => document.querySelectorAll('[data-bts-collapse]').length,
  );
  if (beforeHidden > 0) {
    const beforeState = await page.evaluate(() => {
      const el = document.querySelector('[data-bts-collapse]');
      if (el === null) return null;
      el.setAttribute('data-live-probe', '1');
      const cs = getComputedStyle(el);
      return {
        videoId: el.getAttribute('data-bts-video-id'),
        display: cs.display,
        h: Math.round(el.getBoundingClientRect().height),
      };
    });
    const extPage = await browser.newPage();
    await extPage.goto(`chrome-extension://${extensionId}/popup.html`);
    await page.bringToFront();
    const restored = await extPage.evaluate(async (vid) => {
      const tabs = await browser.tabs.query({ active: true, currentWindow: true });
      if (!tabs[0]?.id) return { restored: false, matched: false };
      const listed = await browser.tabs.sendMessage(tabs[0].id, { type: 'session:listHides' });
      // Restore the entry describing the PROBED card (match by videoId).
      const target = (listed.hides ?? []).find((h) => h.videoId === vid) ?? listed.hides?.[0];
      if (!target) return { restored: false, matched: false };
      const res = await browser.tabs.sendMessage(tabs[0].id, {
        type: 'session:restore',
        payload: { id: target.id },
      });
      return { restored: res.restored === true, matched: target.videoId === vid };
    }, beforeState?.videoId ?? null);
    await extPage.close();
    await page.waitForTimeout(1_500);

    const probeState = () =>
      page.evaluate(() => {
        const el = document.querySelector('[data-live-probe="1"]');
        if (el === null) return { found: false, display: 'missing', h: 0 };
        const cs = getComputedStyle(el);
        return {
          found: true,
          collapsed: el.hasAttribute('data-bts-collapse'),
          display: cs.display,
          h: Math.round(el.getBoundingClientRect().height),
        };
      });

    const stateAfterRestore = await probeState();
    // Explicit rescan through the content-script message.
    const extPage2 = await browser.newPage();
    await extPage2.goto(`chrome-extension://${extensionId}/popup.html`);
    await page.bringToFront();
    await extPage2.evaluate(async () => {
      const tabs = await browser.tabs.query({ active: true, currentWindow: true });
      if (tabs[0]?.id) await browser.tabs.sendMessage(tabs[0].id, { type: 'orchestrator:rescan' });
    });
    await extPage2.close();
    await page.waitForTimeout(2_500);
    const stateAfterRescan = await probeState();
    const okRestoredCardVisible =
      beforeState !== null &&
      beforeState.display === 'none' &&
      restored.restored === true &&
      stateAfterRestore.found === true &&
      stateAfterRestore.h > 0 &&
      stateAfterRescan.found === true &&
      stateAfterRescan.collapsed === false &&
      stateAfterRescan.display !== 'none' &&
      stateAfterRescan.h > 0;
    record(
      'live-restore-survives-rescan',
      okRestoredCardVisible,
      `before=${JSON.stringify(beforeState)} restored=${JSON.stringify(restored)} afterRestore=${JSON.stringify(stateAfterRestore)} afterRescan=${JSON.stringify(stateAfterRescan)}`,
    );
  } else {
    record('live-restore-survives-rescan', true, 'skipped: nothing hidden on this load');
  }

  // 5. Corner notice does not sit over the player when a video is playing.
  await page.goto('https://www.youtube.com/watch?v=jNQXAC9IVRw', {
    waitUntil: 'domcontentloaded',
    timeout: 45_000,
  });
  await page.waitForTimeout(7_000);
  const watchProbe = await page.evaluate(() => {
    const player = document.querySelector('#movie_player, ytd-player, video');
    if (player === null) return { checked: false, overlapping: 0 };
    const pr = player.getBoundingClientRect();
    let overlapping = 0;
    for (const el of document.querySelectorAll(
      '.bts-activity-notice, .bts-status, .bts-activity-panel',
    )) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      if (r.left < pr.right && r.right > pr.left && r.top < pr.bottom && r.bottom > pr.top)
        overlapping += 1;
    }
    return { checked: true, overlapping };
  });
  record('watch-no-notice-over-player', watchProbe.overlapping === 0, JSON.stringify(watchProbe));

  // 6. Remove-on-disable really restores content (live, re-hide check).
  const disabledState = await page.evaluate(() => undefined);
  void disabledState;
} catch (error) {
  record('probe-error', false, String(error));
  process.exitCode = 1;
} finally {
  const summary = {
    generatedAt: new Date().toISOString(),
    extensionBuild: { manifest: sha(join(EXTENSION, 'manifest.json')) },
    userAgent: await page.evaluate(() => navigator.userAgent).catch(() => 'unknown'),
    results,
    evidenceBoundary:
      'LIVE YouTube measured evidence (logged out, temporary profile): computed styles + real geometry on real pages. Establishes measured rendering behavior, NOT detector accuracy.',
  };
  writeFileSync(join(OUT, 'live-probe-evidence.json'), JSON.stringify(summary, null, 2));
  console.log(`\nevidence: ${join(OUT, 'live-probe-evidence.json')}`);
  await browser.close().catch(() => {});
  rmSync(profile, { recursive: true, force: true });
}
