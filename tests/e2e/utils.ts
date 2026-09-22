import { chromium, type BrowserContext, type Page } from '@playwright/test';
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

export const EXTENSION_PATH = join(here, '..', '..', '.output', 'chrome-mv3');
const FIXTURES_DIR = join(here, 'fixtures', 'www.youtube.com');

export interface Harness {
  context: BrowserContext;
  page: Page;
  extensionId: string;
  profileDir: string;
  cleanup(): Promise<void>;
}

/**
 * Map a YouTube URL on the fixture origin to local fixture HTML.
 * URL parsing guarantees `/`-separated pathnames, so this is platform-safe.
 */
function fixtureFileFor(url: URL): string {
  switch (url.pathname) {
    case '/':
    case '/index.html':
      return join(FIXTURES_DIR, 'home.html');
    case '/results':
      return join(FIXTURES_DIR, 'results.html');
    case '/watch':
      return join(FIXTURES_DIR, 'watch.html');
    case '/feed/subscriptions':
      return join(FIXTURES_DIR, 'subscriptions.html');
    case '/feed/history':
      return join(FIXTURES_DIR, 'history.html');
    case '/playlist':
      return join(FIXTURES_DIR, 'playlist.html');
    case '/shorts':
    case '/shorts/fixtureid01':
      return join(FIXTURES_DIR, 'shorts.html');
    default: {
      const name = url.pathname.replace(/^\//, '').split('/').join('_');
      return join(FIXTURES_DIR, `${name === '' ? 'home' : name}.html`);
    }
  }
}

/** Launch Chromium with the unpacked built extension and fixture routing. */
export async function launchHarness(): Promise<Harness> {
  if (!existsSync(EXTENSION_PATH)) {
    throw new Error(`Extension build not found at ${EXTENSION_PATH}. Run \`npm run build\` first.`);
  }
  const profileDir = mkdtempSync(join(tmpdir(), 'bts-e2e-'));
  const context = await chromium.launchPersistentContext(profileDir, {
    headless: false, // extensions require headed mode in Chromium
    args: [`--disable-extensions-except=${EXTENSION_PATH}`, `--load-extension=${EXTENSION_PATH}`],
  });

  // Intercept fixture origins and serve local HTML — no network access.
  await context.route('https://www.youtube.com/**', (route) => {
    const url = new URL(route.request().url());
    try {
      const html = readFileSync(fixtureFileFor(url), 'utf8');
      void route.fulfill({ body: html, contentType: 'text/html; charset=utf-8' });
    } catch {
      void route.fulfill({ status: 404, body: 'fixture not found', contentType: 'text/plain' });
    }
  });

  // Find this extension's service worker to derive its ID.
  let extensionId = '';
  for (let i = 0; i < 40; i++) {
    const workers = context.serviceWorkers();
    const mine = workers.find((w) => w.url().includes('background.js'));
    if (mine) {
      extensionId = new URL(mine.url()).host;
      break;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  if (extensionId === '') throw new Error('Extension service worker never appeared');

  const [page] = context.pages();

  return {
    context,
    page,
    extensionId,
    profileDir,
    async cleanup() {
      await context.close();
      try {
        rmSync(profileDir, { recursive: true, force: true });
      } catch {
        // Windows file locks can delay deletion; the OS temp cleaner handles it.
      }
    },
  };
}

/** Wait until the card carries the expected extension state attribute. */
export async function waitForCardState(
  page: Page,
  testId: string,
  state: 'hidden' | 'warn' | null,
  timeout = 15_000,
): Promise<void> {
  const selector = `[data-testid="${testId}"]`;
  await page.waitForFunction(
    ({ selector, state }: { selector: string; state: string | null }) => {
      const el = document.querySelector(selector);
      if (el === null) return false;
      return el.getAttribute('data-bts-state') === state;
    },
    { selector, state },
    { timeout },
  );
}

/** Read the extension's stored settings through an extension page context. */
export async function readSettings(
  page: Page,
  extensionId: string,
): Promise<Record<string, unknown>> {
  const ext = await page.context().newPage();
  await ext.goto(`chrome-extension://${extensionId}/popup.html`);
  const settings = await ext.evaluate(async () => {
    const result = await browser.storage.local.get('local:settings');
    return result['local:settings'] as Record<string, unknown>;
  });
  await ext.close();
  return settings;
}

/** Write settings directly into extension storage (from an extension page). */
export async function writeSettings(
  page: Page,
  extensionId: string,
  settings: Record<string, unknown>,
): Promise<void> {
  const ext = await page.context().newPage();
  await ext.goto(`chrome-extension://${extensionId}/popup.html`);
  await ext.evaluate((value) => browser.storage.local.set({ 'local:settings': value }), settings);
  await ext.close();
}

/** Write user rules directly into extension storage (from an extension page). */
export async function writeRules(
  page: Page,
  extensionId: string,
  rules: Record<string, unknown>,
): Promise<void> {
  const ext = await page.context().newPage();
  await ext.goto(`chrome-extension://${extensionId}/popup.html`);
  await ext.evaluate((value) => browser.storage.local.set({ 'local:rules': value }), rules);
  await ext.close();
}
