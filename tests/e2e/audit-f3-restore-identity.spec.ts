import { expect, test, type Page } from '@playwright/test';
import { launchHarness, setFixtureOverride, writeSettings, type Harness } from './utils';

/**
 * Audit Finding 3 — loaded-extension Chromium E2E for BOTH recovery routes:
 *  - the on-page session-recovery panel (activity notice → Restore), and
 *  - the popup `session:restore` relay (the exact browser.tabs.sendMessage
 *    call the popup's Restore button makes).
 *
 * The override itself lives in the orchestrator's in-memory show-once map
 * (never a DOM attribute), so it is verified BEHAVIORALLY:
 *  - verified restore ⇒ override granted ⇒ an explicit rescan does NOT
 *    re-hide the revealed video;
 *  - stale entry whose element now holds a DIFFERENT (blocked!) video ⇒
 *    plain restore, NO override ⇒ the rescan re-hides it (re-evaluated
 *    normally, never whitelisted by the stale entry).
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

function f3PageHtml(): string {
  const shorts = ['f3a01', 'f3a02']
    .map((id, i) => {
      const n = i + 1;
      return `<ytm-shorts-lockup-view-model data-testid="shelf-short-${n}" class="shortsLockupVisibleHost">
        <a href="/shorts/${id}" aria-label="Shelf short ${n}"></a>
        <span class="title">Shelf short ${n}</span>
      </ytm-shorts-lockup-view-model>`;
    })
    .join('');
  const watchCard = (n: number, id: string, title: string) =>
    `<ytd-rich-item-renderer data-testid="wcell-${n}">
      <yt-lockup-view-model data-testid="watch-${n}">
        <a id="video-title-link" href="/watch?v=${id}" aria-label="${title}">
          <span id="video-title">${title}</span>
        </a>
        <div id="channel-name"><a href="/channel/UCF30000000000000000">F3 Channel</a></div>
      </yt-lockup-view-model>
    </ytd-rich-item-renderer>`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8" /><title>FixtureTube — audit F3</title>
<style>
  body { margin: 0; font-family: Roboto, Arial, sans-serif; }
  ytm-shorts-lockup-view-model { display: inline-block; width: 160px; height: 300px; }
  ytd-rich-item-renderer { display: block; margin-bottom: 12px; }
  yt-lockup-view-model { display: block; min-height: 94px; }
</style></head>
<body><h1>Home</h1>
<main id="contents">
  <ytd-rich-item-renderer data-testid="shelf-item">
    <div id="content"><ytd-rich-shelf-renderer><div id="contents">${shorts}</div></ytd-rich-shelf-renderer></div>
  </ytd-rich-item-renderer>
  ${watchCard(3, 'f3a03', 'Watch card three')}
  ${watchCard(4, 'f3a04', 'Watch card four')}
</main>
</body></html>`;
}

const BLOCKED = ['f3a01', 'f3a02', 'f3a03', 'f3a04', 'f3a05'];

async function writeF3Rules(harness: Harness): Promise<void> {
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

async function writeF3Settings(harness: Harness): Promise<void> {
  await writeSettings(harness.page, harness.extensionId, {
    enabled: true,
    mode: 'strict',
    displayMode: 'collapse',
    showExplanations: false,
    collectLocalStats: false,
    surfaces: { 'shorts-shelf': true, home: true },
  });
}

/**
 * Run an async action from an extension page with the YouTube tab ACTIVE —
 * the popup's own relay targets `tabs.query({active, currentWindow})`, so the
 * YouTube tab must be frontmost for the message to reach the content script.
 */
async function withPopupRelay<T>(
  harness: Harness,
  action: (arg: string | undefined) => Promise<T>,
  arg?: string,
): Promise<T> {
  const ext = await harness.page.context().newPage();
  await ext.goto(`chrome-extension://${harness.extensionId}/popup.html`);
  try {
    // Opening a new tab steals focus; the YouTube tab must be ACTIVE again
    // before the evaluate runs, because the relay targets the active tab.
    await harness.page.bringToFront();
    // Note: evaluate() closures cannot capture outer variables — pass `arg`.
    return await ext.evaluate(action, arg);
  } finally {
    await ext.close();
  }
}

