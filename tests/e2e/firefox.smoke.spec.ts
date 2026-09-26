import { expect, test } from '@playwright/test';
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { firefox } from '@playwright/test';

/**
 * N05 / QA-12: Firefox support HONESTY.
 *
 * What IS automated here (real artifacts, real browser):
 *  1. The built firefox-mv2 output is packed to a valid .xpi and its structure
 *     verified (MV2 lifecycle wiring, gecko id, storage-only permissions).
 *  2. The real Playwright Firefox binary launches a real profile with the
 *     product prefs and renders a page.
 *
 * What is NOT automatable on this toolchain (recorded, not faked):
 *  - Loading the extension INTO Firefox. Playwright's Firefox driver cannot
 *    inject add-ons; profile-directory sideloading was removed in Firefox 74;
 *    Marionette's addon-install requires the remote agent protocol that the
 *    Juggler-patched build does not complete a handshake for; the raw RDP
 *    banner handshake also did not complete. Manual procedure is in
 *    .agents/block-the-slop-v3/tasks.md (N05). Firefox runtime support is
 *    therefore marked UNVERIFIED, not claimed.
 */

const here = dirname(fileURLToPath(import.meta.url));
const EXTENSION_PATH = join(here, '..', '..', '.output', 'firefox-mv2');
const GECKO_ID = 'blocktheslop@local';

test.skip(!existsSync(EXTENSION_PATH), 'firefox-mv2 build missing; run npm run build:firefox');

// Firefox cold launch competes with parallel Chromium workers.
test.setTimeout(180_000);

const PY_PACK = `
import os, sys, zipfile
src, out = sys.argv[1], sys.argv[2]
with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as z:
    for root, dirs, files in os.walk(src):
        for f in sorted(files):
            full = os.path.join(root, f)
            rel = os.path.relpath(full, src).replace(os.sep, '/')
            z.write(full, rel)
`;

test('N05/QA-12 Firefox: valid installable XPI artifact + real Firefox runtime launch', () => {
  // ---- artifact invariants of the REAL built output ----
  const manifest = JSON.parse(readFileSync(join(EXTENSION_PATH, 'manifest.json'), 'utf8')) as {
    manifest_version: number;
    background?: { scripts?: string[] };
    permissions: string[];
    browser_specific_settings?: { gecko?: { id?: string; strict_min_version?: string } };
    content_scripts?: { js?: string[]; matches?: string[] }[];
  };
  expect(manifest.manifest_version).toBe(2);
  expect(manifest.browser_specific_settings?.gecko?.id).toBe(GECKO_ID);
  expect(manifest.background?.scripts).toContain('background.js');
  expect(manifest.permissions).toEqual(expect.arrayContaining(['storage']));
  expect(manifest.permissions.some((p) => p.includes('youtube.com'))).toBe(true);
  expect(manifest.content_scripts?.[0]?.matches?.[0]).toContain('youtube.com');

  const background = readFileSync(join(EXTENSION_PATH, 'background.js'), 'utf8');
  expect(background).toContain('recordHidden');
  expect(background).toContain('external sender rejected');
  expect(background).toContain('history:record');
  const contentScript = readFileSync(join(EXTENSION_PATH, 'content-scripts', 'youtube.js'), 'utf8');
  expect(contentScript).toContain('.bts-placeholder');

  // ---- pack to XPI and verify zip integrity (what about:debugging loads) ----
  const outDir = mkdtempSync(join(tmpdir(), 'bts-xpi-'));
  const xpi = join(outDir, `${GECKO_ID}.xpi`);
  execFileSync('python', ['-c', PY_PACK, EXTENSION_PATH, xpi], { stdio: 'pipe' });
  const listing = execFileSync(
    'python',
    [
      '-c',
      [
        'import sys, zipfile',
        `z = zipfile.ZipFile(sys.argv[1])`,
        'bad = z.testzip()',
        "assert bad is None, f'corrupt entry {bad}'",
        'names = z.namelist()',
        "assert 'manifest.json' in names, names",
        'print(len(names))',
      ].join('\n'),
      xpi,
    ],
    { encoding: 'utf8' },
  );
  expect(Number(listing.trim())).toBeGreaterThan(5);
});

test('N05/QA-12 Firefox: real browser binary launches and serves pages', async () => {
  const profile = mkdtempSync(join(tmpdir(), 'bts-ff-'));
  const context = await firefox.launchPersistentContext(profile, { headless: true });
  const page = await context.newPage();
  await page.setContent('<h1>firefox runtime ok</h1>');
  await expect(page.getByText('firefox runtime ok')).toBeVisible();
  await context.close();

  test.info().annotations.push({
    type: 'n05-limitation',
    description:
      'Playwright Firefox cannot load extensions (driver limitation; profile sideload removed in FF74; Marionette/RDP handshake not completed against the Juggler build). Firefox RUNTIME extension behavior is UNVERIFIED — manual procedure: npm run build:firefox, pack .output/firefox-mv2 to a zip named blocktheslop@local.xpi, about:debugging#/runtime/this-firefox → Load Temporary Add-on, open options.html, filter a youtube.com fixture page.',
  });
});
