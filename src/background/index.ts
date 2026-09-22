import { BrowserKVStore } from '@/storage/db';
import { SettingsStore } from '@/storage/settings-store';
import { RuleStore } from '@/storage/rule-store';
import { StatsStore } from '@/storage/stats-store';
import { StorageService } from '@/storage/service';
import { runMigrations } from '@/storage/migrations';
import { validateReviewRecords, type ReviewRecord } from '@/domain/review';
import type { ReviewSummary } from '@/domain/history';
import type { FilterDecision } from '@/domain/decision';
import { STORAGE_KEYS } from '@/storage/keys';
import { logger, setDebugEnabled } from '@/shared/logger';
import { validateMessageRequest } from '@/background/message-validation';

// Service workers are ephemeral: settings/rules stay in storage.local;
// durable history/corrections/cache live in extension-origin IndexedDB (R10).
const kv = new BrowserKVStore();
const settingsStore = new SettingsStore(kv);
const ruleStore = new RuleStore(kv);
const statsStore = new StatsStore(kv);
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
    return storageService.markRestored(key);
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
};

// DATA-15: the background is a security boundary. Messages must come from
// this extension's own contexts and be structurally sane before dispatch.
function senderIsInternal(sender: browser.runtime.MessageSender): boolean {
  return sender.id === browser.runtime.id;
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
  const handler = handlers[message.type];
  if (handler === undefined) return undefined;
  return handler(message.payload).catch((error: unknown) => {
    logger.error('message handler failed', message.type, error);
    return { error: String(error) };
  });
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

// Debug logging can be toggled via storage for support workflows.
void kv.get<boolean>('local:debugEnabled').then((value) => {
  setDebugEnabled(value === true);
});
