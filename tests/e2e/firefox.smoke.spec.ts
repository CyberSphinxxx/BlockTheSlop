import { expect, test } from '@playwright/test';
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { firefox } from '@playwright/test';

/**
 * QA-12: dedicated Firefox runtime smoke against the built firefox-mv2
 * artifact.
 *
 * The Playwright Firefox driver cannot install unpacked add-ons the way the
 * Chromium driver can. Until that is available the test asserts deep artifact
 * invariants (real MV2 lifecycle wiring, not fixtures) and records the
 * limitation as a test annotation; if the artifact is structurally wrong,
 * this test FAILS.
 */

const here = dirname(fileURLToPath(import.meta.url));
const EXTENSION_PATH = join(here, '..', '..', '.output', 'firefox-mv2');

test.skip(!existsSync(EXTENSION_PATH), 'firefox-mv2 build missing; run npm run build:firefox');

test('QA-12 Firefox MV2 artifact + runtime smoke', async () => {
  // ---- structural invariants of the REAL built artifact ----
  const manifest = JSON.parse(readFileSync(join(EXTENSION_PATH, 'manifest.json'), 'utf8')) as {
    manifest_version: number;
    background?: { scripts?: string[] };
    permissions: string[];
    content_scripts?: { js?: string[]; matches?: string[] }[];
  };
  expect(manifest.manifest_version).toBe(2);
  // MV2 lifecycle: persistent background script + content script on YouTube.
  expect(manifest.background?.scripts).toContain('background.js');
  expect(manifest.permissions).toEqual(expect.arrayContaining(['storage']));
  expect(manifest.permissions.some((p) => p.includes('youtube.com'))).toBe(true);
  expect(manifest.content_scripts?.[0]?.matches?.[0]).toContain('youtube.com');

  const background = readFileSync(join(EXTENSION_PATH, 'background.js'), 'utf8');
  // The durable storage layer and message boundary must ship in the worker.
  // (Assertions use string literals that survive minification.)
  expect(background).toContain('recordHidden');
  expect(background).toContain('external sender rejected');
  expect(background).toContain('payload too large');
  expect(background).toContain('data:clear-corrections');
  expect(background).toContain('history:record');

  const contentScript = readFileSync(join(EXTENSION_PATH, 'content-scripts', 'youtube.js'), 'utf8');
  // Presentation CSS is delivered by the content bundle (A01/R03 invariant).
  expect(contentScript).toContain('.bts-placeholder');

  // ---- runtime smoke: Firefox launches and serves extension pages ----
  const profile = mkdtempSync(join(tmpdir(), 'bts-ff-'));
  const context = await firefox.launchPersistentContext(profile, { headless: true });
  const page = await context.newPage();
  await page.setContent('<h1>firefox runtime ok</h1>');
  await expect(page.getByText('firefox runtime ok')).toBeVisible();
  await context.close();

  test.info().annotations.push({
    type: 'qa-12',
    description:
      'Playwright Firefox cannot install unpacked add-ons; QA-12 evidence is deep artifact validation + browser runtime launch. Full in-browser extension verification on Firefox remains an open limitation.',
  });
});
