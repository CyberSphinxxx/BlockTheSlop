import { expect, test, type Page } from '@playwright/test';
import { launchHarness, setFixtureOverride, writeSettings, type Harness } from './utils';

/**
 * Release blocker C — loaded-extension, history-OFF capacity pressure.
 *
 * The auditor's probe (entries: 100, oldestStillHidden: true,
 * oldestHasRecovery: false): a throwing eviction callback destroyed the ONLY
 * recovery route while history was off. The production wiring now:
 *  - reserves a recovery slot BEFORE a hide is applied (reserve-before-hide),
 *  - reveals the oldest card through the eviction callback and only then
 *    drops its entry (throw/false = failure = entry preserved),
 *  - refuses a hide (fail open, visible + local notice) when no slot can be
 *    secured.
 *
 * Asserted here with the REAL extension against REAL rendered state:
 *  1. 110 hidden connected cards with history off: eviction revealed the
 *     ten oldest (rendered), and EVERY still-hidden card has a popup-listed
 *     recovery route (invariant across all cards, not just the newest).
 *  2. Restoring one hidden card really renders it.
 *  3. Disable → re-enable → refill recycled slots: no wedged admission (no
 *     refusal chips), all refilled videos hidden, invariant still holds.
 */

interface Box {
  display: string;
  h: number;
}

async function boxOf(page: Page, selector: string): Promise<Box> {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (el === null) return { display: 'missing', h: 0 };
    return { display: getComputedStyle(el).display, h: el.getBoundingClientRect().height };
  }, selector);
}

const FIRST_BATCH = 110;
const videoId = (i: number): string => `rcce2c${String(i).padStart(3, '0')}`;
const refillId = (i: number): string => `rcce2n${String(i).padStart(3, '0')}`;

function pageHtml(): string {
  const watchCard = (n: number, id: string, title: string) =>
    `<ytd-rich-item-renderer data-testid="wcell-${n}">
      <yt-lockup-view-model data-testid="watch-${n}">
        <a id="video-title-link" href="/watch?v=${id}" aria-label="${title}">
          <span id="video-title">${title}</span>
        </a>
        <div id="channel-name"><a href="/channel/UCRccc0000000000000000">RCC E2E Channel</a></div>
        <div class="badges"><span class="badge badge-shape-wiz__text">Altered or synthetic content</span></div>
      </yt-lockup-view-model>
    </ytd-rich-item-renderer>`;
  const cards: string[] = [];
  for (let i = 0; i < FIRST_BATCH; i++) {
    cards.push(watchCard(i, videoId(i), `Capacity card ${i}`));
  }
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8" /><title>FixtureTube — RC blocker C</title>
<style>
  body { margin: 0; font-family: Roboto, Arial, sans-serif; }
  ytd-rich-item-renderer { display: block; margin-bottom: 12px; }
  yt-lockup-view-model { display: block; min-height: 94px; }
</style></head>
<body><h1>Home</h1>
<main id="contents">
${cards.join('\n')}
</main>
</body></html>`;
}

function blockedIds(): string[] {
  const ids = Array.from({ length: FIRST_BATCH }, (_, i) => videoId(i));
  ids.push(...Array.from({ length: 10 }, (_, i) => refillId(i)));
  return ids;
}

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
  }, blockedIds());
  await ext.close();
}

async function writeCSettings(
  harness: Harness,
  overrides: Record<string, unknown> = {},
): Promise<void> {
  await writeSettings(harness.page, harness.extensionId, {
    enabled: true,
    mode: 'strict',
    displayMode: 'collapse',
    showExplanations: false,
    collectLocalStats: false,
    history: { enabled: false, retentionDays: 30 },
    surfaces: { home: true },
    ...overrides,
  });
}

async function withPopupRelay<T>(
  page: Page,
  extensionId: string,
  action: (arg: string | undefined) => Promise<T>,
  arg?: string,
): Promise<T> {
  const ext = await page.context().newPage();
  await ext.goto(`chrome-extension://${extensionId}/popup.html`);
  try {
    await page.bringToFront();
    return await ext.evaluate(action, arg);
  } finally {
    await ext.close();
  }
}

/** Every hidden card in the DOM must have a popup-listed recovery route. */
async function expectInvariant(page: Page, extensionId: string): Promise<void> {
  const result = (await withPopupRelay(page, extensionId, async () => {
    const tabs = await browser.tabs.query({ active: true, currentWindow: true });
    if (!tabs[0]?.id) return { hiddenWithoutRoute: ['no-tab'] };
    const listed = (await browser.tabs.sendMessage(tabs[0].id, {
      type: 'session:listHides',
    })) as { hides?: Array<{ videoId?: string }> };
    const routes = new Set((listed.hides ?? []).map((h) => h.videoId));
    const hiddenIds = [...document.querySelectorAll('[data-bts-collapse]')]
      .map((el) => el.getAttribute('data-bts-video-id'))
      .filter((id): id is string => id !== null);
    const hiddenWithoutRoute = hiddenIds.filter((id) => !routes.has(id));
    return { hiddenWithoutRoute, hiddenCount: hiddenIds.length, routeCount: routes.size };
  })) as { hiddenWithoutRoute: string[]; hiddenCount: number; routeCount: number };
  expect(result.hiddenWithoutRoute).toEqual([]);
}

