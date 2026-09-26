import type { FilterDecision } from '@/domain/decision';
import type { UserSettings } from '@/domain/settings';
import { getRuleIndex, normalizeFallbackHandle, type UserRules } from '@/domain/rules';
import type { NormalizedVideoCandidate } from '@/domain/video';

import type { DetectionContext } from '@/domain/evidence';
import { classificationFingerprint, shortHash, type RawCacheInput } from '@/storage/fingerprint';
import { CLASSIFIER_VERSION, RULES_VERSION } from '@/domain/versions';
import { classifyCandidate } from '@/detection/engine';
import { decide } from '@/policy/decide';
import { type Classification, classificationForCache } from '@/domain/classification';
import { VerdictMemoStore } from '@/storage/verdict-memo-store';
import { computeSettingsDigest, createVerdictMemoEntry } from '@/domain/verdict-memo';
import { applyDecision, restore, toggleWhyDetails } from '@/presentation/apply-decision';
import { restoreRecursively } from '@/presentation/cleanup';
import { identityOf } from '@/domain/video';
import {
  discoverCards,
  cardKindOf,
  parseDiscovered,
  parseDiscoveredFeedItem,
} from '@/youtube/discover';
import { ATTR_STATE } from '@/youtube/selectors';
import { currentPageContext, pageContextFromUrl } from '@/youtube/routes';
import { BatchingObserver } from '@/youtube/observer';
import { shouldProcess, bumpEpoch } from '@/youtube/identity';
import { classifyMiss } from '@/domain/miss-review';
import { ensureStyles } from '@/presentation/apply-decision';
import { pauseAndCoverShorts, removeShortsGuard } from '@/presentation/shorts-guard';
import { queueLimitsFor } from '@/domain/settings';
import { logger } from '@/shared/logger';

/** Storage/persistence ports the orchestrator needs. */
export interface OrchestratorDeps {
  getSettings(): Promise<UserSettings>;
  getRules(): Promise<UserRules>;
  /**
   * N08: fingerprint+version-keyed classification cache (R12), consumed in
   * one batched round-trip per batch. Implemented as an all-miss no-op in
   * tests; the content script degrades to all-misses when the background is
   * unreachable — a cache failure is NEVER a filtering failure.
   */
  getCachedClassifications(
    inputs: readonly RawCacheInput[],
    rulesVersion: string,
  ): Promise<Array<NormalizedCached | undefined>>;
  putCachedClassifications(
    inputs: readonly RawCacheInput[],
    classifications: readonly NormalizedCached[],
    rulesVersion: string,
  ): Promise<void>;
  getCorrections(videoId: string | undefined): Promise<{ notAi: boolean; notSlop: boolean }>;
  /**
   * V7-07: local miss-review diagnostics. OPTIONAL: when absent, the manual
   * "report a miss" action still applies its rule — the diagnostic is best-
   * effort and never load-bearing.
   */
  recordMissReview?(input: {
    videoId: string | undefined;
    title: string;
    channelName?: string | undefined;
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
    note?: string | undefined;
  }): Promise<void>;
  /** Durable event write with a caller-generated idempotency key (R10). */
  recordHiddenDurable?(input: {
    candidate: NormalizedVideoCandidate;
    decision: FilterDecision;
    sessionKey: string;
    operationId: string;
  }): Promise<void>;
  applyStats(delta: { cardsEvaluated?: number; hidden?: number; warned?: number }): Promise<void>;
  /**
   * V6-11: durable day-bucketed stat observation (identity-deduplicated per
   * local day). Optional: when absent (or when it rejects), lifetime counters
   * still work and filtering is unaffected — stats are never load-bearing.
   */
  recordDailyStat?(input: {
    outcome: 'hide' | 'warn';
    videoId: string | undefined;
    signature: string;
    observedAt: number;
  }): Promise<void>;
  isRemoteProviderEnabled(): boolean;
  /** Active automatic channel blocks (V5-08). */
  getActiveAutoChannels?(): Promise<ReadonlySet<string>>;
  /** Record candidate video to evaluate for channel suggestion or auto-promotion (V5-08). */
  recordAutoChannelCandidate?(candidate: {
    channelId: string;
    handle?: string | undefined;
    displayName?: string | undefined;
    videoId: string;
    classification: Classification;
  }): Promise<void>;
}

/** Minimal classification shape used for caching (evidence is re-derived). */
export type NormalizedCached = Awaited<ReturnType<typeof classifyCandidate>>;

/**
 * N08: the ONLY thing that may enter the pipeline from a cache slot. JSON
 * transports turn undefined slots into null and can carry junk; anything
 * that is not a classification-shaped object is a MISS. Feeding null into
 * decide() would throw and kill the whole batch.
 */
