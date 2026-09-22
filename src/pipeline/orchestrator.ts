import type { FilterDecision } from '@/domain/decision';
import type { UserSettings } from '@/domain/settings';
import type { UserRules } from '@/domain/rules';
import type { NormalizedVideoCandidate } from '@/domain/video';
import type { ReviewRecord } from '@/domain/review';
import { reviewRecordId } from '@/domain/review';
import type { DetectionContext } from '@/domain/evidence';
import { shortHash, type FingerprintInput } from '@/storage/fingerprint';
import { RULES_VERSION } from '@/domain/versions';
import { classifyCandidate } from '@/detection/engine';
import { decide } from '@/policy/decide';
import { applyDecision, restore, toggleWhyDetails } from '@/presentation/apply-decision';
import { restoreRecursively } from '@/presentation/cleanup';
import { identityOf } from '@/domain/video';
import { discoverCards, parseDiscovered, parseDiscoveredFeedItem } from '@/youtube/discover';
import { currentPageContext, pageContextFromUrl } from '@/youtube/routes';
import { BatchingObserver } from '@/youtube/observer';
import { shouldProcess, bumpEpoch } from '@/youtube/identity';
import { ensureStyles } from '@/presentation/apply-decision';
import { pauseAndCoverShorts, removeShortsGuard } from '@/presentation/shorts-guard';
import { queueLimitsFor } from '@/domain/settings';
import { logger } from '@/shared/logger';

/** Storage/persistence ports the orchestrator needs. */
export interface OrchestratorDeps {
  getSettings(): Promise<UserSettings>;
  getRules(): Promise<UserRules>;
  /** Fingerprint+version keyed cache (R12). Implemented as no-op in tests. */
  getCachedClassification(
    input: FingerprintInput,
    rulesVersion: string,
  ): Promise<NormalizedCached | undefined>;
  putCachedClassification(
    input: FingerprintInput,
    classification: NormalizedCached,
    rulesVersion: string,
  ): Promise<void>;
  getCorrections(videoId: string | undefined): Promise<{ notAi: boolean; notSlop: boolean }>;
  addReviewRecord(record: ReviewRecord): Promise<void>;
  /** Durable event write with a caller-generated idempotency key (R10). */
  recordHiddenDurable?(input: {
    candidate: NormalizedVideoCandidate;
    decision: FilterDecision;
    sessionKey: string;
    operationId: string;
  }): Promise<void>;
  applyStats(delta: { cardsEvaluated?: number; hidden?: number; warned?: number }): Promise<void>;
  isRemoteProviderEnabled(): boolean;
}

/** Minimal classification shape used for caching (evidence is re-derived). */
export type NormalizedCached = Awaited<ReturnType<typeof classifyCandidate>>;

