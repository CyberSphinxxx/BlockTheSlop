import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';

/**
 * SET-02 — the shipped artifact itself must carry functional presentation CSS.
 *
 * Regression for audit defect A01: the v1 runtime `ensureStyles()` created an
 * empty <style id="bts-style">, and the content-script bundle contained no
 * [data-bts-state=…] rules, so "hidden" cards could remain visible. This test
 * reads the actually built artifact (not source) and fails if the CSS rules
 * that implement hide/warn/placeholder are missing.
 */
const here = dirname(fileURLToPath(import.meta.url));
const contentScriptPath = join(
  here,
  '..',
  '..',
  '.output',
  'chrome-mv3',
  'content-scripts',
  'youtube.js',
);

test.describe('built-extension artifact integrity', () => {
  test('content script bundle contains the functional presentation CSS rules', () => {
    const bundle = readFileSync(contentScriptPath, 'utf8');
    // The rules that actually hide/suppress native content:
    expect(bundle, 'hide rule (display:none) must be in the shipped bundle').toContain(
      '[data-bts-state="hidden"]',
    );
    expect(
      bundle,
      'child-suppression rule (placeholder mode hides native children) must be shipped',
    ).toContain('[data-bts-state="hidden"] > :not(.bts-placeholder)');
    expect(bundle, 'collapse rule must be shipped').toContain('data-bts-collapse');
    // The runtime style element must be populated with real CSS, not ''.
    expect(bundle).not.toMatch(/style\.textContent\s*=\s*['"`]{2}['"`];?/);
  });

  test('manifest is least-privilege with no remote code', () => {
    const manifest = JSON.parse(
      readFileSync(join(here, '..', '..', '.output', 'chrome-mv3', 'manifest.json'), 'utf8'),
    ) as {
      permissions?: string[];
      host_permissions?: string[];
      content_scripts?: { js?: string[]; css?: string[]; matches?: string[] }[];
      content_security_policy?: Record<string, string>;
    };
    expect(manifest.permissions ?? []).toEqual(['storage']);
    expect(manifest.host_permissions ?? []).toEqual(['*://*.youtube.com/*']);
    // MV3: no remote hosted code.
    const csp = manifest.content_security_policy ?? {};
    const scriptSrc = csp.extension_pages ?? '';
    expect(scriptSrc).not.toContain('http:');
    expect(scriptSrc).not.toContain('https:');
    for (const cs of manifest.content_scripts ?? []) {
      for (const js of cs.js ?? []) expect(js).not.toMatch(/^https?:/);
    }
  });
});