export function classificationFromSlot(slot: unknown): NormalizedCached | undefined {
  if (slot === null || typeof slot !== 'object') return undefined;
  const ai = (slot as { aiLikelihood?: unknown }).aiLikelihood;
  if (typeof ai !== 'number' || !Number.isFinite(ai)) return undefined;
  return slot as NormalizedCached;
}

/** Bounded RAW evidence input of a candidate (cache wire format, N08). */
function rawInputOf(
  candidate: NormalizedVideoCandidate,
  locale: string | undefined,
): RawCacheInput {
  return {
    videoId: candidate.videoId,
    title: candidate.title,
    description: candidate.description,
    badges: candidate.badges,
    ariaLabels: candidate.ariaLabels,
    metadataText: candidate.metadataText,
    officialDisclosurePresent: candidate.officialDisclosure?.present ?? false,
    isShort: candidate.isShort,
    locale: locale ?? '',
  };
}

/**
 * Show-once overrides, cleared on navigation (audit A09 scope). N02: an
 * override is scoped to the CONTENT the user revealed — keyed by evidence
 * signature. An element is only honored while it still holds exactly the
 * content that was shown (its recorded signature); recycling transfers the
 * element to other videos which are NOT covered by the override.
 */
const showOnceOverrides = new Map<Element, string>();

/**
 * The pipeline: discover → parse → classify → decide → present.
 * Every await re-checks the generation token; DOM mutation happens only after
 * a final identity/connection check (audit A05).
 */
export class FilterOrchestrator {
  private observer: BatchingObserver | null = null;
  private generation = 0;

  /** V5-03: Tier 2 automatic verdict memo */
  readonly verdictMemo = new VerdictMemoStore();
  /** V5-03: Session-scoped dedup of durable hides on current page (cleared on navigation) */
  private readonly recordedHidesOnPage = new Set<string>();
  /** V5-03: Session-scoped dedup of local stats on current page (cleared on navigation) */
  private readonly countedStatsOnPage = new Set<string>();

  /** Hook: notified after each applied decision (used for real Why records).
   * N02: also carries the content signature for identity-safe show-once. */
  onDecisionApplied?: (
    element: Element,
    decision: FilterDecision,
    candidate: NormalizedVideoCandidate,
    signature: string,
  ) => void = undefined;

  /** V5-03: Invalidate memo and session dedup for a video (e.g. on correction or allow) */
  invalidateVideo(videoId: string): void {
    this.verdictMemo.invalidateForCorrection(videoId);
    this.recordedHidesOnPage.delete(videoId);
    this.countedStatsOnPage.delete(videoId);
  }

  constructor(
    private readonly deps: OrchestratorDeps,
    private readonly getLocale: () => string | undefined = () =>
      document.documentElement.lang || undefined,
  ) {}

  /** In-flight work from the previous generation, for DOM-19 tests. */
  inFlight: Set<Promise<void>> = new Set();

  start(): void {
    ensureStyles();
    this.observer = new BatchingObserver(
      (roots) => {
        void this.processBatch(roots);
      },
      (url) => {
        this.onNavigation(url);
      },
      () => {
        void this.processBatch([document.body]);
      },
    );
    this.observer.start();
    // WXT locationchange fires reliably for SPA navigations (YouTube's SPA
    // pushes don't always emit popstate/yt-navigate-finish in fixtures).
    this.abortController = new AbortController();
    window.addEventListener(
      'wxt:locationchange' as keyof WindowEventMap,
      (() => {
        this.onNavigation(location.href);
      }) as EventListener,
      { signal: this.abortController.signal },
    );
  }

  private abortController: AbortController | null = null;

  stop(): void {
    this.observer?.stop();
    this.observer = null;
    this.abortController?.abort();
    this.abortController = null;
    this.generation += 1;
  }

  /**
   * Navigation invalidates in-flight work immediately and performs one scoped
   * rescan (audit A05/A08): reused DOM must be re-evaluated for the new
   * surface, and Show-once overrides expire with the page view.
   */
  private onNavigation(url: string): void {
    this.generation += 1;
    bumpEpoch();
    showOnceOverrides.clear(); // Show-once is page-view scoped.
    this.recordedHidesOnPage.clear(); // Session-scoped history dedup clears on navigation.
    this.countedStatsOnPage.clear();
    const { surface } = pageContextFromUrl(url);
    logger.debug('navigation', surface);
    void this.processBatch([document.body]);
  }

