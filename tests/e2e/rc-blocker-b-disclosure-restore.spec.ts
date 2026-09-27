import { expect, test, type Page } from '@playwright/test';
import { launchHarness, setFixtureOverride, writeSettings, type Harness } from './utils';

/**
 * Release blocker B — loaded-extension regression for DISCLOSED cards.
 *
 * Pre-fix loaded-extension repro: hide the official-disclosure card, restore
 * via session recovery → `restored:true`, card visible, but NO show-once
 * override (the saved identity was reconstructed without officialDisclosure,
 * so the restore degraded to 'unverified'); an explicit rescan then re-hid
 * the card to display:none / zero height.
 *
 * Acceptance here asserts REAL rendered state (computed display + bounding
 * geometry, polled), never attributes:
 *   1. the disclosed card hides,
 *   2. restore renders it visibly and acknowledges a real restore,
 *   3. an explicit rescan does NOT re-hide it (override established),
 *   4. a different video recycled into the element does not inherit the
 *      override — it is filtered normally again.
 */

interface Box {
  display: string;
  visibility: string;
  h: number;
}

async function boxOf(page: Page, selector: string): Promise<Box> {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (el === null) return { display: 'missing', visibility: 'missing', h: 0 };
    const cs = getComputedStyle(el);
    return { display: cs.display, visibility: cs.visibility, h: el.getBoundingClientRect().height };
  }, selector);
}

function pageHtml(): string {
  const watchCard = (n: number, id: string, title: string, disclosure: boolean) =>
    `<ytd-rich-item-renderer data-testid="wcell-${n}">
      <yt-lockup-view-model data-testid="watch-${n}">
        <a id="video-title-link" href="/watch?v=${id}" aria-label="${title}">
          <span id="video-title">${title}</span>
        </a>
        <div id="channel-name"><a href="/channel/UCRcbe0000000000000000">RCB E2E Channel</a></div>${
          disclosure
            ? '\n        <div class="badges"><span class="badge badge-shape-wiz__text">Altered or synthetic content</span></div>'
            : ''
        }
      </yt-lockup-view-model>
    </ytd-rich-item-renderer>`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8" /><title>FixtureTube — RC blocker B</title>
<style>
  body { margin: 0; font-family: Roboto, Arial, sans-serif; }
  ytd-rich-item-renderer { display: block; margin-bottom: 12px; }
  yt-lockup-view-model { display: block; min-height: 94px; }
</style></head>
<body><h1>Home</h1>
<main id="contents">
  ${watchCard(1, 'rcbe2dis1', 'Disclosed card one', true)}
  ${watchCard(2, 'rcbe2plain', 'Plain card two', false)}
</main>
</body></html>`;
}

const BLOCKED = ['rcbe2dis1', 'rcbe2plain', 'rcbe2next'];

async function writeRules(harness: Harness): Promise<void> {
  const ext = await harness.page.context().newPage();
  await ext.goto(`chrome-extension://${harness.extensionId}/popup.html`);
  await ext.evaluate(async (ids) => {
    await browser.storage.local.set({
      'local:rules': {
        allowedVideoIds: [],
        blockedVideoIds: ids,
        allowedChannelIds: [],
        blockedChannelIds: [],
        fallbackAllowedHandles: [],
        fallbackBlockedHandles: [],
        blockedPhrases: [],
        blockedPhraseRules: [],
        channelRulesMeta: {},
      },
    });
  }, BLOCKED);
  await ext.close();
}

async function writeBSettings(harness: Harness): Promise<void> {
  await writeSettings(harness.page, harness.extensionId, {
    enabled: true,
    mode: 'strict',
    displayMode: 'collapse',
    showExplanations: false,
    collectLocalStats: false,
    surfaces: { home: true },
  });
}

/** Run an async action from the popup page with the YouTube tab ACTIVE. */
async function withPopupRelay<T>(
  harness: Harness,
  action: (arg: string | undefined) => Promise<T>,
  arg?: string,
): Promise<T> {
  const ext = await harness.page.context().newPage();
  await ext.goto(`chrome-extension://${harness.extensionId}/popup.html`);
  try {
    // Opening a new tab steals focus; the relay targets the ACTIVE tab.
    await harness.page.bringToFront();
    return await ext.evaluate(action, arg);
  } finally {
    await ext.close();
  }
}

