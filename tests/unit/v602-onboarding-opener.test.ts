import { beforeEach, describe, expect, it } from 'vitest';
import { wireOnboardingOpener } from '@/background/onboarding-opener';
import { OnboardingStore } from '@/storage/onboarding-store';
import { MemoryKVStore } from '@/storage/db';

interface InstalledListener {
  (details: { reason: string }): void;
}

function fakeApi() {
  const listeners: InstalledListener[] = [];
  const createdUrls: string[] = [];
  const existingTabs: string[] = [];
  const api = {
    runtime: {
      onInstalled: {
        addListener(cb: InstalledListener): void {
          listeners.push(cb);
        },
      },
    },
    tabs: {
      query: async (q: { url: string }) =>
        existingTabs.filter((u) => u === q.url).map((u) => ({ id: existingTabs.indexOf(u) })),
      create: async (props: { url: string }) => {
        createdUrls.push(props.url);
        existingTabs.push(props.url);
        return { id: existingTabs.length };
      },
    },
  };
  return {
    api,
    listeners,
    createdUrls,
    existingTabs,
    fire(reason: string): void {
      for (const l of listeners) l({ reason });
    },
    async settle(): Promise<void> {
      await new Promise((r) => setTimeout(r, 0));
    },
  };
}

describe('background onboarding opener (V6-02)', () => {
  let kv: MemoryKVStore;
  let store: OnboardingStore;
  let t: ReturnType<typeof fakeApi>;
  const url = () => 'chrome-extension://test/onboarding.html';

  beforeEach(() => {
    kv = new MemoryKVStore();
    store = new OnboardingStore(kv);
    t = fakeApi();
    wireOnboardingOpener(t.api, url, { onboarding: store });
  });

  it('opens exactly once on install for a fresh profile', async () => {
    t.fire('install');
    await t.settle();
    expect(t.createdUrls).toEqual([url()]);
  });

  it('never opens for updates, browser restarts, or unknown reasons', async () => {
    for (const reason of [
      'update',
      'chrome_update',
      'shared_module_update',
      'browser_update',
      'unknown',
    ]) {
      t.fire(reason);
      await t.settle();
    }
    expect(t.createdUrls).toEqual([]);
  });

  it('does not duplicate on a second install event in the same worker lifetime', async () => {
    t.fire('install');
    await t.settle();
    t.fire('install');
    await t.settle();
    expect(t.createdUrls).toEqual([url()]);
  });

  it('does not duplicate when an onboarding tab already exists', async () => {
    t.existingTabs.push(url());
    t.fire('install');
    await t.settle();
    expect(t.createdUrls).toEqual([]);
  });

  it('never re-opens after setup completed (reload keeps storage)', async () => {
    await store.markCompleted();
    t.fire('install');
    await t.settle();
    expect(t.createdUrls).toEqual([]);
  });

  it('survives tabs.query failure without crashing or duplicating', async () => {
    t.api.tabs.query = async () => {
      throw new Error('tabs API unavailable');
    };
    t.fire('install');
    await t.settle();
    // Conservative read: no open, no crash.
    expect(t.createdUrls).toEqual([]);
  });

  it('allows retry after the tab-open itself fails', async () => {
    let failCreate = true;
    t.api.tabs.create = async (props: { url: string }) => {
      if (failCreate) throw new Error('tab open rejected');
      t.createdUrls.push(props.url);
      return { id: 1 };
    };
    t.fire('install');
    await t.settle();
    expect(t.createdUrls).toEqual([]);
    failCreate = false;
    t.fire('install');
    await t.settle();
    expect(t.createdUrls).toEqual([url()]);
  });
});