  /**
   * Active Shorts feed (R09/DOM-03): parse the CURRENT video from the URL,
   * never assigning the URL's id to preloaded sibling lockups. When the
   * Shorts guard is enabled and the active Short matches, pause and cover.
   */
  private async processActiveShorts(
    page: ReturnType<typeof pageContextFromUrl>,
    settings: UserSettings,
    rules: UserRules,
    context: DetectionContext,
    generation: number,
    currentUrl: string = location.href,
  ): Promise<void> {
    const candidate = parseDiscoveredFeedItem(document.body, page.surface, Date.now(), currentUrl);
    const signature = identityOf(candidate);
    // Feed guard keyed on the URL identity: reprocess when the active Short
    // changes (identityOf covers videoId/title/channel). The SAME Short is
    // re-guarded after navigation away and back — navigation bumps the
    // epoch, so a repeated visit consumes a fresh processing slot instead of
    // being suppressed by the earlier evaluation.
    if (!shouldProcess(document.documentElement, `shorts-feed:${signature}`)) {
      // Already evaluated this active Short; nothing to change.
      return;
    }
    if (generation !== this.generation) return;

    // N08: same fingerprint+version cache, one-element batch (raw inputs
    // only; keys are derived in the background/deps implementation).
    const rawInput = rawInputOf(candidate, context.locale);
    let classification: NormalizedCached | undefined;
    try {
      const [cached] = await this.deps.getCachedClassifications([rawInput], RULES_VERSION);
      // A null/malformed slot (JSON transport) is a miss, never a hit.
      classification = classificationFromSlot(cached);
    } catch {
      classification = undefined; // degradation: cache outage is not a filtering failure
    }
    if (classification === undefined) {
      classification = await classifyCandidate(candidate, context);
      // Cache stores the whitelisted projection (bounded payload).
      void this.deps
        .putCachedClassifications(
          [rawInput],
          [classificationForCache(classification)],
          RULES_VERSION,
        )
        .catch(() => undefined);
    }

    if (generation !== this.generation) return;

    const corrections =
      candidate.videoId !== undefined
        ? await this.deps.getCorrections(candidate.videoId)
        : { notAi: false, notSlop: false };

    const decision: FilterDecision = decide({
      settings,
      rules,
      candidate: {
        videoId: candidate.videoId,
        channelId: candidate.channel.channelId,
        handle: candidate.channel.handle,
        title: candidate.title,
      },
      classification,
      correctedNotAi: corrections.notAi,
      correctedNotSlop: corrections.notSlop,
    });

    // N02 blocker-7: everything above awaited (cache, classification,
    // corrections). Re-read the CURRENT URL identity and settings before any
    // guard action: a fast swipe must never leave a paused/covered player
    // for a Short that is no longer on screen.
    if (generation !== this.generation) return;
    const activeUrl = currentUrl;
    const activeCandidate = parseDiscoveredFeedItem(
      document.body,
      page.surface,
      Date.now(),
      activeUrl,
    );
    if (identityOf(activeCandidate) !== signature) return; // swiped away mid-flight
    const finalSettings = await this.deps.getSettings();
    if (!finalSettings.enabled) return;

    if (finalSettings.shortsGuard.enabled) {
      if (decision.action === 'hide') {
        pauseAndCoverShorts(candidate, decision);
      } else {
        removeShortsGuard();
      }
    }
    if (decision.action === 'hide' && finalSettings.collectLocalStats) {
      await this.deps.applyStats({ hidden: 1 });
    }
  }

  /**
   * Test/diagnostic hook: run the active-Shorts pipeline for an explicit URL
   * (production uses processBatch's page context). Same code path.
   */
  async processActiveShortsForTest(
    page: ReturnType<typeof pageContextFromUrl>,
    url: string,
  ): Promise<void> {
    const settings = await this.deps.getSettings();
    if (!settings.enabled) return;
    const rules = await this.deps.getRules();
    const context: DetectionContext = {
      locale: this.getLocale(),
      enabledRulePacks: settings.rulePacks,
    };
    await this.processActiveShorts(page, settings, rules, context, this.generation, url);
  }

  /** User clicked "Show once": reveal this card for the current page view.
   * N02: the override is recorded for the element AND its current evidence
   * signature so recycling cannot transfer it to a different video. */
  showOnce(element: Element, signature?: string): void {
    element.removeAttribute('data-bts-show-once');
    // '' means the signature is unknown: fall back to the bare element so the
    // user's click still has effect for identity-unknown content.
    showOnceOverrides.set(element, signature ?? '');
    restore(element);
  }

  /** Toggle the real stored Why details for a card's current decision. */
  why(element: Element, decision: FilterDecision, candidate: NormalizedVideoCandidate): void {
    toggleWhyDetails(element, decision, candidate);
  }