async function rescanViaPopup(harness: Harness): Promise<void> {
  await withPopupRelay(harness, async () => {
    const tabs = await browser.tabs.query({ active: true, currentWindow: true });
    if (tabs[0]?.id) await browser.tabs.sendMessage(tabs[0].id, { type: 'orchestrator:rescan' });
    return true;
  });
}

test.describe('RC blocker B: disclosed-video restore survives rescans (loaded extension)', () => {
  let harness: Harness;

  test.afterEach(async () => {
    await harness?.cleanup();
    setFixtureOverride('rcbe2b', null);
  });

  test('restore → visible render → rescan keeps it visible → recycled video re-hides', async () => {
    harness = await launchHarness();
    setFixtureOverride('rcbe2b', pageHtml());
    await writeBSettings(harness);
    await writeRules(harness);

    await harness.page.goto('https://www.youtube.com/rcbe2b');
    // 1. The disclosed card is collapsed (real rendered state).
    await expect
      .poll(async () => (await boxOf(harness.page, '[data-testid="watch-1"]')).display, {
        timeout: 20_000,
      })
      .toBe('none');
    await expect
      .poll(async () => (await boxOf(harness.page, '[data-testid="watch-2"]')).display, {
        timeout: 10_000,
      })
      .toBe('none');

    // 2. Restore the DISCLOSED card through the popup relay.
    const restoreResult = await withPopupRelay(harness, async () => {
      const tabs = await browser.tabs.query({ active: true, currentWindow: true });
      if (!tabs[0]?.id) return { restored: false };
      const listed = (await browser.tabs.sendMessage(tabs[0].id, {
        type: 'session:listHides',
      })) as { hides?: Array<{ id: string; videoId?: string }> };
      const entry = listed.hides?.find((h) => h.videoId === 'rcbe2dis1');
      if (!entry) return { restored: false };
      return (await browser.tabs.sendMessage(tabs[0].id, {
        type: 'session:restore',
        payload: { id: entry.id },
      })) as { restored: boolean };
    });
    expect(restoreResult).toEqual({ restored: true, outcome: 'restored' });

    // The card really renders (computed display + geometry, polled).
    await expect
      .poll(async () => (await boxOf(harness.page, '[data-testid="watch-1"]')).h, {
        timeout: 10_000,
      })
      .toBeGreaterThan(40);
    const revealed = await boxOf(harness.page, '[data-testid="watch-1"]');
    expect(revealed.display).not.toBe('none');
    expect(revealed.visibility).not.toBe('hidden');

    // 3. Explicit rescan: the verified show-once override must hold — the
    // card STAYS visible (the pre-fix bug re-hid it here).
    await rescanViaPopup(harness);
    await harness.page.waitForTimeout(800);
    const afterRescan = await boxOf(harness.page, '[data-testid="watch-1"]');
    expect(afterRescan.display).not.toBe('none');
    expect(afterRescan.h).toBeGreaterThan(40);
    // The never-restored card stays collapsed.
    expect((await boxOf(harness.page, '[data-testid="watch-2"]')).display).toBe('none');

    // 4. A DIFFERENT blocked video recycled into the element does not inherit
    // the override: after the swap + rescan it is filtered normally.
    await harness.page.evaluate(() => {
      const el = document.querySelector('[data-testid="watch-1"]');
      if (el === null) throw new Error('watch-1 missing');
      const tpl = document.createElement('template');
      tpl.innerHTML = `<a id="video-title-link" href="/watch?v=rcbe2next" aria-label="Recycled next video">
          <span id="video-title">Recycled next video</span>
        </a>
        <div id="channel-name"><a href="/channel/UCRcbe0000000000000000">RCB E2E Channel</a></div>`;
      el.replaceChildren(...tpl.content.childNodes);
    });
    await rescanViaPopup(harness);
    await expect
      .poll(async () => (await boxOf(harness.page, '[data-testid="watch-1"]')).display, {
        timeout: 15_000,
      })
      .toBe('none');
  });
});
