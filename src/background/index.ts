import { BrowserKVStore } from '@/storage/db';
import { SettingsStore } from '@/storage/settings-store';
import { RuleStore } from '@/storage/rule-store';
import { StatsStore } from '@/storage/stats-store';
import { OnboardingStore } from '@/storage/onboarding-store';
import { DailyStatsStore } from '@/storage/stats-daily-store';
import { serializeDailyStats } from '@/domain/stats-daily';
import { wireOnboardingOpener } from '@/background/onboarding-opener';
import type { DiscoverySource } from '@/domain/onboarding';
import { StorageService } from '@/storage/service';
import { MissReviewStore } from '@/storage/miss-review-store';
import { runMigrations } from '@/storage/migrations';
import { validateReviewRecords, type ReviewRecord } from '@/domain/review';
import type { ReviewSummary } from '@/domain/history';
import type { FilterDecision } from '@/domain/decision';
import type { Classification } from '@/domain/classification';
import { RULES_VERSION } from '@/domain/versions';
import { toFingerprintInputOrNull } from '@/storage/fingerprint';
import { STORAGE_KEYS } from '@/storage/keys';
import { logger, setDebugEnabled } from '@/shared/logger';
import {
  validateMessageRequest,
  roleMayInvoke,
  type MessageRole,
} from '@/background/message-validation';

// Service workers are ephemeral: settings/rules stay in storage.local;
// durable history/corrections/cache live in extension-origin IndexedDB (R10).
const kv = new BrowserKVStore();
const settingsStore = new SettingsStore(kv);
const ruleStore = new RuleStore(kv);
const statsStore = new StatsStore(kv);
const onboardingStore = new OnboardingStore(kv);
const dailyStatsStore = new DailyStatsStore(kv);
const missReviewStore = new MissReviewStore(kv);
const storageService = new StorageService();

export interface MessageRequest {
  type: string;
  payload?: unknown;
}

type MessageHandler = (payload: unknown) => Promise<unknown>;