  /**
   * V7-06: explain why the SELECTED card is (or is not) hidden. Parses ONLY
   * the selected element — never the search box, sibling cards, or extension
   * UI. Re-decides with the SAME pure policy the pipeline uses against fresh
   * settings/rules, and reports the card's current on-page state. Returns
   * null when the element cannot be parsed (caller explains that instead of
   * inventing reasons).
   */
  async explainCandidate(element: Element): Promise<{
    observed: {
      videoId: string | undefined;
      title: string;
      channelId: string | undefined;
      handle: string | undefined;
      displayName: string | undefined;
      surface: string;
      isShort: boolean;
      officialDisclosure: boolean;
      badges: string[];
      matchedPhrase: string | undefined;
    };
    decision: FilterDecision;
    classification: NormalizedCached | undefined;
    corrections: { notAi: boolean; notSlop: boolean };
    pageStatus: {
      enabled: boolean;
      surfaceAllowed: boolean;
      currentState: string | null;
    };
  } | null> {
    try {
      const kind = cardKindOf(element);
      const candidate = parseDiscovered({ element, kind }, 'unknown', Date.now());
      const settings = await this.deps.getSettings();
      const rules = await this.deps.getRules();
      const context: DetectionContext = {
        locale: this.getLocale(),
        enabledRulePacks: settings.rulePacks,
      };

      let classification: NormalizedCached | undefined;
      try {
        const [cached] = await this.deps.getCachedClassifications(
          [rawInputOf(candidate, context.locale)],
          RULES_VERSION,
        );
        classification = classificationFromSlot(cached);
      } catch {
        classification = undefined;
      }
      if (classification === undefined && settings.enabled) {
        try {
          classification = await classifyCandidate(candidate, context);
        } catch {
          classification = undefined;
        }
      }

      const corrections =
        candidate.videoId !== undefined
          ? await this.deps.getCorrections(candidate.videoId)
          : { notAi: false, notSlop: false };
      const activeAutoChannels = this.deps.getActiveAutoChannels
        ? await this.deps.getActiveAutoChannels()
        : undefined;

      const decision = decide({
        settings,
        rules,
        activeAutoChannels,
        candidate: {
          videoId: candidate.videoId,
          channelId: candidate.channel.channelId,
          handle: candidate.channel.handle,
          title: candidate.title,
        },
        classification,
        correctedNotAi: corrections.notAi,
        correctedNotSlop: corrections.notSlop,
      });

      // Mirror of the policy's literal-phrase check (step 5b), shown so the
      // user can see WHICH phrase matched (or that none did).
      let matchedPhrase: string | undefined;
      const title = candidate.title ?? '';
      if (title.length > 0) {
        const index = getRuleIndex(rules);
        const lower = title.toLowerCase();
        matchedPhrase = index.blockedPhrasesLower.find(
          (phrase) => phrase.length > 0 && lower.includes(phrase),
        );
      }

      const surfaceNow = currentPageContext().surface;
      return {
        observed: {
          videoId: candidate.videoId,
          title: candidate.title,
          channelId: candidate.channel.channelId,
          handle: candidate.channel.handle,
          displayName: candidate.channel.displayName,
          surface: 'unknown',
          isShort: candidate.isShort,
          officialDisclosure: candidate.officialDisclosure?.present ?? false,
          badges: candidate.badges,
          matchedPhrase,
        },
        decision,
        classification,
        corrections,
        pageStatus: {
          enabled: settings.enabled,
          surfaceAllowed: surfaceNow === 'unknown' || settings.surfaces[surfaceNow] !== false,
          currentState: element.getAttribute(ATTR_STATE),
        },
      };
    } catch (error) {
      logger.warn('why-inspector: could not explain selected card', error);
      return null;
    }
  }

  /** Process a set of added roots (batched). */
  async processBatch(roots: Element[]): Promise<void> {
    const generation = this.generation;
    const work = this.doProcessBatch(roots, generation).finally(() => {
      this.inFlight.delete(work);
    });
    this.inFlight.add(work);
    return work;
  }

