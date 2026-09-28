import { chromium } from '@playwright/test';
import { existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const extPath = join(root, '.output', 'chrome-mv3');

const outDirs = [
  join(root, '.agents', 'block-the-slop-v7', 'screenshots', 'phase-a'),
  'C:\\Users\\USER-PC\\.gemini\\antigravity-ide\\brain\\5a73b99a-66f7-4f7a-8a64-a425500aa738\\screenshots',
];

for (const d of outDirs) {
  mkdirSync(d, { recursive: true });
}

async function main() {
  const context = await chromium.launchPersistentContext('', {
    headless: false,
    args: [`--disable-extensions-except=${extPath}`, `--load-extension=${extPath}`],
  });

  let extensionId = '';
  for (const page of context.pages()) {
    const url = page.url();
    const m = url.match(/chrome-extension:\/\/([a-p]{32})\//);
    if (m) {
      extensionId = m[1];
      break;
    }
  }

  if (!extensionId) {
    // Wait for service worker
    const background = context.serviceWorkers()[0] || (await context.waitForEvent('serviceworker'));
    extensionId = new URL(background.url()).host;
  }

  console.log('Extension ID:', extensionId);

  const page = await context.newPage();

  // Test light theme
  await page.goto(`chrome-extension://${extensionId}/popup.html`);
  await page.evaluate(() => {
    document.documentElement.setAttribute('data-theme', 'specimen-light');
    document.documentElement.setAttribute('data-bts-theme', 'light');
    document.documentElement.classList.remove('bts-dark');
  });
  await page.waitForTimeout(500);

  const popup = page.locator('.btsl-popup');

  for (const d of outDirs) {
    await popup.screenshot({ path: join(d, 'popup-specimen-light.png') });
  }
  console.log('Saved popup-specimen-light.png');

  // Test dark theme
  await page.evaluate(() => {
    document.documentElement.setAttribute('data-theme', 'specimen-dark');
    document.documentElement.setAttribute('data-bts-theme', 'dark');
    document.documentElement.classList.add('bts-dark');
  });
  await page.waitForTimeout(500);

  for (const d of outDirs) {
    await popup.screenshot({ path: join(d, 'popup-specimen-dark.png') });
  }
  console.log('Saved popup-specimen-dark.png');

  // Test keyboard focus ring
  await page.keyboard.press('Tab');
  await page.waitForTimeout(200);
  for (const d of outDirs) {
    await popup.screenshot({ path: join(d, 'popup-focus-ring.png') });
  }
  console.log('Saved popup-focus-ring.png');

  // Verify focus ring computed style
  const focusOutline = await page.evaluate(() => {
    const el = document.activeElement;
    if (!el) return null;
    const cs = window.getComputedStyle(el);
    return {
      outlineWidth: cs.outlineWidth,
      outlineStyle: cs.outlineStyle,
      outlineColor: cs.outlineColor,
      outlineOffset: cs.outlineOffset,
    };
  });
  console.log('Active element focus outline:', focusOutline);

  // Options page captures for dropdown verification
  const optionsPage = await context.newPage();
  await optionsPage.goto(`chrome-extension://${extensionId}/options.html`);

  // Options light
  await optionsPage.evaluate(() => {
    document.documentElement.setAttribute('data-theme', 'specimen-light');
    document.documentElement.setAttribute('data-bts-theme', 'light');
    document.documentElement.classList.remove('bts-dark');
  });
  await optionsPage.waitForTimeout(500);
  // Sidebar navigation segmented capture (light)
  const navLight = optionsPage.locator('nav.btsl-nav');
  if ((await navLight.count()) > 0) {
    for (const d of outDirs) {
      await navLight.screenshot({ path: join(d, 'options-nav-segmented-light.png') });
    }
    console.log('Saved options-nav-segmented-light.png');
  }

  const appearanceSecLight = optionsPage.locator('section:has-text("Appearance")');
  if ((await appearanceSecLight.count()) > 0) {
    for (const d of outDirs) {
      await appearanceSecLight.screenshot({ path: join(d, 'options-dropdown-light.png') });
    }
    console.log('Saved options-dropdown-light.png');
  }

  // Options dark
  await optionsPage.evaluate(() => {
    document.documentElement.setAttribute('data-theme', 'specimen-dark');
    document.documentElement.setAttribute('data-bts-theme', 'dark');
    document.documentElement.classList.add('bts-dark');
  });
  await optionsPage.waitForTimeout(500);

  // Sidebar navigation segmented capture (dark)
  const navDark = optionsPage.locator('nav.btsl-nav');
  if ((await navDark.count()) > 0) {
    for (const d of outDirs) {
      await navDark.screenshot({ path: join(d, 'options-nav-segmented-dark.png') });
    }
    console.log('Saved options-nav-segmented-dark.png');
  }
  const appearanceSecDark = optionsPage.locator('section:has-text("Appearance")');
  if ((await appearanceSecDark.count()) > 0) {
    for (const d of outDirs) {
      await appearanceSecDark.screenshot({ path: join(d, 'options-dropdown-dark.png') });
    }
    console.log('Saved options-dropdown-dark.png');
  }

  // Categories tab capture
  const categoriesTabBtn = optionsPage.locator('button:has-text("Categories")');
  if ((await categoriesTabBtn.count()) > 0) {
    await categoriesTabBtn.click();
    await optionsPage.waitForTimeout(300);

    // Categories dark
    const catSecDark = optionsPage.locator('section:has-text("Per-category actions")');
    if ((await catSecDark.count()) > 0) {
      for (const d of outDirs) {
        await catSecDark.screenshot({ path: join(d, 'options-categories-dark.png') });
      }
      console.log('Saved options-categories-dark.png');
    }

    // Categories light
    await optionsPage.evaluate(() => {
      document.documentElement.setAttribute('data-theme', 'specimen-light');
      document.documentElement.setAttribute('data-bts-theme', 'light');
      document.documentElement.classList.remove('bts-dark');
    });
    await optionsPage.waitForTimeout(300);
    const catSecLight = optionsPage.locator('section:has-text("Per-category actions")');
    if ((await catSecLight.count()) > 0) {
      for (const d of outDirs) {
        await catSecLight.screenshot({ path: join(d, 'options-categories-light.png') });
      }
      console.log('Saved options-categories-light.png');
    }
  }

  // Review history tab capture
  const reviewTabBtn = optionsPage.locator('button:has-text("Review history")');
  if ((await reviewTabBtn.count()) > 0) {
    await reviewTabBtn.click();
    await optionsPage.waitForTimeout(400);

    // Seed mock review history items
    await optionsPage.evaluate(async () => {
      await chrome.runtime.sendMessage({
        type: 'history:putMany',
        payload: {
          summaries: [
            {
              key: 'v:mock1',
              videoId: 'mock1',
              title: 'KFC Thailand vs. Philippines: Who wins? [AI Generated]',
              channelName: 'Unknown channel',
              surfaces: ['home'],
              resolution: 'pending',
              count: 1,
              firstSeen: Date.now() - 3600000,
              lastSeen: Date.now(),
              latestDecision: {
                action: 'hide',
                reason: 'user-rule',
                ruleId: 'rule-ai',
                explanation: ['Hidden by your rule: titles containing "ai".'],
              },
              evidenceSummary: '',
              revision: 1,
            },
            {
              key: 'v:mock2',
              videoId: 'mock2',
              title: 'AI fruit videos compilation 2026',
              channelName: 'FruitBot Channel',
              channelId: 'UC12345678',
              surfaces: ['search'],
              resolution: 'pending',
              count: 2,
              firstSeen: Date.now() - 7200000,
              lastSeen: Date.now() - 1800000,
              latestDecision: {
                action: 'hide',
                reason: 'category',
                ruleId: 'cat:ai-video',
                explanation: ['Detected synthetic animation cues.'],
              },
              evidenceSummary: '',
              revision: 1,
            },
          ],
        },
      });
    });

    const refreshBtn = optionsPage.locator('button:has-text("Refresh")');
    if ((await refreshBtn.count()) > 0) {
      await refreshBtn.click();
      await optionsPage.waitForTimeout(400);
    }

    // Review history light
    const reviewSecLight = optionsPage.locator('section:has-text("Review history")');
    if ((await reviewSecLight.count()) > 0) {
      for (const d of outDirs) {
        await reviewSecLight.screenshot({ path: join(d, 'options-review-light.png') });
      }
      console.log('Saved options-review-light.png');
    }

    // Review history dark
    await optionsPage.evaluate(() => {
      document.documentElement.setAttribute('data-theme', 'specimen-dark');
      document.documentElement.setAttribute('data-bts-theme', 'dark');
      document.documentElement.classList.add('bts-dark');
    });
    await optionsPage.waitForTimeout(400);
    const reviewSecDark = optionsPage.locator('section:has-text("Review history")');
    if ((await reviewSecDark.count()) > 0) {
      for (const d of outDirs) {
        await reviewSecDark.screenshot({ path: join(d, 'options-review-dark.png') });
      }
      console.log('Saved options-review-dark.png');
    }

    // Capture custom DatePicker popover in dark mode
    const calendarToggleBtn = optionsPage.locator('button[aria-label*="Open calendar"]').first();
    if ((await calendarToggleBtn.count()) > 0) {
      await calendarToggleBtn.click();
      await optionsPage.waitForTimeout(300);
      const popoverDark = optionsPage.locator('.btsl-datepicker__popover');
      if ((await popoverDark.count()) > 0) {
        for (const d of outDirs) {
          await popoverDark.screenshot({ path: join(d, 'options-datepicker-dark.png') });
        }
        console.log('Saved options-datepicker-dark.png');
      }

      // Switch to light mode and capture calendar popover in light mode
      await optionsPage.evaluate(() => {
        document.documentElement.setAttribute('data-theme', 'specimen-light');
        document.documentElement.setAttribute('data-bts-theme', 'light');
        document.documentElement.classList.remove('bts-dark');
      });
      await optionsPage.waitForTimeout(300);
      const popoverLight = optionsPage.locator('.btsl-datepicker__popover');
      if ((await popoverLight.count()) > 0) {
        for (const d of outDirs) {
          await popoverLight.screenshot({ path: join(d, 'options-datepicker-light.png') });
        }
        console.log('Saved options-datepicker-light.png');
      }
    }
  }

  await optionsPage.close();
  await context.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