const handlers: Record<string, MessageHandler> = {
  'settings:get': async () => (await settingsStore.load()).settings,
  'rules:get': async () => ruleStore.load(),
  'stats:get': async () => statsStore.load(),
  // Review history: merged view — durable summaries plus any legacy records
  // that still await migration (pre-IDB data is never dropped on upgrade).
  'review:list': async () => {
    const [summaries, legacyRaw] = await Promise.all([
      storageService.listRecentSummaries(200),
      kv.get<unknown>(STORAGE_KEYS.reviewRecords),
    ]);
    const legacy: ReviewRecord[] = validateReviewRecords(legacyRaw) ?? [];
    return { summaries, legacy };
  },
  'history:restore': async (payload) => {
    const { key } = payload as { key: string };
    const restored = await storageService.markRestored(key);
    // Audit A3: record the daily restore outcome (fire-and-forget; a stats
    // failure must never fail the restore itself). Identity matches the hide
    // dedup rule: videoId when known, else the summary's own key.
    if (restored) {
      const [summary] = await storageService.getSummaries([key]);
      if (summary !== undefined) {
        await dailyStatsStore
          .record('restore', summary.videoId ?? `sig:${key}`, key, Date.now())
          .catch(() => undefined);
      }
    }
    return restored;
  },
  'history:query': async (payload) => {
    const query = payload as Parameters<StorageService['queryHistory']>[0];
    return storageService.queryHistory(query);
  },
  'history:events': async (payload) => {
    const { key, limit } = payload as { key: string; limit?: number };
    return storageService.eventsFor(key, limit ?? 20);
  },
  'history:delete': async (payload) => {
    const { keys } = payload as { keys: string[] };
    return storageService.deleteSummaries(keys);
  },
  'history:getMany': async (payload) => {
    const { keys } = payload as { keys: string[] };
    return storageService.getSummaries(keys);
  },
  'history:putMany': async (payload) => {
    const { summaries } = payload as { summaries: ReviewSummary[] };
    await storageService.putSummaries(summaries);
    return true;
  },
  // Content scripts route hide events here (they never touch IDB, 04 §6).
  'history:record': async (payload) => {
    const input = payload as {
      videoId?: string;
      title: string;
      channelId?: string;
      channelName?: string;
      surface: string;
      decision: FilterDecision;
      occurredAt: number;
      operationId: string;
      sessionKey: string;
    };
    await storageService.recordHidden({
      videoId: input.videoId,
      title: input.title,
      channelId: input.channelId,
      channelName: input.channelName,
      surface: input.surface as ReviewSummary['surfaces'][number],
      decision: input.decision,
      occurredAt: input.occurredAt,
      operationId: input.operationId,
      sessionKey: input.sessionKey,
    });
    return true;
  },
  'correction:get': async (payload) => {
    const { videoId } = payload as { videoId: string | undefined };
    return storageService.getCorrectionSignals(videoId);
  },
  // N08: content scripts never touch IDB (04 §6); the fingerprint-keyed
  // classification cache is background-owned. The content side sends RAW
  // evidence inputs only — the background derives fingerprints and keys.
  // Hardening: alignment is preserved per slot (an invalid input is a miss
  // in ITS slot, never a shift); invalid entries are skipped on put.
  'classification:getMany': async (payload) => {
    const { inputs } = payload as { inputs: unknown[] };
    const slots = inputs.map(toFingerprintInputOrNull);
    const present = slots.filter((s) => s !== undefined);
    if (present.length === 0) return slots.map(() => undefined);
    const hits = await storageService.getCachedClassifications(present, RULES_VERSION);
    const out: Array<Classification | undefined> = [];
    let k = 0;
    for (const slot of slots) {
      out.push(slot === undefined ? undefined : hits[k++]);
    }
    return out;
  },
  'classification:putMany': async (payload) => {
    const { inputs, classifications } = payload as {
      inputs: unknown[];
      classifications: Classification[];
    };
    if (inputs.length !== classifications.length) return false;
    // Keys are re-derived HERE from the SAME validated raw input, so a put
    // can never attach a classification to a different video's fingerprint.
    const pairs: Array<{
      input: NonNullable<ReturnType<typeof toFingerprintInputOrNull>>;
      classification: Classification;
    }> = [];
    inputs.forEach((input, i) => {
      const parsed = toFingerprintInputOrNull(input);
      if (
        parsed !== undefined &&
        typeof classifications[i] === 'object' &&
        classifications[i] !== null
      ) {
        pairs.push({ input: parsed, classification: classifications[i]! });
      }
    });
    if (pairs.length === 0) return false;
    await storageService.putCachedClassifications(
      pairs.map((p) => p.input),
      pairs.map((p) => p.classification),
      RULES_VERSION,
    );
    return true;
  },
  'correction:set': async (payload) => {
    const { videoId, dimension, value } = payload as {
      videoId: string;
      dimension: 'notAi' | 'notSlop';
      value: boolean;
    };
    return storageService.setCorrection(videoId, dimension, value);
  },
  'history:clear': async () => {
    await storageService.clearHistory(); // corrections survive (R11)
  },
  // DATA-08: each data class clears separately.
  'data:clear-cache': async () => {
    await storageService.clearCache();
  },
  'data:clear-corrections': async () => {
    await storageService.clearCorrections();
  },
  'data:reset-stats': async () => {
    await storageService.resetStats();
  },
  'history:count': async () => storageService.countSummaries(),
  'diagnostics:quarantine': async () => storageService.listQuarantine(),
  'tabs:rescanAll': async () => {
    try {
      const tabs = await browser.tabs.query({ url: '*://*.youtube.com/*' });
      for (const tab of tabs) {
        if (tab.id !== undefined) {
          void browser.tabs.sendMessage(tab.id, { type: 'orchestrator:rescan' }).catch(() => {});
        }
      }
    } catch {
      // Ignored if query fails
    }
    return true;
  },

  // V6-03/07: the onboarding page records completion (and the optional
  // LOCAL-ONLY discovery answer) through the background so the durable state
  // stays in one place. The answer is never sent anywhere else.
  'onboarding:get': async () => onboardingStore.load(),
  'onboarding:complete': async (payload) => {
    const { discoverySource } = (payload ?? {}) as {
      discoverySource?: DiscoverySource;
    };
    if (discoverySource !== undefined) {
      await onboardingStore.setDiscoverySource(discoverySource);
    }
    await onboardingStore.markCompleted();
    return true;
  },

  // V6-11: day-bucketed observations (identity-deduplicated per local day).
  'stats:dailyRecord': async (payload) => {
    const { outcome, videoId, signature, observedAt } = payload as {
      outcome: 'hide' | 'warn';
      videoId: string | undefined;
      signature: string;
      observedAt: number;
    };
    await dailyStatsStore.record(outcome, videoId, signature, observedAt);
    return true;
  },
  // V6-11 audit A1: the state contains Set objects which do NOT survive the
  // JSON message channel — always serialize (sets→arrays) across the wire.
  'stats:dailyGet': async () => serializeDailyStats(await dailyStatsStore.summary()),
  'stats:dailyReset': async () => {
    await dailyStatsStore.reset();
    return true;
  },

  // V7-07: local miss-review diagnostics. Recording is fire-and-forget from
  // the pipeline; a failed write degrades the DIAGNOSTIC only — it must never
  // affect decisions or presentation. Export is explicit user action only.
  'miss-review:record': async (payload) => {
    const input = payload as {
      videoId?: string;
      title: string;
      channelName?: string;
      surface: string;
      reason:
        | 'no-evidence'
        | 'below-threshold'
        | 'category-warn'
        | 'explicit-allow'
        | 'unsupported-surface'
        | 'unresolved-identity'
        | 'error';
      seenAt: number;
      note?: string;
    };
    await missReviewStore.record({ ...input, videoId: input.videoId ?? undefined });
    return true;
  },
  'miss-review:list': async () => ({ entries: await missReviewStore.list() }),
  'miss-review:clear': async () => {
    await missReviewStore.clear();
    return true;
  },
  'miss-review:export': async () => await missReviewStore.exportForUser(),
};