  private async doProcessBatch(roots: Element[], generation: number): Promise<void> {
    const startedAt = Date.now();
    const settings = await this.deps.getSettings();
    if (!settings.enabled) return;
    if (generation !== this.generation) return;

    const rules = await this.deps.getRules();
    const activeAutoChannels = this.deps.getActiveAutoChannels
      ? await this.deps.getActiveAutoChannels()
      : undefined;
    const page = currentPageContext();
    const { surface } = page;
    const context: DetectionContext = {
      locale: this.getLocale(),
      enabledRulePacks: settings.rulePacks,
    };

    // Per-surface opt-out (R06/DET-28): a disabled surface restores native
    // content and skips filtering entirely — even user block rules (DET-28
    // documented precedence: disabled surface wins).
    if (surface !== 'unknown' && !settings.surfaces[surface]) {
      for (const root of roots) {
        restoreRecursively(root);
        removeShortsGuard();
      }
      return;
    }

    let evaluated = 0;
    const limits = queueLimitsFor(settings.performance.preset);

    // ---- N08 batched classification phase ----
    // Every candidate discovered in this batch is classified in ONE cache
    // round-trip + at most one classifyCandidate call each, BEFORE the
    // sequential per-card loop, so the batch costs O(1) message round-trips.
    // Planning CONSUMES the (element, signature) processing slot — a second
    // batch for the same unchanged card must not re-classify it. processCard
    // re-parses and rejects a classification whose signature no longer
    // matches (recycle mid-round-trip), without consuming the new identity:
    // the new video is evaluated on the next pass.
    const planned = new Map<
      Element,
      {
        rawInput: RawCacheInput;
        candidate: NormalizedVideoCandidate;
        /** Snapshot identity the classification belongs to (N02 guard). */
        signature: string;
        classification: NormalizedCached | undefined;
        /** V5-03: fast-path verdict memo if valid at batch planning time */
        memoHit?: FilterDecision | undefined;
        /** One processing attempt per consumed slot (overlapping roots). */
        attempted: boolean;
      }
    >();
    for (const root of roots) {
      if (generation !== this.generation) return;
      for (const card of discoverCards(root, surface)) {
        const candidate = parseDiscovered(card, surface, Date.now());
        const signature = identityOf(candidate);
        const override = showOnceOverrides.get(card.element);
        if (override !== undefined && (override === signature || override === '')) continue;
        // Consume the processing slot for this (element, signature) now: an
        // observer batch overlapping this one must not double-classify it.
        if (!shouldProcess(card.element, signature)) continue;
        // Overlapping roots (DOM-11): one lookup per element per batch.
        if (planned.has(card.element)) continue;

        const rawInput = rawInputOf(candidate, context.locale);
        let memoHit: FilterDecision | undefined;
        if (candidate.videoId && candidate.title.trim().length > 0) {
          const evidenceFingerprint = classificationFingerprint(rawInput);
          const memo = this.verdictMemo.get(candidate.videoId, {
            evidenceFingerprint,
            settingsDigest: computeSettingsDigest(settings),
            rulesVersion: RULES_VERSION,
            classifierVersion: CLASSIFIER_VERSION,
          });
          if (memo !== undefined) {
            memoHit = {
              action: memo.action,
              reason: memo.reason,
              explanation: memo.explanation ?? ['Cached verdict memo hit'],
              rulesVersion: memo.rulesVersion,
              classifierVersion: memo.classifierVersion,
            };
          }
        }

        // V5-04: Early visual collapse for known explicit blocks or valid memo hides
        // Removes layout slot as early as practical during discovery pass.
        const ruleIndex = getRuleIndex(rules);
        const handle = candidate.channel.handle
          ? normalizeFallbackHandle(candidate.channel.handle)
          : undefined;
        const isExplicitAllow =
          candidate.videoId !== undefined && ruleIndex.allowedVideoIds.has(candidate.videoId);
        const isExplicitBlock =
          !isExplicitAllow &&
          ((candidate.videoId !== undefined && ruleIndex.blockedVideoIds.has(candidate.videoId)) ||
            (candidate.channel.channelId !== undefined &&
              ruleIndex.blockedChannelIds.has(candidate.channel.channelId)) ||
            (handle !== undefined && ruleIndex.fallbackBlockedHandles.has(handle)));
        const isAutoChannelBlock =
          !isExplicitAllow &&
          settings.autoChannel?.enabled &&
          activeAutoChannels !== undefined &&
          candidate.channel.channelId !== undefined &&
          activeAutoChannels.has(candidate.channel.channelId);
        const isKnownHide =
          !isExplicitAllow && (isExplicitBlock || isAutoChannelBlock || memoHit?.action === 'hide');
        if (isKnownHide && settings.displayMode === 'collapse') {
          card.element.setAttribute('data-bts-collapse', '');
        }

        planned.set(card.element, {
          rawInput,
          candidate,
          signature,
          classification: undefined,
          memoHit,
          attempted: false,
        });
      }
    }
    const needClassification = [...planned.values()].filter((entry) => entry.memoHit === undefined);
    if (needClassification.length > 0 && generation === this.generation) {
      try {
        const rawInputs = needClassification.map((entry) => entry.rawInput);
        const cached = await this.deps.getCachedClassifications(rawInputs, RULES_VERSION);
        if (generation !== this.generation) return;
        const misses: number[] = [];
        needClassification.forEach((entry, i) => {
          // A null/undefined/junk slot (JSON transport, degraded dep) is a
          // MISS, never a classification.
          const hit = classificationFromSlot(cached[i]);
          if (hit !== undefined) {
            entry.classification = hit;
          } else {
            misses.push(i);
          }
        });
        if (misses.length > 0) {
          // Per-miss isolation: a classification that throws stays a miss
          // (falls back to per-card handling) and can never reject the whole
          // phase — cache hits already resolved above are preserved.
          const settled = await Promise.all(
            misses.map((i) =>
              classifyCandidate(needClassification[i]!.candidate, context).catch(() => undefined),
            ),
          );
          if (generation !== this.generation) return;
          const storedInputs: RawCacheInput[] = [];
          const stored: NormalizedCached[] = [];
          misses.forEach((entryIndex, k) => {
            const value = settled[k];
            if (value !== undefined) {
              needClassification[entryIndex]!.classification = value;
              storedInputs.push(rawInputs[entryIndex]!);
              stored.push(value);
            }
          });
          if (stored.length > 0) {
            // Cache stores the whitelisted projection (bounded payload; the
            // diagnostic evidence array never enters the cache round-trip).
            const projected = stored.map(classificationForCache);
            void this.deps
              .putCachedClassifications(storedInputs, projected, RULES_VERSION)
              .catch(() => undefined); // degradation: writes are best-effort
          }
        }
      } catch {
        // N08 degradation: an unreachable cache must not kill the batch —
        // entries fall back to per-card classification below. (Per-miss
        // isolation above means resolved cache hits never reach this point.)
        for (const entry of needClassification) entry.classification = undefined;
      }
    }

    for (const root of roots) {
      if (generation !== this.generation) return;
      const cards = discoverCards(root, surface);
      for (const card of cards) {
        if (generation !== this.generation) return;
        await this.processCard(
          card.element,
          card,
          surface,
          settings,
          rules,
          context,
          generation,
          planned.get(card.element),
          planned.get(card.element)?.signature,
        );
        evaluated += 1;
        // Bounded prioritization/yielding (R08): periodically hand control
        // back to the page so large batches never block rendering.
        if (
          limits.yieldMs > 0 &&
          evaluated % limits.maxCardsPerTick === 0 &&
          generation === this.generation
        ) {
          await new Promise((r) => setTimeout(r, limits.yieldMs));
          if (generation !== this.generation) return;
        }
      }
    }

    // Active Shorts feed processing (R09/DOM-03): the feed item is derived
    // from the URL, never assigned to preloaded sibling lockups.
    if (page.isShorts) {
      await this.processActiveShorts(page, settings, rules, context, generation);
    }

    if (settings.collectLocalStats && evaluated > 0) {
      const duration = Date.now() - startedAt;
      void this.deps.applyStats({ cardsEvaluated: evaluated });
      logger.debug(`batch: ${evaluated} cards in ${duration}ms`);
    }
  }

