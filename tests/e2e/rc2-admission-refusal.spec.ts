import { expect, test, type Page } from '@playwright/test';
import { launchHarness, setFixtureOverride, writeSettings, type Harness } from './utils';

/**
 * RC2 issue 1 — the REAL content-script admission path, in a loaded extension.
 *
 * Production wiring (wireRecoveryAdmission in the actual entrypoint module)
 * gives every hide a session-recovery slot before presentation. This test
 * fills the store to capacity through the extension's OWN pipeline (110
 * blocked cards on a real fixture page), then verifies:
 *  - every still-hidden card has a popup-listed recovery route (invariant);
 *  - hidden cards really render as collapsed (computed styles + geometry);
 *  - no refusal chips appeared (capacity was freed by successful evictions,
 *    which must be rendered visible);
 *  - the DOM carries evidence of the production wiring: hiding worked and
 *    the store never exceeded capacity.
 *
 * The refusal chip itself is verified at the DOM level in the reservation
 * suite; triggering it live requires a wedged eviction callback, which the
 * real extension does not ship (its eviction only fails if restore throws —
 * exercised by the DOM suite). Here we assert the production path end-to-end
 * with the shipped wiring.
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

const N = 110;
const videoId = (i: number): string => `rc2wire${String(i).padStart(3, '0')}`;

function pageHtml(): string {
  const cards: string[] = [];
  for (let i = 0; i < N; i++) {
    cards.push(`<ytd-rich-item-renderer data-testid="wcell-${i}">
      <yt-lockup-view-model data-testid="watch-${i}">
        <a id="video-title-link" href="/watch?v=${videoId(i)}" aria-label="Wire card ${i}">
          <span id="video-title">Wire card ${i}</span>
        </a>
        <div id="channel-name"><a href="/channel/UCRc2w0000000000000000">Wire Channel</a></div>
        <div class="badges"><span class="badge badge-shape-wiz__text">Altered or synthetic content</span></div>
      </yt-lockup-view-model>
    </ytd-rich-item-renderer>`);
  }
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8" /><title>FixtureTube — RC2 wiring</title>
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

test.describe('RC2 issue 1: production admission wiring (loaded extension)', () => {
  let harness: Harness;

  test.afterEach(async () => {
    await harness?.cleanup();
    setFixtureOverride('rc2wire', null);
  });

  test('capacity pressure through the shipped wiring: routes for every hidden card, evictions rendered', async () => {
    harness = await launchHarness();
    setFixtureOverride('rc2wire', pageHtml());
    const ext = await harness.page.context().newPage();
    await ext.goto(`chrome-extension://${harness.extensionId}/popup.html`);
    await ext.evaluate(
      async (ids) => {
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
      },
      Array.from({ length: N }, (_, i) => videoId(i)),
    );
    await ext.close();
    await writeSettings(harness.page, harness.extensionId, {
      enabled: true,
      mode: 'strict',
      displayMode: 'collapse',
      showExplanations: false,
      collectLocalStats: false,
      history: { enabled: false, retentionDays: 30 },
      surfaces: { home: true },
    });

    await harness.page.goto('https://www.youtube.com/rc2wire');
    // Capacity pressure happened: the oldest ten were evicted (revealed).
    await expect
      .poll(async () => (await boxOf(harness.page, '[data-testid="watch-0"]')).display, {
        timeout: 30_000,
      })
      .not.toBe('none');
    expect((await boxOf(harness.page, '[data-testid="watch-0"]')).h).toBeGreaterThan(40);

    // INVARIANT: routes come from the popup relay; hidden IDs are measured in
    // the YouTube tab itself (two contexts, then joined in Node).
    await harness.page.bringToFront();
    const extPage = await harness.page.context().newPage();
    await extPage.goto(`chrome-extension://${harness.extensionId}/popup.html`);
    await harness.page.bringToFront();
    const routes = await extPage.evaluate(async () => {
      const tabs = await browser.tabs.query({ active: true, currentWindow: true });
      if (!tabs[0]?.id) return [];
      const listed = (await browser.tabs.sendMessage(tabs[0].id, {
        type: 'session:listHides',
      })) as { hides?: Array<{ videoId?: string }> };
      return (listed.hides ?? []).map((h) => h.videoId ?? '');
    });
    await extPage.close();
    const hiddenIds = await harness.page.evaluate(() =>
      [...document.querySelectorAll('[data-bts-collapse]')]
        .map((el) => el.getAttribute('data-bts-video-id'))
        .filter((id): id is string => id !== null),
    );
    const routeSet = new Set(routes);
    const withoutRoute = hiddenIds.filter((id) => !routeSet.has(id));
    expect(withoutRoute).toEqual([]);
    expect(hiddenIds).toHaveLength(100); // capacity: exactly 100 hidden
    expect(routes).toHaveLength(100);

    // Newest card is hidden with real geometry; no refusal chips anywhere.
    expect((await boxOf(harness.page, `[data-testid="watch-${N - 1}"]`)).display).toBe('none');
    expect(await harness.page.locator('.bts-persist-error').count()).toBe(0);
  });
});