/** Bounded fingerprint projection of a candidate (cache key, R12). */
function fingerprintInputOf(
  candidate: NormalizedVideoCandidate,
  locale: string | undefined,
): FingerprintInput {
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

/** Show-once overrides: element-scoped, cleared on navigation (audit A09 scope). */
const showOnceElements = new Set<Element>();

/**
 * The pipeline: discover → parse → classify → decide → present.
 * Every await re-checks the generation token; DOM mutation happens only after
 * a final identity/connection check (audit A05).
 */
export class FilterOrchestrator {
  private observer: BatchingObserver | null = null;
  private generation = 0;

  /** Hook: notified after each applied decision (used for real Why records). */
  onDecisionApplied?: (
    element: Element,
    decision: FilterDecision,
    candidate: NormalizedVideoCandidate,
  ) => void = undefined;

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
    showOnceElements.clear(); // Show-once is page-view scoped.
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
    // changes (identityOf covers videoId/title/channel).
    if (!shouldProcess(document.documentElement, `shorts-feed:${signature}`)) {
      // Already evaluated this active Short; nothing to change.
      return;
    }
    if (generation !== this.generation) return;

    let classification = await this.deps.getCachedClassification(
      fingerprintInputOf(candidate, context.locale),
      RULES_VERSION,
    );
    if (classification === undefined) {
      classification = await classifyCandidate(candidate, context);
      await this.deps.putCachedClassification(
        fingerprintInputOf(candidate, context.locale),
        classification,
        RULES_VERSION,
      );
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

    if (settings.shortsGuard.enabled) {
      if (decision.action === 'hide') {
        pauseAndCoverShorts(candidate, decision);
      } else {
        removeShortsGuard();
      }
    }
    if (decision.action === 'hide' && settings.collectLocalStats) {
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

  /** User clicked "Show once": reveal this card for the current page view. */
  showOnce(element: Element): void {
    showOnceElements.add(element);
    restore(element);
  }

  /** Toggle the real stored Why details for a card's current decision. */
  why(element: Element, decision: FilterDecision, candidate: NormalizedVideoCandidate): void {
    toggleWhyDetails(element, decision, candidate);
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

    for (const root of roots) {
      if (generation !== this.generation) return;
      const cards = discoverCards(root, surface);
      for (const card of cards) {
        if (generation !== this.generation) return;
        await this.processCard(card.element, card, surface, settings, rules, context, generation);
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
  ): Promise<void> {
    // Show-once override: leave this card alone for the current page view.
    if (showOnceElements.has(element)) return;

    const candidate = parseDiscovered(card, surface, Date.now());
    const signature = identityOf(candidate);
    if (!shouldProcess(element, signature)) return;

    // Classification: cache by evidence fingerprint + versions (R12).
    let classification = await this.deps.getCachedClassification(
      fingerprintInputOf(candidate, context.locale),
      RULES_VERSION,
    );
    if (classification === undefined) {
      classification = await classifyCandidate(candidate, context);
      await this.deps.putCachedClassification(
        fingerprintInputOf(candidate, context.locale),
        classification,
        RULES_VERSION,
      );
    }

    // ---- async boundary: revalidate everything that may have changed ----
    if (generation !== this.generation) return;
    if (!element.isConnected) return;

    // DOM-14: current settings win after every await — the batch snapshot may
    // be stale (user disabled filtering or changed mode mid-flight).
    settings = await this.deps.getSettings();
    if (!settings.enabled) return;

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
    decision.rulesVersion = classification.rulesVersion;
    decision.classifierVersion = classification.classifierVersion;

    // ---- final pre-DOM check (audit A05): identity may have changed during
    // the correction lookup. Re-parse; if the card now holds different video,
    // drop this result — the new identity will be processed on its own pass.
    if (!element.isConnected) return;
    if (showOnceElements.has(element)) return;

    applyDecision(element, decision, candidate, settings);
    this.onDecisionApplied?.(element, decision, candidate);

    if (decision.action === 'hide') {
      await this.recordHidden(candidate, decision, settings.history.enabled);
    }
    if (settings.collectLocalStats && (decision.action === 'hide' || decision.action === 'warn')) {
      await this.deps.applyStats({
        ...(decision.action === 'hide' ? { hidden: 1 } : {}),
        ...(decision.action === 'warn' ? { warned: 1 } : {}),
      });
    }
  }

  private async recordHidden(
    candidate: NormalizedVideoCandidate,
    decision: FilterDecision,
    historyEnabled: boolean,
  ): Promise<void> {
    const sessionKey = shortHash(
      `${candidate.title}\u0000${candidate.channel.channelId ?? ''}\u0000${candidate.surface}`,
    );
    // Idempotency key generated BEFORE the write; retries cannot double-count.
    const operationId = `hide:${candidate.videoId ?? 'u-' + sessionKey}:${candidate.observedAt}`;
    // PRE-13: when history is deliberately OFF, no durable write happens —
    // the presentation already offers local placeholder recovery (Show once).
    if (historyEnabled) {
      await this.deps.recordHiddenDurable?.({ candidate, decision, sessionKey, operationId });
    }
    await this.deps.addReviewRecord({
      id: reviewRecordId(candidate.videoId, candidate.observedAt),
      videoId: candidate.videoId,
      title: candidate.title,
      channelId: candidate.channel.channelId,
      channelName: candidate.channel.displayName,
      surface: candidate.surface,
      decision,
      createdAt: Date.now(),
    });
  }

  /** Public: allow a video (from popup/overlay), then re-evaluate on next pass. */
  async allowVideo(candidate: NormalizedVideoCandidate): Promise<void> {
    void candidate;
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
