import { defineContentScript } from 'wxt/utils/define-content-script';
import { chunkedGet, chunkedPut } from './cache-client';
import { BrowserKVStore } from '@/storage/db';
import { SettingsStore } from '@/storage/settings-store';
import { RuleStore } from '@/storage/rule-store';
import { StatsStore } from '@/storage/stats-store';
import { AutoChannelStore } from '@/storage/auto-channel-store';
import {
  FilterOrchestrator,
  type NormalizedCached,
  type OrchestratorDeps,
} from '@/pipeline/orchestrator';
import {
  setPresentationCallbacks,
  applyPresentationPreferences,
  restore,
  stampIsCurrent,
  identityStillMatches,
  announcePersistenceError as announcePersistenceErrorUi,
} from '@/presentation/apply-decision';
import { HideActivityNotice } from '@/presentation/activity';
import { sessionRecovery } from '@/presentation/session-recovery';
import { cleanupAll } from '@/presentation/cleanup';
import { normalizeHandle, identityOf } from '@/domain/video';
import type { FilterDecision } from '@/domain/decision';
import type { NormalizedVideoCandidate } from '@/domain/video';
import { SETTINGS_EFFECT_KEYS, type UserSettings } from '@/domain/settings';
import { logger } from '@/shared/logger';
import { cardKindOf, parseDiscovered } from '@/youtube/discover';
import { SELECTORS } from '@/youtube/selectors';
import { ensureChannelPageAffordance } from '@/presentation/channel-affordance';
import { showChannelChoiceNotice } from '@/presentation/channel-choice-notice';
import { showWhyInspector, hideWhyInspector } from '@/presentation/why-inspector';
import { currentPageContext, pageContextFromUrl } from '@/youtube/routes';
import type { RuleMutation } from '@/domain/rules';

/**
 * Content-script storage boundary (04 §6): content scripts never touch
 * IndexedDB (page-origin risk). Corrections and durable history go through
 * typed background messages; settings/rules remain on storage.local.
 */
/**
 * Send a typed message to the background worker. N01/N17: the background
 * signals handler failure as `{error}` — that shape is decoded and THROWN so
 * callers (especially the durable-hide precommit) observe the failure instead
 * of a silent false success. Context-invalidated disconnects surface as a
 * typed error callers can distinguish from a storage failure.
 */
async function sendBackground<T>(type: string, payload?: unknown): Promise<T> {
  let response: unknown;
  try {
    response = await browser.runtime.sendMessage({ type, payload });
  } catch (error) {
    throw new ContextInvalidatedError(error instanceof Error ? error.message : String(error));
  }
  if (
    typeof response === 'object' &&
    response !== null &&
    'error' in response &&
    (response as { error?: unknown }).error !== undefined
  ) {
    throw new Error(String((response as { error: unknown }).error));
  }
  return response as T;
}

/** The extension context died (reload/update) while a call was in flight. */
export class ContextInvalidatedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ContextInvalidatedError';
  }
}

/** True when an error/throw value means the extension context is gone. */
export function isContextInvalidated(error: unknown): boolean {
  if (error instanceof ContextInvalidatedError) return true;
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes('Extension context invalidated') ||
    message.includes('Extension context(s) invalidated') ||
    message.includes('context invalidated')
  );
}

/**
 * N17: poll the context liveness until it dies. When the extension is
 * reloaded/updated, ANY browser.runtime call starts throwing —
 * `getManifest()` is a synchronous call guaranteed to reject on an invalid
 * context. Cheap while alive (2s interval, one sync call); the callback tears
 * the content script down exactly once.
 */
async function safeContextCheck(onInvalidated: () => void): Promise<void> {
  for (;;) {
    await new Promise((r) => setTimeout(r, 2_000));
    try {
      browser.runtime.getManifest();
    } catch {
      onInvalidated();
      return;
    }
  }
}