  private async processCard(
    element: Element,
    card: ReturnType<typeof discoverCards>[number],
    surface: NormalizedVideoCandidate['surface'],
    settings: UserSettings,
    rules: UserRules,
    context: DetectionContext,
    generation: number,
    /** N08: classification resolved by the batched phase (undefined → classify here). */
    batched?: {
      classification: NormalizedCached | undefined;
      memoHit?: FilterDecision | undefined;
      attempted: boolean;
    },
    /** N08/N02: identity signature the batched classification was derived from. */
    batchedSignature?: string,
  ): Promise<void> {
    // Show-once override: leave this card alone for the current page view.
    // N02: honored only while the element still holds the SAME content the
    // user revealed (recorded signature); recycled content is re-evaluated.
    const candidate = parseDiscovered(card, surface, Date.now());
    const signature = identityOf(candidate);
    const override = showOnceOverrides.get(element);
    if (override !== undefined && (override === signature || override === '')) return;
    // N02/N08: a classification computed for a DIFFERENT identity (the card
    // was recycled mid-round-trip) must not attach to this video. Drop the
    // card WITHOUT consuming the NEW identity: it is evaluated next pass.
    // When no batched entry exists (planning skipped it), keep the classic
    // per-card gate.
    if (batched !== undefined) {
      if (batched.attempted) return; // overlapping roots re-deliver the entry
      if (batchedSignature !== signature) return;
      batched.attempted = true;
    } else if (!shouldProcess(element, signature)) {
      return;
    }

    let decision: FilterDecision;
    const memoHit = batched?.memoHit;
    if (memoHit !== undefined) {
      decision = { ...memoHit };
    } else {
      let classification = batched?.classification;
      if (classification === undefined) {
        try {
          const timeoutPromise = new Promise<undefined>((resolve) =>
            setTimeout(() => resolve(undefined), 1000),
          );
          classification = await Promise.race([
            classifyCandidate(candidate, context),
            timeoutPromise,
          ]);
        } catch {
          classification = undefined;
        }
      }

      // ---- async boundary: revalidate everything that may have changed ----
      if (generation !== this.generation) return;
      if (!element.isConnected) return;

      // DOM-14: current settings win after every await — the batch snapshot may
      // be stale (user disabled filtering or changed mode mid-flight).
      settings = await this.deps.getSettings();
      if (!settings.enabled) {
        element.removeAttribute('data-bts-collapse');
        return;
      }

      const corrections =
        candidate.videoId !== undefined
          ? await this.deps.getCorrections(candidate.videoId)
          : { notAi: false, notSlop: false };
      const activeAutoChannels = this.deps.getActiveAutoChannels
        ? await this.deps.getActiveAutoChannels()
        : undefined;

      decision = decide({
        settings,
        rules,
        activeAutoChannels,
        candidate: {
          videoId: candidate.videoId,
          channelId: candidate.channel.channelId,
          handle: candidate.channel.handle,
          title: candidate.title,
        },
        classification,
        correctedNotAi: corrections.notAi,
        correctedNotSlop: corrections.notSlop,
      });
      decision.rulesVersion = classification?.rulesVersion ?? RULES_VERSION;
      decision.classifierVersion = classification?.classifierVersion ?? CLASSIFIER_VERSION;

      // V5-08: Record qualifying video for channel suggestion / auto-promotion
      // Prevents feedback loops: a video hidden due to a channel-rule does not count as new evidence.
      if (
        classification !== undefined &&
        candidate.videoId !== undefined &&
        candidate.channel.channelId !== undefined &&
        decision.ruleId === undefined &&
        decision.reason !== 'channel-rule'
      ) {
        void this.deps.recordAutoChannelCandidate?.({
          channelId: candidate.channel.channelId,
          handle: candidate.channel.handle,
          displayName: candidate.channel.displayName,
          videoId: candidate.videoId,
          classification,
        });
      }

      // Tier 2: Save to Verdict Memo if eligible (has videoId, non-empty title, not an explicit rule)
      if (
        candidate.videoId &&
        candidate.title.trim().length > 0 &&
        !decision.reason.startsWith('rule:') &&
        !decision.reason.startsWith('user-rule')
      ) {
        const evidenceFingerprint = classificationFingerprint(
          rawInputOf(candidate, context.locale),
        );
        this.verdictMemo.put(
          createVerdictMemoEntry({
            videoId: candidate.videoId,
            decision,
            evidenceFingerprint,
            settings,
          }),
        );
      }
    }

    // ---- final pre-DOM check (audit A05 + N02): identity may have changed
    // during the awaits (YouTube recycles nodes). Re-parse and require the
    // SAME identity before mutating; a recycled card is dropped here and its
    // new identity is processed on the next pass.
    if (!element.isConnected) return;
    const currentSignature = identityOf(parseDiscovered(card, surface, Date.now()));
    if (currentSignature !== signature) return;
    const overrideAfterAwait = showOnceOverrides.get(element);
    if (
      overrideAfterAwait !== undefined &&
      (overrideAfterAwait === currentSignature || overrideAfterAwait === '')
    )
      return;

    // N01 durable-hide protocol + V5-03 multi-surface/duplicate card dedup:
    // for a hide, the recovery record is COMMITTED BEFORE presentation.
    // Duplicate cards or multi-surface appearances on the same page do not
    // make redundant durable writes or inflate summary counts.
    if (decision.action === 'hide') {
      const dedupKey =
        candidate.videoId ??
        shortHash(
          `${candidate.title}\u0000${candidate.channel.channelId ?? ''}\u0000${candidate.surface}`,
        );
      if (!this.recordedHidesOnPage.has(dedupKey)) {
        const commit = await this.recordHidden(candidate, decision, settings.history.enabled);
        if (!commit.committed) {
          element.removeAttribute('data-bts-collapse');
          this.onHidePersistenceFailed?.(element, decision, candidate, commit.error);
          return;
        }
        this.recordedHidesOnPage.add(dedupKey);
      }
    }

    // N02 blocker-2: the durable write was an AWAIT — generation, settings,
    // connectivity and the card's identity may ALL have changed while it was
    // in flight. Revalidate everything immediately before presentation; the
    // committed history row is retained as the recovery record for A, but A's
    // hide is never applied to B / a disabled page / a stale generation.
    if (generation !== this.generation) return;
    if (!element.isConnected) return;
    const finalSettings = await this.deps.getSettings();
    if (!finalSettings.enabled) {
      element.removeAttribute('data-bts-collapse');
      return;
    }
    const finalSurfaceAllowed = surface === 'unknown' || finalSettings.surfaces[surface] !== false;
    if (!finalSurfaceAllowed) {
      element.removeAttribute('data-bts-collapse');
      return;
    }
    const currentSignatureAfterCommit = identityOf(parseDiscovered(card, surface, Date.now()));
    if (currentSignatureAfterCommit !== signature) return;
    if (!element.isConnected) return;
    const overrideAtCommit = showOnceOverrides.get(element);
    if (
      overrideAtCommit !== undefined &&
      (overrideAtCommit === currentSignatureAfterCommit || overrideAtCommit === '')
    )
      return;

    applyDecision(element, decision, candidate, finalSettings);
    this.onDecisionApplied?.(element, decision, candidate, signature);

    if (
      finalSettings.collectLocalStats &&
      (decision.action === 'hide' || decision.action === 'warn')
    ) {
      const statKey = candidate.videoId ?? signature;
      if (!this.countedStatsOnPage.has(statKey)) {
        this.countedStatsOnPage.add(statKey);
        await this.deps.applyStats({
          ...(decision.action === 'hide' ? { hidden: 1 } : {}),
          ...(decision.action === 'warn' ? { warned: 1 } : {}),
        });
        // V6-11: the durable day-bucketed observation is fire-and-forget:
        // a stats failure must never affect presentation (it already happened
        // above) or block the batch.
        this.deps
          .recordDailyStat?.({
            outcome: decision.action,
            videoId: candidate.videoId,
            signature,
            observedAt: candidate.observedAt,
          })
          .catch(() => undefined);
      }
    }
  }