// DATA-15 + N07: the background is a security boundary. Messages must come
// from this extension's own contexts, pass structural + per-type schema
// validation, and respect sender-role separation before dispatch.
function senderIsInternal(sender: browser.runtime.MessageSender): boolean {
  return sender.id === browser.runtime.id;
}

/**
 * N07 sender roles: `sender.url` distinguishes extension pages (options/
 * popup, MOZ-/chrome-extension:// origin) from content scripts (page origin).
 * Content scripts form the untrusted side (they run against youtube.com).
 */
function roleOf(sender: browser.runtime.MessageSender): MessageRole {
  const url = sender.url ?? '';
  if (
    url.startsWith(`chrome-extension://${sender.id ?? ''}/`) ||
    url.startsWith(`moz-extension://${sender.id ?? ''}/`)
  ) {
    return 'page';
  }
  return 'content';
}

browser.runtime.onMessage.addListener((request: unknown, sender) => {
  if (!senderIsInternal(sender)) {
    logger.warn('rejected message from external sender');
    return Promise.resolve({ error: 'external sender rejected' });
  }
  const validation = validateMessageRequest(request);
  if (!validation.ok) {
    logger.warn('rejected message:', validation.reason);
    return Promise.resolve({ error: validation.reason });
  }
  const message = request as MessageRequest;
  const role = roleOf(sender);
  if (!roleMayInvoke(role, message.type)) {
    logger.warn('rejected message for role:', role, message.type);
    return Promise.resolve({ error: 'message type not allowed for sender role' });
  }
  const handler = handlers[message.type];
  if (handler === undefined) return undefined;
  return handler(message.payload).catch((error: unknown) => {
    logger.error('message handler failed', message.type, error);
    return { error: String(error) };
  });
});

wireOnboardingOpener(browser, () => browser.runtime.getURL('/onboarding.html'), {
  onboarding: onboardingStore,
});

