import { defineContentScript } from 'wxt/utils/define-content-script';
import { BrowserKVStore } from '@/storage/db';
import { SettingsStore } from '@/storage/settings-store';
import { RuleStore } from '@/storage/rule-store';
import { StatsStore } from '@/storage/stats-store';
import { FilterOrchestrator, type OrchestratorDeps } from '@/pipeline/orchestrator';
import {
  setPresentationCallbacks,
  applyPresentationPreferences,
} from '@/presentation/apply-decision';
import { cleanupAll } from '@/presentation/cleanup';
import { normalizeHandle } from '@/domain/video';
import type { FilterDecision } from '@/domain/decision';
import type { NormalizedVideoCandidate } from '@/domain/video';
import { logger } from '@/shared/logger';

/**
 * Content-script storage boundary (04 §6): content scripts never touch
 * IndexedDB (page-origin risk). Corrections and durable history go through
 * typed background messages; settings/rules remain on storage.local.
 */
function sendBackground<T>(type: string, payload?: unknown): Promise<T> {
  return browser.runtime.sendMessage({ type, payload }) as Promise<T>;
}

export default defineContentScript({
  matches: ['*://*.youtube.com/*'],
  runAt: 'document_idle',
  main() {
    const kv = new BrowserKVStore();
    const settingsStore = new SettingsStore(kv);
    const ruleStore = new RuleStore(kv);
    const statsStore = new StatsStore(kv);

    let settingsCache: Awaited<ReturnType<typeof settingsStore.load>>['settings'] | null = null;
    let rulesCache: Awaited<ReturnType<typeof ruleStore.load>> | null = null;

    const decisionByElement = new WeakMap<
      Element,
      { decision: FilterDecision; candidate: NormalizedVideoCandidate }
    >();

    const deps: OrchestratorDeps = {
      getSettings: async () => {
        settingsCache ??= (await settingsStore.load()).settings;
        applyPrefs(settingsCache);
        return settingsCache;
      },
      getRules: async () => {
        rulesCache ??= await ruleStore.load();
        return rulesCache;
      },
      // The fingerprint cache is background-owned (04 §6); the content script
      // treats it as a miss — classification is local and fast.
      getCachedClassification: async () => undefined,
      putCachedClassification: async () => undefined,
      getCorrections: async (videoId) => {
        if (videoId === undefined) return { notAi: false, notSlop: false };
        try {
          return await sendBackground<{ notAi: boolean; notSlop: boolean }>('correction:get', {
            videoId,
          });
        } catch {
          return { notAi: false, notSlop: false };
        }
      },
      addReviewRecord: async () => {
        // Legacy local review records are superseded by the durable
        // background-owned history (R10); recordHiddenDurable above is the
        // single write path so the review UI never shows duplicate rows.
      },
      // Durable hide history via the background worker (content never
      // touches IDB — page-origin risk, 04 §6). Idempotency key is generated
      // BEFORE the send so retries cannot double-count.
      recordHiddenDurable: async ({ candidate, decision, sessionKey, operationId }) => {
        await sendBackground('history:record', {
          videoId: candidate.videoId,
          title: candidate.title,
          channelId: candidate.channel.channelId,
          channelName: candidate.channel.displayName,
          surface: candidate.surface,
          decision,
          occurredAt: candidate.observedAt,
          operationId: `c:${operationId}`,
          sessionKey,
        }).catch((error: unknown) => logger.error('history:record failed', error));
      },
      applyStats: async (delta) => {
        await statsStore.apply(delta);
      },
      isRemoteProviderEnabled: () => false,
    };

    const orchestrator = new FilterOrchestrator(deps);

    // Page-level presentation preferences (CFG-10); applied on load and on
    // every settings change.
    const applyPrefs = (s: {
      density: 'comfortable' | 'compact';
      theme: 'system' | 'light' | 'dark';
    }): void => applyPresentationPreferences({ density: s.density, theme: s.theme });

    orchestrator.onDecisionApplied = (element, decision, candidate) => {
      decisionByElement.set(element, { decision, candidate });
    };

    setPresentationCallbacks({
      showOnce: (element) => {
        orchestrator.showOnce(element);
      },
      why: (element) => {
        const stored = decisionByElement.get(element);
        if (stored === undefined) return;
        orchestrator.why(element, stored.decision, stored.candidate);
      },
      allowVideo: (candidate) => {
        void (async () => {
          if (candidate.videoId !== undefined) {
            await ruleStore.apply({ kind: 'allow-video', videoId: candidate.videoId });
            rulesCache = null;
            orchestrator.rescan();
          }
        })();
      },
      allowChannel: (candidate) => {
        void (async () => {
          const channelId = candidate.channel.channelId;
          const handle = normalizeHandle(candidate.channel.handle);
          if (channelId !== undefined) {
            await ruleStore.apply({
              kind: 'allow-channel',
              channelId,
              ...(handle !== undefined ? { handle } : {}),
            });
          } else if (handle !== undefined) {
            await ruleStore.apply({ kind: 'allow-channel-by-handle', handle });
          }
          rulesCache = null;
          orchestrator.rescan();
          logger.debug('channel allowed');
        })();
      },
    });

    let rescanQueued = false;
    const queueRescan = (): void => {
      if (rescanQueued) return;
      rescanQueued = true;
      queueMicrotask(() => {
        rescanQueued = false;
        if (settingsCache !== null && !settingsCache.enabled) {
          cleanupAll();
          return;
        }
        orchestrator.rescan();
      });
    };

    settingsStore.watch((next) => {
      const previous = settingsCache;
      settingsCache = next;
      // CFG-02: any setting that can change a decision or its presentation
      // triggers a live rescan; the orchestrator drops stale async work so no
      // stale application races the new settings.
      applyPrefs(next);
      const relevant =
        previous === null ||
        previous.enabled !== next.enabled ||
        previous.mode !== next.mode ||
        previous.displayMode !== next.displayMode ||
        previous.density !== next.density ||
        previous.showExplanations !== next.showExplanations ||
        previous.shortsGuard.enabled !== next.shortsGuard.enabled ||
        previous.performance.preset !== next.performance.preset ||
        previous.rulePacks.fil !== next.rulePacks.fil ||
        JSON.stringify(previous.categoryActions) !== JSON.stringify(next.categoryActions) ||
        JSON.stringify(previous.surfaces) !== JSON.stringify(next.surfaces);
      if (relevant) queueRescan();
    });

    ruleStore.watch?.(() => {
      rulesCache = null;
      queueRescan();
    });

    orchestrator.start();
  },
});