  /** N01: invoked when a hide could not be durably recorded. The card stays
   * visible; the UI must surface a non-destructive local error. N17: the
   * triggering error is passed so context invalidation can be distinguished. */
  onHidePersistenceFailed?: (
    element: Element,
    decision: FilterDecision,
    candidate: NormalizedVideoCandidate,
    error?: unknown,
  ) => void = undefined;

  /**
   * Commit the recovery record for a hide. Returns false when persistence
   * failed (so the caller must NOT hide). History-disabled skips durable
   * writes by explicit user choice and reports success for presentation.
   */
  private async recordHidden(
    candidate: NormalizedVideoCandidate,
    decision: FilterDecision,
    historyEnabled: boolean,
  ): Promise<{ committed: boolean; error?: unknown }> {
    const sessionKey = shortHash(
      `${candidate.title}\u0000${candidate.channel.channelId ?? ''}\u0000${candidate.surface}`,
    );
    // Idempotency key generated BEFORE the write; retries cannot double-count.
    const operationId = `hide:${candidate.videoId ?? 'u-' + sessionKey}:${candidate.observedAt}`;
    if (historyEnabled && this.deps.recordHiddenDurable !== undefined) {
      try {
        await this.deps.recordHiddenDurable({ candidate, decision, sessionKey, operationId });
      } catch (error) {
        // N01: persistence failure must fail open (card stays visible). The
        // error is carried so N17 can distinguish context invalidation from
        // a genuine storage failure.
        return { committed: false, error };
      }
    }
    return { committed: true };
  }