test.describe('Audit F3: recovery restores validate the saved identity', () => {
  let harness: Harness;

  test.afterEach(async () => {
    await harness?.cleanup();
    setFixtureOverride('auditf3', null);
  });

  test('on-page panel restore reveals the verified video and grants the show-once override', async () => {
    harness = await launchHarness();
    setFixtureOverride('auditf3', f3PageHtml());
    await writeF3Settings(harness);
    await writeF3Rules(harness);

    await harness.page.goto('https://www.youtube.com/auditf3');
    await expect
      .poll(async () => (await boxOf(harness.page, '[data-testid="watch-3"]')).display, {
        timeout: 20_000,
      })
      .toBe('none');
    await expect
      .poll(async () => (await boxOf(harness.page, '[data-testid="watch-4"]')).display, {
        timeout: 10_000,
      })
      .toBe('none');

    // On-page route: open the session-recovery panel and restore card three.
    await expect
      .poll(
        async () =>
          harness.page.evaluate(
            () => document.querySelector('.bts-activity-notice')?.textContent ?? '',
          ),
        { timeout: 10_000 },
      )
      .toContain('hidden');
    await harness.page.click('.bts-activity-notice');
    await harness.page.waitForSelector('.bts-activity-panel', { timeout: 10_000 });
    await harness.page.click(
      '.bts-activity-item:has-text("Watch card three") .bts-button:has-text("Restore")',
    );

    // Real rendered recovery (poll — never a bare read).
    await expect
      .poll(async () => (await boxOf(harness.page, '[data-testid="watch-3"]')).h, {
        timeout: 10_000,
      })
      .toBeGreaterThan(40);

    // The override is behavioral: an explicit rescan must NOT re-hide the
    // revealed video (saved identity == stamp == current content ⇒ verified).
    await withPopupRelay(harness, async () => {
      const tabs = await browser.tabs.query({ active: true, currentWindow: true });
      if (tabs[0]?.id) await browser.tabs.sendMessage(tabs[0].id, { type: 'orchestrator:rescan' });
      return true;
    });
    await harness.page.waitForTimeout(800);
    const afterRescan = await boxOf(harness.page, '[data-testid="watch-3"]');
    expect(afterRescan.display).not.toBe('none');
    expect(afterRescan.h).toBeGreaterThan(40);
    // Card four (never restored) stays collapsed.
    expect((await boxOf(harness.page, '[data-testid="watch-4"]')).display).toBe('none');
  });

  test('popup session:restore refuses a STALE row (element recycled to another video)', async () => {
    harness = await launchHarness();
    setFixtureOverride('auditf3', f3PageHtml());
    await writeF3Settings(harness);
    await writeF3Rules(harness);

    await harness.page.goto('https://www.youtube.com/auditf3');
    await expect
      .poll(async () => (await boxOf(harness.page, '[data-testid="watch-4"]')).display, {
        timeout: 20_000,
      })
      .toBe('none');

    // The popup list is read at T0 — a real user flow: the popup can sit open
    // while YouTube recycles the hidden card underneath it.
    const staleEntryId = await withPopupRelay(harness, async () => {
      const tabs = await browser.tabs.query({ active: true, currentWindow: true });
      if (!tabs[0]?.id) return null;
      const listed = (await browser.tabs.sendMessage(tabs[0].id, {
        type: 'session:listHides',
      })) as { hides?: Array<{ id: string; videoId?: string }> };
      return listed.hides?.find((h) => h.videoId === 'f3a04')?.id ?? null;
    });
    expect(staleEntryId).not.toBeNull();

    // YouTube recycles the hidden element to a DIFFERENT blocked video
    // (f3a05). The pipeline converges: it re-decides f3a05, replaces the
    // recovery entry (record() drops entries for the same element), and
    // re-stamps the card. The T0 popup row is now stale.
    await harness.page.evaluate(() => {
      const el = document.querySelector('[data-testid="watch-4"]');
      if (el === null) throw new Error('watch-4 missing');
      const tpl = document.createElement('template');
      tpl.innerHTML = `<a id="video-title-link" href="/watch?v=f3a05" aria-label="Recycled five">
          <span id="video-title">Recycled five</span>
        </a>
        <div id="channel-name"><a href="/channel/UCF39000000000000000">F3 Nine</a></div>`;
      el.replaceChildren(...tpl.content.childNodes);
    });
    await withPopupRelay(harness, async () => {
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline) {
        const tabs = await browser.tabs.query({ active: true, currentWindow: true });
        if (tabs[0]?.id) {
          const listed = (await browser.tabs.sendMessage(tabs[0].id, {
            type: 'session:listHides',
          })) as { hides?: Array<{ videoId?: string }> };
          if (listed.hides?.some((h) => h.videoId === 'f3a05')) return true;
        }
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      return false;
    });

    // The stale T0 row is restored by id: the content script must NOT reveal
    // or whitelist anything for an entry that no longer describes the card.
    const result = await withPopupRelay(
      harness,
      async (id) => {
        const tabs = await browser.tabs.query({ active: true, currentWindow: true });
        if (!tabs[0]?.id || id === undefined) return { restored: false, reason: 'no-tab' };
        return (await browser.tabs.sendMessage(tabs[0].id, {
          type: 'session:restore',
          payload: { id },
        })) as { restored: boolean };
      },
      staleEntryId ?? undefined,
    );
    expect(result).toEqual({ restored: false, outcome: 'obsolete' });

    // The card was NOT revealed by the stale row: it stays hidden and its
    // recovery entry now describes the CURRENT video (f3a05), reachable for
    // a legitimate restore.
    expect((await boxOf(harness.page, '[data-testid="watch-4"]')).display).toBe('none');
    const listNow = await withPopupRelay(harness, async () => {
      const tabs = await browser.tabs.query({ active: true, currentWindow: true });
      if (!tabs[0]?.id) return [];
      const listed = (await browser.tabs.sendMessage(tabs[0].id, {
        type: 'session:listHides',
      })) as { hides?: Array<{ videoId?: string }> };
      return listed.hides?.map((h) => h.videoId) ?? [];
    });
    expect(listNow).toContain('f3a05');
    expect(listNow).not.toContain('f3a04');
  });
});
