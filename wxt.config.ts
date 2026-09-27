import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'wxt';

// See https://wxt.dev/api/config.html
// Release blocker A: the manifest description must stay within Chrome's
// documented 132-character maximum (developer.chrome.com/docs/extensions/
// reference/manifest — verified 2026-09-27). scripts/validate-manifest.mjs
// enforces this against the GENERATED manifest on every release verify.
const MANIFEST_DESCRIPTION =
  'Filter AI-generated and repetitive YouTube videos locally. Every auto-hide is explainable, recoverable, and yours to undo.';

export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  vite: () => ({
    plugins: [tailwindcss()],
  }),
  srcDir: 'src',
  alias: {
    '@': new URL('./src', import.meta.url).pathname,
  },
  hooks: {
    // Release blocker A: browser_specific_settings.gecko is a Firefox-only
    // field. WXT copies userManifest fields verbatim into every target, so
    // strip it from non-Firefox builds right before the manifest is written
    // (Chrome ignores it today, but shipping it is noise and Firefox-only
    // metadata must never describe the Chrome artifact).
    'build:manifestGenerated': (wxt, manifest) => {
      if (wxt.config.browser !== 'firefox') {
        delete (manifest as { browser_specific_settings?: unknown }).browser_specific_settings;
      }
    },
  },
  manifest: {
    name: 'BlockTheSlop — AI Slop Blocker for YouTube',
    description: MANIFEST_DESCRIPTION,
    version: '1.0.0',
    // Firefox (N05): a stable add-on id is required for permanent sideload
    // installs in a profile; without it the build cannot be verified in a
    // real Firefox runtime.
    browser_specific_settings: {
      gecko: { id: 'blocktheslop@local', strict_min_version: '115.0' },
    },
    // v1 filters only; no scripting injection, no host access beyond YouTube,
    // no alarms (no scheduled remote refresh in v1), no unlimitedStorage.
    permissions: ['storage', 'contextMenus'],
    host_permissions: ['*://*.youtube.com/*'],
    web_accessible_resources: [
      {
        resources: ['icon/*.png'],
        matches: ['*://*.youtube.com/*'],
      },
    ],
  },
  // Keep the zip deterministic and small; exclude map files from store package.
  zip: {
    excludeSources: ['**/*.map'],
  },
});