browser.runtime.onInstalled.addListener(() => {
  void (async () => {
    await runMigrations(kv);
    const { settings } = await settingsStore.load(); // creates first-install defaults
    await storageService.ensureMigration();
    await storageService.enforceRetention(settings.history.retentionDays);
    logger.debug('installed: defaults ensured');
  })();
});

browser.runtime.onStartup.addListener(() => {
  void (async () => {
    await runMigrations(kv);
    await storageService.ensureMigration();
    const { settings } = await settingsStore.load();
    await storageService.enforceRetention(settings.history.retentionDays);
  })();
});

const HIDE_VIDEO_ID = 'bts-hide-video';
const BLOCK_CHANNEL_ID = 'bts-block-channel';
const WHY_INSPECTOR_ID = 'bts-why-inspector';
const REPORT_MISS_ID = 'bts-report-miss';

void browser.contextMenus.removeAll().then(() => {
  browser.contextMenus.create({
    id: HIDE_VIDEO_ID,
    title: 'Hide this video with BlockTheSlop',
    contexts: ['link', 'image'],
    targetUrlPatterns: [
      '*://*.youtube.com/watch*',
      '*://*.youtube.com/shorts*',
      '*://*.youtube.com/live*',
      '*://*.youtube.com/@*',
      '*://*.youtube.com/channel/*',
      '*://i.ytimg.com/*',
    ],
    documentUrlPatterns: ['*://*.youtube.com/*'],
  });
  browser.contextMenus.create({
    id: BLOCK_CHANNEL_ID,
    title: 'Block this channel with BlockTheSlop',
    contexts: ['link', 'image'],
    targetUrlPatterns: [
      '*://*.youtube.com/watch*',
      '*://*.youtube.com/shorts*',
      '*://*.youtube.com/live*',
      '*://*.youtube.com/@*',
      '*://*.youtube.com/channel/*',
      '*://i.ytimg.com/*',
    ],
    documentUrlPatterns: ['*://*.youtube.com/*'],
  });
  // V7-06: "Why is this still showing?" — selected-video inspector. Page-level
  // action (no target URL needed) so it is reachable on ANY card element.
  browser.contextMenus.create({
    id: WHY_INSPECTOR_ID,
    title: 'Why is this still showing?',
    contexts: ['page', 'link', 'image'],
    documentUrlPatterns: ['*://*.youtube.com/*'],
  });
  // V7-07: deliberate miss report. Applies a block-video rule (user intent)
  // and records a LOCAL diagnostic — never training, never network.
  browser.contextMenus.create({
    id: REPORT_MISS_ID,
    title: 'Report missed AI video (hide and diagnose locally)',
    contexts: ['page', 'link', 'image'],
    documentUrlPatterns: ['*://*.youtube.com/*'],
  });
});

browser.contextMenus.onClicked.addListener((info, tab) => {
  if (tab?.id === undefined) return;
  if (info.menuItemId === HIDE_VIDEO_ID) {
    void browser.tabs
      .sendMessage(tab.id, {
        type: 'context:hideVideo',
        payload: { linkUrl: info.linkUrl, srcUrl: info.srcUrl },
      })
      .catch(() => {});
  } else if (info.menuItemId === BLOCK_CHANNEL_ID) {
    void browser.tabs
      .sendMessage(tab.id, {
        type: 'context:blockChannel',
        payload: { linkUrl: info.linkUrl, srcUrl: info.srcUrl },
      })
      .catch(() => {});
  } else if (info.menuItemId === WHY_INSPECTOR_ID) {
    void browser.tabs
      .sendMessage(tab.id, { type: 'context:whyInspector', payload: {} })
      .catch(() => {});
  } else if (info.menuItemId === REPORT_MISS_ID) {
    void browser.tabs
      .sendMessage(tab.id, { type: 'context:reportMiss', payload: {} })
      .catch(() => {});
  }
});

// Debug logging can be toggled via storage for support workflows.
void kv.get<boolean>('local:debugEnabled').then((value) => {
  setDebugEnabled(value === true);
});