test.describe('RC blocker C: history-off recovery survives capacity pressure', () => {
  let harness: Harness;

  test.afterEach(async () => {
    await harness?.cleanup();
    setFixtureOverride('rcbe2c', null);
  });

  test('110 hidden cards, history off: evicted oldest rendered, every hidden card has a route, restore renders', async () => {
    harness = await launchHarness();
    setFixtureOverride('rcbe2c', pageHtml());
    await writeCSettings(harness);
    await writeRules(harness);

    await harness.page.goto('https://www.youtube.com/rcbe2c');
    // Capacity pressure: the ten OLDEST cards were evicted through the
    // reveal path (fail-open) — they must be really visible.
    await expect
      .poll(async () => (await boxOf(harness.page, '[data-testid="watch-0"]')).display, {
        timeout: 30_000,
      })
      .not.toBe('none');
    const evictedVisible = await boxOf(harness.page, '[data-testid="watch-0"]');
    expect(evictedVisible.h).toBeGreaterThan(40);
    // The newest cards stay hidden.
    expect((await boxOf(harness.page, `[data-testid="watch-${FIRST_BATCH - 1}"]`)).display).toBe(
      'none',
    );

    // INVARIANT across ALL cards: every hidden card has a popup-listed route.
    await expectInvariant(harness.page, harness.extensionId);

    // Restoring a hidden card REALLY renders it (computed style + geometry).
    const targetId = videoId(FIRST_BATCH - 1);
    const restoreResult = await withPopupRelay(
      harness.page,
      harness.extensionId,
      async (id) => {
        const tabs = await browser.tabs.query({ active: true, currentWindow: true });
        if (!tabs[0]?.id) return { restored: false };
        const listed = (await browser.tabs.sendMessage(tabs[0].id, {
          type: 'session:listHides',
        })) as { hides?: Array<{ id: string; videoId?: string }> };
        const entry = listed.hides?.find((h) => h.videoId === id);
        if (!entry) return { restored: false };
        return (await browser.tabs.sendMessage(tabs[0].id, {
          type: 'session:restore',
          payload: { id: entry.id },
        })) as { restored: boolean };
      },
      targetId,
    );
    expect(restoreResult).toEqual({ restored: true, outcome: 'restored' });
    await expect
      .poll(async () => (await boxOf(harness.page, `[data-testid="watch-${FIRST_BATCH - 1}"]`)).h, {
        timeout: 10_000,
      })
      .toBeGreaterThan(40);
  });

  test('disable → re-enable → refill recycled slots: no wedged admission, invariant holds', async () => {
    harness = await launchHarness();
    setFixtureOverride('rcbe2c', pageHtml());
    await writeCSettings(harness);
    await writeRules(harness);

    await harness.page.goto('https://www.youtube.com/rcbe2c');
    await expect
      .poll(
        async () => (await boxOf(harness.page, `[data-testid="watch-${FIRST_BATCH - 1}"]`)).display,
        {
          timeout: 30_000,
        },
      )
      .toBe('none');

    // Disable: filtering off restores content immediately (no stranded hides).
    await writeCSettings(harness, { enabled: false });
    await expect
      .poll(
        async () => (await boxOf(harness.page, `[data-testid="watch-${FIRST_BATCH - 1}"]`)).display,
        {
          timeout: 15_000,
        },
      )
      .not.toBe('none');

    // Re-enable and refill the ten previously-evicted (now visible) slots
    // with DIFFERENT blocked videos (YouTube slot recycling shape).
    await writeCSettings(harness, { enabled: true });
    await harness.page.evaluate(() => {
      for (let i = 0; i < 10; i++) {
        const el = document.querySelector(`[data-testid="watch-${i}"]`);
        if (el === null) continue;
        const id = `rcce2n${String(i).padStart(3, '0')}`;
        const tpl = document.createElement('template');
        tpl.innerHTML = `<a id="video-title-link" href="/watch?v=${id}" aria-label="Refilled card ${i}">
            <span id="video-title">Refilled card ${i}</span>
          </a>
          <div id="channel-name"><a href="/channel/UCRccc0000000000000000">RCC E2E Channel</a></div>
          <div class="badges"><span class="badge badge-shape-wiz__text">Altered or synthetic content</span></div>`;
        el.replaceChildren(...tpl.content.childNodes);
      }
    });

    // All ten refilled videos end up hidden again.
    for (let i = 0; i < 10; i++) {
      await expect
        .poll(async () => (await boxOf(harness.page, `[data-testid="watch-${i}"]`)).display, {
          timeout: 20_000,
        })
        .toBe('none');
    }
    // No admission refusal chips: no hide had to fail open.
    expect(await harness.page.locator('.bts-persist-error').count()).toBe(0);
    // And the invariant still holds across every hidden card.
    await expectInvariant(harness.page, harness.extensionId);
  });
});
