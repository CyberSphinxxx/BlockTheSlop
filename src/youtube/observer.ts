import { logger } from '@/shared/logger';

export type MutationBatchHandler = (roots: Element[]) => void;
export type NavigationHandler = (url: string) => void;

/**
 * Batched DOM observation (audit A04).
 *
 * Observes childList + relevant attribute/text changes scoped to a small
 * allow-list (href/title/aria-label and disclosure state), because those are
 * the mutations that change a card's evidence. Style/class churn is ignored.
 * Text mutations map to their parent card; removed roots are dropped from the
 * pending set. There is NO permanent processed-root suppression — dedup within
 * a batch is the batching layer's only job; "already processed" decisions are
 * the identity layer's (fingerprint-based, per element).
 */

/** Attributes whose changes can change parsed identity/evidence. */
const OBSERVED_ATTRIBUTES = ['href', 'title', 'aria-label'];

/** Extension-owned tags never treated as page mutation roots. */
const OWNED_PREFIX = 'bts-';

function isOwnedElement(node: Node): boolean {
  return node instanceof Element && node.tagName.toLowerCase().startsWith(OWNED_PREFIX);
}

export class BatchingObserver {
  private readonly observer: MutationObserver;
  private pendingRoots = new Set<Element>();
  private scheduled = false;
  private started = false;
  private lastNavigation = '';

  constructor(
    private readonly onBatch: MutationBatchHandler,
    private readonly onNavigation: NavigationHandler,
    private readonly initialScan: () => void,
  ) {
    this.observer = new MutationObserver((mutations) => this.handleMutations(mutations));
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.lastNavigation = location.pathname + location.search;
    this.observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: OBSERVED_ATTRIBUTES,
      characterData: true,
    });
    // Intercept SPA pushes: YouTube navigations replace history state.
    window.addEventListener('popstate', this.checkNavigation);
    window.addEventListener('yt-navigate-finish', this.checkNavigation as EventListener);
    this.initialScan();
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;
    this.observer.disconnect();
    window.removeEventListener('popstate', this.checkNavigation);
    window.removeEventListener('yt-navigate-finish', this.checkNavigation as EventListener);
  }

  private handleMutations(mutations: MutationRecord[]): void {
    for (const mutation of mutations) {
      // ChildList: added nodes are roots (extension-owned additions excluded).
      if (mutation.type === 'childList') {
        for (const node of mutation.addedNodes) {
          if (isOwnedElement(node)) continue;
          if (node instanceof Element) this.pendingRoots.add(node);
        }
        // Removed roots can't be processed.
        for (const node of mutation.removedNodes) {
          if (node instanceof Element) this.pendingRoots.delete(node);
        }
        continue;
      }

      // Attribute/text changes: map to the owning card via the parent chain.
      const target = mutation.target as Node;
      const root: Element | null = target instanceof Element ? target : target.parentElement;
      if (root === null || isOwnedElement(root)) continue;
      // Ignore mutations inside extension-owned UI (Why details, overlays).
      if (root.closest('.bts-overlay, .bts-placeholder') !== null) continue;
      this.pendingRoots.add(root);
    }

    if (this.pendingRoots.size > 0 && !this.scheduled) {
      this.scheduled = true;
      queueMicrotask(() => {
        this.scheduled = false;
        this.checkNavigation();
        const roots = [...this.pendingRoots];
        this.pendingRoots = new Set();
        try {
          this.onBatch(roots);
        } catch (error) {
          logger.error('batch handler failed', error);
        }
      });
    }
  }

  private readonly checkNavigation = (): void => {
    const signature = location.pathname + location.search;
    if (signature !== this.lastNavigation) {
      this.lastNavigation = signature;
      try {
        this.onNavigation(location.href);
      } catch (error) {
        logger.error('navigation handler failed', error);
      }
    }
  };
}
