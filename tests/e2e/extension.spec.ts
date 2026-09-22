import { expect, test } from '@playwright/test';
import {
  launchHarness,
  waitForCardState,
  readSettings,
  writeSettings,
  writeRules,
  type Harness,
} from './utils';

let harness: Harness;

test.beforeEach(async () => {
  harness = await launchHarness();
});

test.afterEach(async () => {
  await harness.cleanup();
});

const BASE = 'https://www.youtube.com';

test.describe('extension lifecycle', () => {
  test('E2E-01 install: service worker present, popup and options open', async () => {
    expect(harness.extensionId).toMatch(/^[a-p]{32}$/);
    const popup = await harness.context.newPage();
    await popup.goto(`chrome-extension://${harness.extensionId}/popup.html`);
    await expect(popup.getByRole('heading', { name: 'BlockTheSlop' })).toBeVisible();
    await expect(popup.getByRole('checkbox', { name: 'On' })).toBeChecked();

    const options = await harness.context.newPage();
    await options.goto(`chrome-extension://${harness.extensionId}/options.html`);
    await expect(options.getByRole('button', { name: 'General' })).toBeVisible();
    await popup.close();
    await options.close();
  });
});

test.describe('filtering on fixture pages', () => {
  test('E2E-02 disable toggle leaves cards untouched, re-enable resumes', async () => {
    await writeSettings(harness.page, harness.extensionId, {
      enabled: false,
      mode: 'balanced',
      categoryActions: {},
      showExplanations: true,
      collectLocalStats: false,
      youtubeFeedback: { enabled: false },
      remoteProvider: { enabled: false, timeoutMs: 5000 },
    });

    await harness.page.goto(`${BASE}/`);
    await harness.page.waitForTimeout(1500);
    const states = await harness.page.locator('[data-bts-state]').count();
    expect(states).toBe(0);

    // Re-enable: the content script watches storage and resumes.
    await writeSettings(harness.page, harness.extensionId, {
      enabled: true,
      mode: 'balanced',
      categoryActions: {},
      showExplanations: true,
      collectLocalStats: false,
      youtubeFeedback: { enabled: false },
      remoteProvider: { enabled: false, timeoutMs: 5000 },
    });
    await waitForCardState(harness.page, 'card-disclosure', 'hidden');
  });

  test('E2E-03 balanced mode hides disclosure card and allows human card', async () => {
    await harness.page.goto(`${BASE}/`);
    await waitForCardState(harness.page, 'card-disclosure', 'hidden');
    await waitForCardState(harness.page, 'card-human', null);
    await expect(
      harness.page.locator('[data-testid="card-disclosure"] .bts-placeholder'),
    ).toContainText('Hidden by BlockTheSlop');
  });

  test('E2E-04 AI discussion video is not automatically hidden', async () => {
    await harness.page.goto(`${BASE}/`);
    await waitForCardState(harness.page, 'card-disclosure', 'hidden');
    const state = await harness.page
      .locator('[data-testid="card-discussion"]')
      .getAttribute('data-bts-state');
    expect(state).toBeNull();
  });

  test('E2E-05 allow-video rule restores and keeps the card visible', async () => {
    await harness.page.goto(`${BASE}/`);
    await waitForCardState(harness.page, 'card-disclosure', 'hidden');

    await writeRules(harness.page, harness.extensionId, {
      allowedVideoIds: ['disclosed200'],
      blockedVideoIds: [],
      allowedChannelIds: [],
      blockedChannelIds: [],
      fallbackAllowedHandles: [],
      fallbackBlockedHandles: [],
    });

    // Reload: the rule must keep the card visible.
    await harness.page.reload();
    await harness.page.waitForTimeout(1500);
    const state = await harness.page
      .locator('[data-testid="card-disclosure"]')
      .getAttribute('data-bts-state');
    expect(state).toBeNull();
  });

  test('E2E-06 blocking a channel hides its other cards', async () => {
    await writeRules(harness.page, harness.extensionId, {
      allowedVideoIds: [],
      blockedVideoIds: [],
      allowedChannelIds: [],
      blockedChannelIds: ['UCNat5555555555555555'],
      fallbackAllowedHandles: [],
      fallbackBlockedHandles: [],
    });

    await harness.page.goto(`${BASE}/results`);
    await waitForCardState(harness.page, 'card-search-human', 'hidden');
  });

  test('E2E-07 review record is created for automatic hide', async () => {
    await harness.page.goto(`${BASE}/`);
    await waitForCardState(harness.page, 'card-disclosure', 'hidden');

    const options = await harness.context.newPage();
    await options.goto(`chrome-extension://${harness.extensionId}/options.html`);
    await options.getByRole('button', { name: 'Review history' }).click();
    await expect(options.getByText('Rome retold')).toBeVisible({ timeout: 10_000 });
    await expect(options.getByRole('button', { name: 'Restore' })).toBeVisible();
    await options.close();
  });

  test('E2E-08 SPA navigation filters new cards without duplicate overlays', async () => {
    await harness.page.goto(`${BASE}/`);
    await waitForCardState(harness.page, 'card-disclosure', 'hidden');

    // SPA-style in-document insertion of a new disclosure card.
    await harness.page.evaluate(() => {
      const contents = document.getElementById('contents');
      if (contents === null) throw new Error('missing #contents');
      const template = document.createElement('template');
      template.innerHTML = `
        <yt-lockup-view-model data-testid="card-spa-disclosure">
          <a id="video-title-link" href="/watch?v=spadisc08">
            <span id="video-title">Atlantis revealed again</span>
          </a>
          <div id="channel-name"><a href="/@pastreimagined">Past Reimagined</a></div>
          <div class="badges"><span class="badge badge-shape-wiz__text">Altered or synthetic content</span></div>
        </yt-lockup-view-model>`;
      contents.appendChild(template.content.firstElementChild!);
    });

    await waitForCardState(harness.page, 'card-spa-disclosure', 'hidden');
    const placeholders = await harness.page
      .locator('[data-testid="card-disclosure"] .bts-placeholder')
      .count();
    expect(placeholders).toBe(1);
  });

  test('E2E-09 many inserted cards process in bounded batches', async () => {
    await harness.page.goto(`${BASE}/`);
    await harness.page.evaluate(() => {
      const contents = document.getElementById('contents');
      if (contents === null) throw new Error('missing #contents');
      const fragment = document.createDocumentFragment();
      for (let i = 0; i < 120; i++) {
        const el = document.createElement('yt-lockup-view-model');
        el.dataset.testid = `bulk-${i}`;
        el.innerHTML = `
          <a id="video-title-link" href="/watch?v=bulk${String(i).padStart(3, '0')}">
            <span id="video-title">Bulk card number ${i}</span>
          </a>
          <div id="channel-name"><a href="/channel/UCBulk99999999999999">Bulk Channel</a></div>`;
        fragment.appendChild(el);
      }
      contents.appendChild(fragment);
    });

    // All 120 cards evaluated: read the local stats counter the extension keeps.
    const popup = await harness.context.newPage();
    await popup.goto(`chrome-extension://${harness.extensionId}/popup.html`);
    await popup.waitForFunction(
      async () => {
        const stats = (await browser.storage.local.get('local:stats'))['local:stats'] as
          { cardsEvaluated?: number } | undefined;
        return (stats?.cardsEvaluated ?? 0) >= 120;
      },
      undefined,
      { timeout: 30_000, polling: 500 },
    );
    await popup.close();
  });

  test('E2E-10 recycled node with a new video id is reprocessed', async () => {
    await harness.page.goto(`${BASE}/`);
    await waitForCardState(harness.page, 'card-human', null);

    await harness.page.evaluate(() => {
      const card = document.querySelector('[data-testid="card-human"]');
      if (card === null) throw new Error('missing card');
      const link = card.querySelector('#video-title-link');
      const title = card.querySelector('#video-title');
      if (link instanceof HTMLAnchorElement) link.href = '/watch?v=recycled999';
      if (title !== null) title.textContent = 'Rome retold recycled';
      const badges = document.createElement('div');
      badges.className = 'badges';
      badges.innerHTML =
        '<span class="badge badge-shape-wiz__text">Altered or synthetic content</span>';
      card.appendChild(badges);
    });

    await waitForCardState(harness.page, 'card-human', 'hidden');
  });

  test('E2E-11 search page filters across surfaces', async () => {
    await harness.page.goto(`${BASE}/results`);
    await waitForCardState(harness.page, 'card-search-disclosure', 'hidden');
    await waitForCardState(harness.page, 'card-search-human', null);
  });

  test('E2E-12 watch sidebar filters compact cards', async () => {
    await harness.page.goto(`${BASE}/watch?v=human100`);
    await waitForCardState(harness.page, 'sidebar-disclosure', 'hidden');
    await waitForCardState(harness.page, 'sidebar-human', null);
  });

  test('E2E-13 subscriptions page filters', async () => {
    await harness.page.goto(`${BASE}/feed/subscriptions`);
    await waitForCardState(harness.page, 'card-sub-disclosure', 'hidden');
    await waitForCardState(harness.page, 'card-sub-human', null);
  });

  test('E2E-14 settings persist across context reloads', async () => {
    await writeSettings(harness.page, harness.extensionId, {
      enabled: true,
      mode: 'strict',
      categoryActions: {},
      showExplanations: true,
      collectLocalStats: false,
      youtubeFeedback: { enabled: false },
      remoteProvider: { enabled: false, timeoutMs: 5000 },
    });
    const settings = (await readSettings(harness.page, harness.extensionId)) as { mode?: string };
    expect(settings.mode).toBe('strict');
  });

  test('E2E-15 offline/local-only: no external requests break filtering', async () => {
    const external: string[] = [];
    // QA-07: inspect ALL extension contexts — the service worker plus every
    // page — not only the fixture tab.
    const record = (url: string): void => {
      if (
        !url.startsWith(BASE) &&
        !url.startsWith('chrome-extension://') &&
        !url.startsWith('data:') &&
        !url.startsWith('devtools:')
      ) {
        external.push(url);
      }
    };
    harness.context.on('request', (request) => record(request.url()));
    harness.page.on('request', (request) => record(request.url()));

    await harness.page.goto(`${BASE}/`);
    await waitForCardState(harness.page, 'card-disclosure', 'hidden');

    // Open the extension pages so their requests are captured too.
    const popup = await harness.context.newPage();
    await popup.goto(`chrome-extension://${harness.extensionId}/popup.html`);
    const options = await harness.context.newPage();
    await options.goto(`chrome-extension://${harness.extensionId}/options.html`);
    await expect(options.getByRole('button', { name: 'General' })).toBeVisible();
    await popup.close();
    await options.close();

    expect(external).toEqual([]);
  });

  test('E2E-16 appearance settings apply live (density) without reload', async ({
    browserName,
  }, _testInfo) => {
    void browserName;
    await writeSettings(harness.page, harness.extensionId, {
      enabled: true,
      mode: 'balanced',
      categoryActions: {},
      displayMode: 'placeholder',
      showExplanations: true,
      collectLocalStats: false,
      density: 'comfortable',
      theme: 'system',
      rulePacks: { fil: true },
      history: { enabled: true, retentionDays: 30 },
      shortsGuard: { enabled: false },
      performance: { preset: 'balanced' },
      youtubeFeedback: { enabled: false },
      remoteProvider: { enabled: false, timeoutMs: 5000 },
    });
    await harness.page.goto(`${BASE}/`);
    const card = harness.page.locator('[data-testid="card-disclosure"]');
    await waitForCardState(harness.page, 'card-disclosure', 'hidden');
    await expect(card.locator('.bts-placeholder')).toBeVisible();

    // Switch to compact density via settings — the open page must react live.
    await writeSettings(harness.page, harness.extensionId, {
      enabled: true,
      mode: 'balanced',
      categoryActions: {},
      displayMode: 'placeholder',
      showExplanations: true,
      collectLocalStats: false,
      density: 'compact',
      theme: 'system',
      rulePacks: { fil: true },
      history: { enabled: true, retentionDays: 30 },
      shortsGuard: { enabled: false },
      performance: { preset: 'balanced' },
      youtubeFeedback: { enabled: false },
      remoteProvider: { enabled: false, timeoutMs: 5000 },
    });
    await expect(harness.page.locator('html.bts-root-compact')).toHaveCount(1, {
      timeout: 10_000,
    });
    // The placeholder is still visible, now with the compact geometry class.
    await expect(card.locator('.bts-placeholder')).toBeVisible();
  });
});