/** N17: visible, non-destructive notice that filtering stopped and how to fix it. */
function announceContextInvalidated(): void {
  try {
    const notice = document.createElement('div');
    notice.className = 'bts-status bts-context-invalidated';
    notice.setAttribute('role', 'alert');
    notice.textContent =
      'BlockTheSlop was reloaded or updated. Refresh this tab to resume filtering.';
    document.body.appendChild(notice);
  } catch {
    // Document gone (navigation during teardown): nothing to announce.
  }
}

/**
 * N01: non-destructive local error for a failed durable hide is rendered by
 * presentation/announcePersistenceError; this wrapper adds the console warning.
 */
function announcePersistenceError(element: Element): void {
  logger.warn('hide not applied: recovery record could not be persisted');
  announcePersistenceErrorUi(element);
}

export default defineContentScript({
  matches: ['*://*.youtube.com/*'],
  runAt: 'document_idle',
  main() {
    const kv = new BrowserKVStore();
    const settingsStore = new SettingsStore(kv);
    const ruleStore = new RuleStore(kv);
    const statsStore = new StatsStore(kv);
    const autoChannelStore = new AutoChannelStore(kv);

    let settingsCache: Awaited<ReturnType<typeof settingsStore.load>>['settings'] | null = null;
    let rulesCache: Awaited<ReturnType<typeof ruleStore.load>> | null = null;

    const decisionByElement = new WeakMap<
      Element,
      { decision: FilterDecision; candidate: NormalizedVideoCandidate }
    >();
    /** N02: content signature captured at apply time for identity-safe overrides. */
    const signatureByElement = new WeakMap<Element, string>();

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
      // N08: the fingerprint-keyed classification cache is background-owned
      // (04 §6) — raw evidence inputs out, classifications in. Chunked to the
      // wire limit (a 500-card grid must not trip MAX_BATCH_INPUTS and
      // degrade to all-misses); EVERY failure degrades to misses so a
      // background outage can only cost speed, never correctness.
      getCachedClassifications: async (inputs) =>
        chunkedGet(inputs, (chunk) =>
          sendBackground<NormalizedCached[]>('classification:getMany', { inputs: [...chunk] }),
        ),
      putCachedClassifications: async (inputs, classifications) =>
        chunkedPut(inputs, classifications, (chunk, classes) =>
          sendBackground('classification:putMany', {
            inputs: [...chunk],
            classifications: [...classes],
          }),
        ),
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
      // V7-07: local miss-review diagnostics — best-effort, never load-bearing.
      recordMissReview: async (input) => {
        await sendBackground('miss-review:record', input);
      },
      // N01 durable-hide precommit: errors PROPAGATE — the orchestrator
      // fails open (card stays visible) and surfaces a local error instead
      // of hiding without a recovery record.
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
        });
      },
      applyStats: async (delta) => {
        await statsStore.apply(delta);
      },
      // V6-11: durable day-bucketed stats are background-owned (same read-
      // modify-write as history) so concurrent tabs aggregate without lost
      // or double counts. Fire-and-forget at the call site.
      recordDailyStat: async (input) => {
        await sendBackground('stats:dailyRecord', {
          outcome: input.outcome,
          videoId: input.videoId,
          signature: input.signature,
          observedAt: input.observedAt,
        });
      },
      isRemoteProviderEnabled: () => false,
      getActiveAutoChannels: async () => autoChannelStore.getActiveBlockedChannelIds(),
      recordAutoChannelCandidate: async ({
        channelId,
        handle,
        displayName,
        videoId,
        classification,
      }) => {
        const rules = rulesCache ?? (await ruleStore.load());
        const settings = settingsCache ?? (await settingsStore.load()).settings;
        const res = await autoChannelStore.recordCandidateVideo({
          channelId,
          handle,
          displayName,
          videoId,
          classification,
          settings,
          rules,
        });
        if (res.promoted) {
          rulesCache = null;
          orchestrator.verdictMemo.invalidate();
          orchestrator.rescan();
          void sendBackground('tabs:rescanAll').catch(() => {});
        }
      },
    };

    const orchestrator = new FilterOrchestrator(deps);
    const activity = new HideActivityNotice();
    // V7-04: every recovery reveal validates — at click time — that the
    // element still holds the content the hide decision belongs to. A
    // recycled element is UN-WEDGED (plain restore, no show-once override):
    // its current content was never decided on, so it must be visible and
    // re-evaluated fresh; granting it the old override would skip that.
    const validatedRestore = (el: Element, sig: string) => {
      if (identityStillMatches(el, sig)) {
        orchestrator.showOnce(el, sig);
      } else {
        restore(el);
      }
      activity.scheduleUpdate();
    };
    activity.onRestore = validatedRestore;

    /** Apply a rule mutation, then invalidate caches and rescan everywhere. */
    const applyRuleAndRescan = async (mutation: RuleMutation): Promise<void> => {
      await ruleStore.apply(mutation);
      rulesCache = null;
      orchestrator.verdictMemo.invalidate();
      orchestrator.rescan();
      void sendBackground('tabs:rescanAll').catch(() => {});
    };
    activity.onBlockChannel = (item) => {
      void showChannelChoiceNotice({
        videoId: item.videoId ?? '',
        channelId: item.channelId,
        handle: item.handle,
        displayName: item.channelName,
        videoTitle: item.title,
        ruleStore,
        onBlockSuccess: () => {
          rulesCache = null;
          orchestrator.verdictMemo.invalidate();
          orchestrator.rescan();
          void sendBackground('tabs:rescanAll').catch(() => {});
        },
        onUndoSuccess: () => {
          rulesCache = null;
          orchestrator.verdictMemo.invalidate();
          orchestrator.rescan();
          void sendBackground('tabs:rescanAll').catch(() => {});
        },
      });
    };
    const hiddenByElement = new WeakMap<Element, boolean>();
    const tryEnsureChannelAffordance = () => {
      const page = currentPageContext();
      if (page.surface === 'channel') {
        ensureChannelPageAffordance(document, ruleStore, () => {
          rulesCache = null;
          orchestrator.verdictMemo.invalidate();
          orchestrator.rescan();
          void sendBackground('tabs:rescanAll').catch(() => {});
        });
      }
    };

    const activityListeners = new AbortController();
    for (const eventName of ['wxt:locationchange', 'popstate', 'yt-navigate-finish']) {
      window.addEventListener(
        eventName,
        () => {
          activity.clear();
          sessionRecovery.clear();
          tryEnsureChannelAffordance();
        },
        {
          signal: activityListeners.signal,
        },
      );
    }
    tryEnsureChannelAffordance();

    // Page-level presentation preferences (CFG-10); applied on load and on
    // every settings change. Audit M1: memoized on the pref key — getSettings
    // runs per processing batch, and re-writing theme attributes + toggling
    // chip classes + scheduling a rAF on EVERY call was pure waste.
    let lastPrefsKey = '';
    const applyPrefs = (s: {
      density: 'comfortable' | 'compact';
      theme: 'system' | 'light' | 'dark';
      activityIndicator: {
        position: 'off' | 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';
      };
    }): void => {
      const key = `${s.density}\u0000${s.theme}\u0000${s.activityIndicator.position}`;
      if (key === lastPrefsKey) return;
      lastPrefsKey = key;
      applyPresentationPreferences({ density: s.density, theme: s.theme });
      activity.setPosition(s.activityIndicator.position);
    };

    orchestrator.onDecisionApplied = (element, decision, candidate, signature) => {
      // N02: the show-once override must survive recycling identity-safely,
      // so remember the CONTENT signature alongside the element.
      decisionByElement.set(element, { decision, candidate });
      signatureByElement.set(element, signature);
      const wasHidden = hiddenByElement.get(element) === true;
      const isHidden = decision.action === 'hide';
      hiddenByElement.set(element, isHidden);
      if (isHidden) {
        sessionRecovery.record(element, candidate, decision, signature);
      } else {
        sessionRecovery.removeByElement(element);
      }
      if (isHidden || wasHidden) {
        activity.scheduleUpdate();
      }
    };

    // N01: a hide whose recovery record failed to persist must fail OPEN —
    // the card stays visible and the failure is visible locally. N17: a
    // context invalidation is NOT a storage failure — it means the whole
    // extension went away; the teardown path handles the announcement, so
    // only the silent restore happens here.
    orchestrator.onHidePersistenceFailed = (element, decision, candidate, error) => {
      restore(element);
      if (!isContextInvalidated(error)) announcePersistenceError(element);
    };

    setPresentationCallbacks({
      showOnce: (element) => {
        orchestrator.showOnce(element, signatureByElement.get(element));
        activity.scheduleUpdate();
      },
      why: (element) => {
        const stored = decisionByElement.get(element);
        if (stored === undefined) return;
        orchestrator.why(element, stored.decision, stored.candidate);
      },
      allowVideo: (candidate, element) => {
        void (async () => {
          // N02: a click on a recycled element must not act on the stale video.
          if (element !== undefined && !stampIsCurrent(element, candidate)) return;
          if (candidate.videoId !== undefined) {
            await ruleStore.apply({ kind: 'allow-video', videoId: candidate.videoId });
            rulesCache = null;
            orchestrator.rescan();
          }
        })();
      },
      allowChannel: (candidate, element) => {
        void (async () => {
          // N02: same freshness guard as allowVideo.
          if (element !== undefined && !stampIsCurrent(element, candidate)) return;
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

    // The browser's native right-click menu asks this tab to act on the most
    // recently right-clicked card. Reparse at click time so recycled cards
    // cannot apply a block to the wrong video.
    let contextTarget: {
      element: Element;
      videoId?: string | undefined;
      channelId?: string | undefined;
      handle?: string | undefined;
      displayName?: string | undefined;
      /** V7-06: identity signature at right-click time for stale checks. */
      signature: string;
      at: number;
    } | null = null;
    document.addEventListener('contextmenu', (event) => {
      contextTarget = null;
      const target = event.target;
      if (!(target instanceof Element)) return;
      const selector = [
        ...SELECTORS.lockup,
        'ytd-compact-video-renderer',
        'ytd-reel-item-renderer',
        'ytm-shorts-lockup-view-model',
      ].join(',');
      const element = target.closest(selector);
      if (element === null) return;
      const candidate = parseDiscovered(
        { element, kind: cardKindOf(element) },
        'unknown',
        Date.now(),
      );
      contextTarget = {
        element,
        videoId: candidate.videoId,
        channelId: candidate.channel.channelId,
        handle: candidate.channel.handle,
        displayName: candidate.channel.displayName,
        signature: identityOf(candidate),
        at: Date.now(),
      };
    });
    browser.runtime.onMessage.addListener((request: unknown) => {
      if (typeof request !== 'object' || request === null || !('type' in request)) return;
      const msg = request as { type: string; payload?: unknown };

      if (msg.type === 'session:listHides') {
        return Promise.resolve({ hides: sessionRecovery.list() });
      }
      if (msg.type === 'orchestrator:status') {
        // V6-08: the popup's active-tab status. Computed from LIVE page state
        // (same sources as the on-page chip): surface from the current URL,
        // DISTINCT hidden video identities currently suppressed. No blind
        // "connected" — an unanswered send IS the unavailable state.
        const ids = new Set<string>();
        for (const card of document.querySelectorAll(
          '[data-bts-state="hidden"], [data-bts-collapse]',
        )) {
          const id = card.getAttribute('data-bts-video-id');
          if (id) ids.add(id);
        }
        const { surface } = pageContextFromUrl(location.href);
        return Promise.resolve({
          state: settingsCache?.enabled === false ? 'paused' : 'active',
          surface,
          distinctHidden: ids.size,
          collectLocalStats: settingsCache?.collectLocalStats ?? true,
        });
      }
      if (msg.type === 'session:restore') {
        const payload = msg.payload as { id: string } | undefined;
        if (payload?.id) {
          const entry = sessionRecovery.list().find((item) => item.id === payload.id);
          const ok = sessionRecovery.restore(payload.id, validatedRestore);
          // Audit A3: record the daily restore outcome (fire-and-forget).
          if (ok && settingsCache?.collectLocalStats) {
            void sendBackground('stats:dailyRecord', {
              outcome: 'restore' as const,
              videoId: entry?.videoId,
              signature: entry?.id ?? payload.id,
              observedAt: Date.now(),
            }).catch(() => undefined);
          }
          return Promise.resolve({ restored: ok });
        }
        return Promise.resolve({ restored: false });
      }

      if (msg.type === 'orchestrator:rescan') {
        rulesCache = null;
        orchestrator.verdictMemo.invalidate();
        queueRescan();
        return Promise.resolve(true);
      }

      if (msg.type === 'context:reportMiss') {
        // V7-07: deliberate "this is AI and the filter missed it" mark. TWO
        // effects, strictly separated: (1) a deliberate block-video rule the
        // user asked for; (2) a LOCAL diagnostic explaining why the automatic
        // filter passed. The mark never trains detection, never promotes a
        // channel, never touches the network.
        const selected = contextTarget;
        contextTarget = null;
        if (selected === null || Date.now() - selected.at > 30_000 || !selected.element.isConnected)
          return Promise.resolve({ error: 'stale-or-unconnected' });
        const current = parseDiscovered(
          { element: selected.element, kind: cardKindOf(selected.element) },
          'unknown',
          Date.now(),
        );
        if (selected.videoId && current.videoId !== selected.videoId)
          return Promise.resolve({ error: 'recycled' });
        const videoId = current.videoId ?? selected.videoId;
        if (!videoId) return Promise.resolve({ error: 'no-video-id' });
        void (async () => {
          const settingsNow = settingsCache ?? (await settingsStore.load()).settings;
          const surfaceNow = currentPageContext().surface;
          await orchestrator.recordMissForCandidate(
            selected.element,
            surfaceNow,
            settingsNow,
            undefined,
            {
              action: 'allow',
              reason: 'automatic',
              explanation: ['Marked by you as a missed AI video.'],
            },
          );
        })().catch(() => undefined);
        return ruleStore
          .apply({ kind: 'block-video', videoId })
          .then(() => {
            rulesCache = null;
            orchestrator.verdictMemo.invalidate();
            orchestrator.rescan();
            void sendBackground('tabs:rescanAll').catch(() => {});
            return { success: true };
          })
          .catch((err) => ({ error: err instanceof Error ? err.message : String(err) }));
      }

      if (msg.type === 'context:whyInspector') {
        // V7-06: explain the SELECTED card. Same freshness discipline as the
        // other context actions: stale timestamp, detached element, or a
        // recycled card is rejected — the inspector never describes a
        // neighbor, the search box, or content the user did not select.
        const selected = contextTarget;
        contextTarget = null;
        if (selected === null || Date.now() - selected.at > 30_000 || !selected.element.isConnected)
          return Promise.resolve({ error: 'stale-or-unconnected' });
        const current = parseDiscovered(
          { element: selected.element, kind: cardKindOf(selected.element) },
          'unknown',
          Date.now(),
        );
        if (selected.videoId && current.videoId !== selected.videoId)
          return Promise.resolve({ error: 'recycled' });
        void orchestrator.explainCandidate(selected.element).then((report) => {
          if (report === null) return;
          showWhyInspector(report, {
            onHideVideo: () => {
              const videoId = current.videoId;
              if (videoId === undefined) return;
              hideWhyInspector();
              void applyRuleAndRescan({ kind: 'block-video', videoId });
            },
            onBlockChannel: () => {
              const channelId = current.channel.channelId;
              const handle = normalizeHandle(current.channel.handle);
              hideWhyInspector();
              void (async () => {
                if (channelId !== undefined) {
                  await applyRuleAndRescan({
                    kind: 'block-channel',
                    channelId,
                    ...(handle !== undefined ? { handle } : {}),
                    displayName: current.channel.displayName,
                    source: 'context-menu' as const,
                    reason: 'Blocked from the Why inspector',
                  });
                } else if (handle !== undefined) {
                  await applyRuleAndRescan({
                    kind: 'block-channel-by-handle',
                    handle,
                    displayName: current.channel.displayName,
                    source: 'context-menu' as const,
                    reason: 'Blocked from the Why inspector',
                  });
                }
              })();
            },
            onAddPhrase: (phrase) => {
              hideWhyInspector();
              void applyRuleAndRescan({ kind: 'block-phrase', phrase });
            },
            onClose: () => hideWhyInspector(),
          });
        });
        return Promise.resolve({ accepted: true });
      }

      if (msg.type === 'context:hideVideo') {
        const selected = contextTarget;
        contextTarget = null;
        if (selected === null || Date.now() - selected.at > 30_000 || !selected.element.isConnected)
          return Promise.resolve({ error: 'stale-or-unconnected' });
        const current = parseDiscovered(
          { element: selected.element, kind: cardKindOf(selected.element) },
          'unknown',
          Date.now(),
        );
        if (selected.videoId && current.videoId !== selected.videoId)
          return Promise.resolve({ error: 'recycled' });
        const videoId = current.videoId ?? selected.videoId;
        if (!videoId) return Promise.resolve({ error: 'no-video-id' });
        return ruleStore.apply({ kind: 'block-video', videoId }).then(() => {
          rulesCache = null;
          orchestrator.verdictMemo.invalidate();
          orchestrator.rescan();
          void sendBackground('tabs:rescanAll').catch(() => {});

          const channelId = current.channel.channelId ?? selected.channelId;
          const handle = current.channel.handle ?? selected.handle;
          const displayName = current.channel.displayName ?? selected.displayName;

          void showChannelChoiceNotice({
            videoId,
            channelId,
            handle,
            displayName,
            videoTitle: current.title,
            ruleStore,
            onBlockSuccess: () => {
              rulesCache = null;
              orchestrator.verdictMemo.invalidate();
              orchestrator.rescan();
              void sendBackground('tabs:rescanAll').catch(() => {});
            },
            onUndoSuccess: () => {
              rulesCache = null;
              orchestrator.verdictMemo.invalidate();
              orchestrator.rescan();
              void sendBackground('tabs:rescanAll').catch(() => {});
            },
          });

          return { success: true };
        });
      }

      if (msg.type === 'context:blockChannel') {
        const selected = contextTarget;
        contextTarget = null;
        if (selected === null || Date.now() - selected.at > 30_000 || !selected.element.isConnected)
          return Promise.resolve({ error: 'stale-or-unconnected' });
        const current = parseDiscovered(
          { element: selected.element, kind: cardKindOf(selected.element) },
          'unknown',
          Date.now(),
        );
        if (selected.videoId && current.videoId !== selected.videoId)
          return Promise.resolve({ error: 'recycled' });

        const channelId = current.channel.channelId ?? selected.channelId;
        const handle = current.channel.handle ?? selected.handle;

        // Never block by display name alone or without verified ID/handle
        if (!channelId && !handle) {
          announcePersistenceError(selected.element);
          return Promise.resolve({ error: 'no-channel-identity' });
        }

        let mutation: RuleMutation;
        if (channelId && channelId.startsWith('UC')) {
          mutation = {
            kind: 'block-channel',
            channelId,
            handle,
            displayName: current.channel.displayName ?? selected.displayName,
            source: 'context-menu',
            reason: `Blocked via right-click on "${current.title.slice(0, 40)}"`,
          };
        } else if (handle) {
          mutation = {
            kind: 'block-channel-by-handle',
            handle,
            displayName: current.channel.displayName ?? selected.displayName,
            source: 'context-menu',
            reason: `Blocked by handle @${handle}`,
          };
        } else {
          return Promise.resolve({ error: 'invalid-channel-id' });
        }

        return ruleStore
          .apply(mutation)
          .then(() => {
            rulesCache = null;
            orchestrator.verdictMemo.invalidate();
            orchestrator.rescan();
            void sendBackground('tabs:rescanAll').catch(() => {});
            return { success: true, channelId, handle };
          })
          .catch((err) => {
            announcePersistenceError(selected.element);
            return { error: err instanceof Error ? err.message : String(err) };
          });
      }
    });

    let rescanQueued = false;
    const queueRescan = (): void => {
      if (rescanQueued) return;
      rescanQueued = true;
      queueMicrotask(() => {
        rescanQueued = false;
        if (settingsCache !== null && !settingsCache.enabled) {
          cleanupAll();
          activity.clear();
          return;
        }
        orchestrator.rescan();
      });
    };

    const settingsUnwatch = settingsStore.watch((next) => {
      const previous = settingsCache;
      settingsCache = next;
      // CFG-02 + N04/N15: any setting that can change a decision or its
      // presentation triggers a live rescan. N04 blocker-4: presentation-only
      // keys (displayMode, showExplanations, density, theme) MUST also reach
      // open tabs — decision keys re-decide cards; presentation keys re-render
      // the already-mounted extension UI on them. The orchestrator drops
      // stale async work so no stale application races the new settings.
      applyPrefs(next);
      const relevant =
        previous === null ||
        (Object.keys(SETTINGS_EFFECT_KEYS) as (keyof UserSettings)[]).some((key) => {
          const effect = SETTINGS_EFFECT_KEYS[key];
          if (effect !== 'decision' && effect !== 'presentation') {
            // Unwired controls have no runtime effect (N04): no rescan.
            return false;
          }
          if (
            effect === 'presentation' &&
            (key === 'density' || key === 'theme' || key === 'activityIndicator')
          ) {
            return false; // applied directly via applyPrefs above
          }
          return JSON.stringify(previous[key]) !== JSON.stringify(next[key]);
        });
      if (relevant) queueRescan();
    });

    const ruleUnwatch = ruleStore.watch?.(() => {
      rulesCache = null;
      queueRescan();
    });

    orchestrator.start();

    // N17: the extension context can die while this tab lives on (reload,
    // update, disable-in-devtools). After invalidation, observers/storage
    // listeners keep firing into dead browser.* APIs, in-flight messages
    // reject with "Extension context invalidated", and hidden cards would be
    // stranded. Tear EVERYTHING down exactly once, restore presentation, and
    // show a one-line notice with the manual refresh path.
    let invalidated = false;
    const disposeWatches: Array<() => void> = [settingsUnwatch, ruleUnwatch];
    const onInvalidated = (): void => {
      if (invalidated) return;
      invalidated = true;
      // Every teardown step is individually guarded: after invalidation even
      // removeListener/disconnect can reject, and one throw must not strand
      // the rest of the cleanup.
      for (const dispose of disposeWatches) {
        try {
          dispose();
        } catch {
          // Already-invalidated listener: nothing left to remove.
        }
      }
      try {
        orchestrator.stop(); // disconnects observers, cancels in-flight work
      } catch {
        // Same as above.
      }
      cleanupAll(document); // no stranded hidden/warned cards
      activity.clear();
      activityListeners.abort();
      announceContextInvalidated();
    };

    void safeContextCheck(onInvalidated);
  },
});
