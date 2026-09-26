import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'wxt';

// See https://wxt.dev/api/config.html
export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  vite: () => ({
    plugins: [tailwindcss()],
  }),
  srcDir: 'src',
  alias: {
    '@': new URL('./src', import.meta.url).pathname,
  },
  manifest: {
    name: 'BlockTheSlop — AI Slop Blocker for YouTube',
    description:
      'Privacy-first, local-first filtering of AI-generated, automated, repetitive, and low-quality YouTube content. No account, no telemetry, no cloud.',
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