  /** Public: allow a video (from popup/overlay), then re-evaluate on next pass. */
  async allowVideo(candidate: NormalizedVideoCandidate): Promise<void> {
    void candidate;
  }

  /**
   * V7-07: record a local miss-review diagnostic for the SELECTED video —
   * WHY the automatic filter did not hide it. Bounded, deduplicated, local
   * only. A failure here degrades the diagnostic, never the user's rule: the
   * caller applies the rule regardless.
   */
  async recordMissForCandidate(
    element: Element,
    surface: NormalizedVideoCandidate['surface'],
    settings: UserSettings,
    classification: NormalizedCached | undefined,
    decision: FilterDecision,
  ): Promise<void> {
    if (this.deps.recordMissReview === undefined) return;
    try {
      const candidate = parseDiscovered(
        { element, kind: cardKindOf(element) },
        surface,
        Date.now(),
      );
      const why = classifyMiss({ candidate, decision, classification, settings, surface });
      await this.deps.recordMissReview({
        videoId: candidate.videoId,
        title: candidate.title,
        channelName: candidate.channel.displayName,
        surface,
        reason: why,
        seenAt: Date.now(),
        note: decision.explanation[0]?.slice(0, 160),
      });
    } catch (error) {
      logger.warn('miss-review: diagnostic write failed (rule still applied)', error);
    }
  }

  /** Reset presentation for a card when user forces show. */
  showCard(element: Element): void {
    this.showOnce(element);
  }

  /**
   * Full reprocess (settings/rules changed or filtering re-enabled):
   * cancels in-flight async work, forgets per-card marks, rescans once.
   * Show-once overrides SURVIVE rescans (PRE-07) — only navigation expires
   * them (onNavigation / stop).
   */
  rescan(): void {
    this.generation += 1;
    bumpEpoch();
    void this.processBatch([document.body]);
  }
}
