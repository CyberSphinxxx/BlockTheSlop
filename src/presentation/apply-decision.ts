import type { FilterDecision } from '@/domain/decision';
import type { UserSettings } from '@/domain/settings';
import type { NormalizedVideoCandidate } from '@/domain/video';
import { ATTR_FINGERPRINT, ATTR_STATE, ATTR_VIDEO_ID, SELECTORS } from '@/youtube/selectors';
import { parseDiscovered, cardKindOf } from '@/youtube/discover';
import { shortHash } from '@/storage/fingerprint';
import { PRESENTATION_CSS } from './style';

/**
 * Applies a decision to a card element.
 *
 * Presentation ownership contract (R03/R04):
 * - exactly ONE extension-owned UI per card (placeholder or warn overlay);
 * - applying the same decision twice does not duplicate anything;
 * - changing decisions removes all stale state from the previous one;
 * - restore() removes every extension-owned node and inline style;
 * - Why shows the REAL stored explanation and never changes the action.
 */

export interface PresentationCallbacks {
  /** User clicked "Show once" on a hidden card (scoped to this element/tab). */
  showOnce(element: Element): void;
  /** User clicked "Why?" — expand the real explanation (toggle). */
  why(element: Element): void;
  /** User allowed the video from an overlay. Receives the host element so
   * freshness can be validated at click time (N02). */
  allowVideo(candidate: NormalizedVideoCandidate, element?: Element): void;
  /** User allowed the channel from an overlay. Receives the host element so
   * freshness can be validated at click time (N02). */
  allowChannel(candidate: NormalizedVideoCandidate, element?: Element): void;
}

let callbacks: PresentationCallbacks | null = null;

export function setPresentationCallbacks(value: PresentationCallbacks): void {
  callbacks = value;
}

/**
 * Ensure the extension stylesheet exists exactly once, populated with the
 * canonical PRESENTATION_CSS. Single delivery path (audit A01): the constant
 * is imported here and injected at runtime; no empty fallback exists.
 */
export function ensureStyles(): void {
  if (document.getElementById('bts-style') !== null) return;
  const style = document.createElement('style');
  style.id = 'bts-style';
  style.textContent = PRESENTATION_CSS;
  document.head.appendChild(style);
}

/**
 * Apply page-level presentation preferences (CFG-10): compact density via a
 * root class, color scheme via the platform-standard `color-scheme` property
 * which extension-owned pages and placeholders honor. Idempotent.
 */
export function applyPresentationPreferences(prefs: {
  density: 'comfortable' | 'compact';
  theme: 'system' | 'light' | 'dark';
}): void {
  document.documentElement.classList.toggle('bts-root-compact', prefs.density === 'compact');
  // N15/CFG-10: the theme attribute drives PRESENTATION_CSS variables for
  // extension-owned surfaces on the page. 'system' removes the attribute so
  // the host page's own scheme applies (no forced override).
  if (prefs.theme === 'system') {
    document.documentElement.removeAttribute('data-bts-theme');
  } else {
    document.documentElement.setAttribute('data-bts-theme', prefs.theme);
  }
  document.documentElement.style.setProperty('color-scheme', prefs.theme);
}

/** Every extension-owned element we may have inserted under a card. */
const OWNED_SELECTOR = '.bts-placeholder, .bts-warn-marker, .bts-overlay, .bts-status';

/** V7-02: attribute/value marking an outer layout slot for collapse removal. */
export const ATTR_SLOT_COLLAPSE = 'data-bts-slot';
export const SLOT_COLLAPSE_VALUE = 'collapse';

/**
 * V7-02: wrappers that may be the REAL grid cell around a single card. When
 * collapse hides a card whose parent wrapper is the layout slot (e.g. a
 * ytd-rich-item-renderer around one yt-lockup-view-model), hiding only the
 * card leaves an empty grid cell — the "blank slot" regression. The wrapper
 * is marked instead/alongside so the whole cell leaves the grid.
 */
const SLOT_WRAPPER_SELECTORS: readonly string[] = [
  ...SELECTORS.lockup,
  'ytd-compact-video-renderer',
  'ytd-grid-video-renderer',
  'ytd-playlist-video-renderer',
  'ytd-item-section-renderer',
];

/** All selectors that identify a card-like element (for single-card check). */
const CARD_CONTAINER_SELECTORS: readonly string[] = [
  ...SELECTORS.lockup,
  'ytd-compact-video-renderer',
  'ytd-grid-video-renderer',
  'ytd-playlist-video-renderer',
  'ytm-shorts-lockup-view-model',
  'ytd-reel-item-renderer',
];

function matchesSelector(el: Element, selector: string): boolean {
  try {
    return el.matches(selector);
  } catch {
    return false;
  }
}

/** True when `wrapper` lays out EXACTLY this one card (never a multi-card shelf). */
function wrapsSingleCard(wrapper: Element, card: Element): boolean {
  const selector = CARD_CONTAINER_SELECTORS.join(',');
  let inner: NodeListOf<Element>;
  try {
    inner = wrapper.querySelectorAll(selector);
  } catch {
    return false;
  }
  return inner.length === 1 && inner[0] === card;
}

/**
 * V7-02: mark the outer layout slot of `card` so collapse removes the whole
 * rendered cell, then let the CSS `[data-bts-slot="collapse"]` rule hide it.
 *
 * Safety contract (the Shorts-shelf over-hide lesson): a wrapper is marked
 * ONLY when it lays out exactly ONE card. A Shorts shelf's rich-item wrapper
 * contains many lockups, so it is never marked — hiding one Short collapses
 * only that Short's own slot and the shelf stays. Never detaches or moves
 * any YouTube node; only sets one attribute on an existing wrapper.
 */
export function markCollapseSlot(card: Element): void {
  let ancestor = card.parentElement;
  for (let depth = 0; ancestor !== null && depth < 6; depth++) {
    if (SLOT_WRAPPER_SELECTORS.some((s) => matchesSelector(ancestor!, s))) {
      if (wrapsSingleCard(ancestor, card)) {
        ancestor.setAttribute(ATTR_SLOT_COLLAPSE, SLOT_COLLAPSE_VALUE);
      }
      // First card-wrapper candidate decides: a multi-card wrapper (shelf)
      // means higher ancestors are even wider — fall back to the card itself.
      return;
    }
    ancestor = ancestor.parentElement;
  }
}

/** Remove every slot mark that covers `card` (restore/stale-state cleanup). */
function clearCollapseSlotsFor(card: Element): void {
  const selector = `[${ATTR_SLOT_COLLAPSE}="${SLOT_COLLAPSE_VALUE}"]`;
  for (const slot of document.querySelectorAll(selector)) {
    if (slot === card || slot.contains(card)) slot.removeAttribute(ATTR_SLOT_COLLAPSE);
  }
}

function findOwned(element: Element): Element[] {
  // Nested lookup: warn inserts under the thumbnail anchor, placeholder under
  // the card; cleanup/restore must find and remove all of them (audit A03).
  return [...element.querySelectorAll(`:scope ${OWNED_SELECTOR}`)];
}

function removeStaleState(element: Element): void {
  for (const owned of findOwned(element)) owned.remove();
  element.classList.remove('bts-show-placeholder');
  element.removeAttribute('data-bts-collapse');
  // V7-02: a slot mark from a previous collapse must never outlive the
  // decision that created it (warn-after-hide would keep the card hidden).
  clearCollapseSlotsFor(element);
}

/** Restore a card to its untouched state. Idempotent. */
export function restore(element: Element): void {
  element.removeAttribute(ATTR_STATE);
  element.removeAttribute(ATTR_VIDEO_ID);
  element.removeAttribute(ATTR_FINGERPRINT);
  removeStaleState(element);
  // Restore inline styles WE set on the warn anchor (audit A03): only touch
  // cards we actually marked.
  for (const anchor of anchorsWithOurInlineStyles(element)) {
    (anchor as HTMLElement).style.removeProperty('position');
    anchor.removeAttribute('data-bts-inline');
  }
}

const INLINE_MARK = 'data-bts-inline';

function anchorsWithOurInlineStyles(element: Element): Element[] {
  return [...element.querySelectorAll(`:scope [${INLINE_MARK}]`)];
}

/**
 * V7-04: true when the marked card still holds the SAME content it was hidden
 * for. `signature` is the orchestrator's identityOf(candidate) string captured
 * when the decision was applied; an empty signature (identity was unknown at
 * hide time) is treated as matching — nothing stronger to validate against.
 * Used by session-recovery/popup restore actions so a recycled element can
 * never be revealed as if it were the hidden video.
 */
export function identityStillMatches(element: Element, signature: string): boolean {
  if (signature === '') return true;
  const stamped = element.getAttribute(ATTR_FINGERPRINT);
  if (stamped === null) return false;
  const current = parseDiscovered({ element, kind: cardKindOf(element) }, 'unknown', Date.now());
  return contentFingerprintOf(current) === stamped;
}

/**
 * N02: evidence fingerprint stamped on the element when a decision is applied.
 * Consumers (show-once set, overlay click handlers) compare this against the card's
 * CURRENT parsed identity before acting; a mismatch means the element was
 * recycled and the stored decision belongs to a different video. The stamp
 * describes CONTENT only (id/title/channel) so it is decision-independent. */
function contentFingerprintOf(candidate: NormalizedVideoCandidate): string {
  return shortHash(
    `${candidate.videoId ?? ''}\u0000${candidate.title}\u0000${candidate.channel.channelId ?? ''}`,
  );
}

/** N02: true when the element's stamp still describes its CURRENT content and
 * that content is the same video the caller (overlay) was created for. The
 * card is RE-PARSED at call time — a recycled element fails both checks. */
export function stampIsCurrent(element: Element, candidate: NormalizedVideoCandidate): boolean {
  const stamped = element.getAttribute(ATTR_FINGERPRINT);
  if (stamped === null) return false;
  const current = parseDiscovered({ element, kind: cardKindOf(element) }, 'unknown', Date.now());
  const currentFingerprint = contentFingerprintOf(current);
  return stamped === currentFingerprint && currentFingerprint === contentFingerprintOf(candidate);
}

function button(label: string, onClick: () => void): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'bts-button';
  btn.textContent = label; // textContent — never innerHTML (XSS contract)
  btn.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    onClick();
  });
  return btn;
}

function whyDetailsText(decision: FilterDecision, candidate: NormalizedVideoCandidate): string {
  const lines: string[] = [...decision.explanation];
  const id = candidate.videoId ?? '(no video id detected)';
  lines.push(`Video: ${id}`);
  if (candidate.channel.channelId !== undefined)
    lines.push(`Channel: ${candidate.channel.channelId}`);
  else if (candidate.channel.handle !== undefined)
    lines.push(`Channel: ${candidate.channel.handle}`);
  lines.push(`Surface: ${candidate.surface}`);
  lines.push(
    `Rule pack: ${decision.rulesVersion ?? 'n/a'} · classifier: ${decision.classifierVersion ?? 'n/a'}`,
  );
  return lines.join('\n');
}

function whyDetailsFor(
  decision: FilterDecision,
  candidate: NormalizedVideoCandidate,
  host: HTMLElement,
): HTMLElement {
  const details = document.createElement('div');
  details.className = 'bts-why-details';
  details.setAttribute('role', 'note');
  details.dataset.btsWhy = 'true';
  details.textContent = whyDetailsText(decision, candidate);
  host.appendChild(details);
  return details;
}

function placeholderFor(
  element: Element,
  decision: FilterDecision,
  candidate: NormalizedVideoCandidate,
  callbacksValue: PresentationCallbacks,
  showExplanations: boolean,
): HTMLElement {
  const placeholder = document.createElement('div');
  placeholder.className = 'bts-placeholder';
  placeholder.setAttribute('role', 'status');

  const title = document.createElement('div');
  title.className = 'bts-placeholder-title';
  title.textContent = 'Hidden by BlockTheSlop';
  placeholder.appendChild(title);

  // N04 blocker-4: `showExplanations` is a REAL presentation setting — when
  // off, the inline reason line is omitted (the Why button still opens the
  // full stored explanation on demand).
  if (showExplanations) {
    const reason = document.createElement('div');
    reason.textContent = decision.explanation[0] ?? 'Matched your filters';
    placeholder.appendChild(reason);
  }

  const actions = document.createElement('div');
  actions.className = 'bts-placeholder-actions';
  // N18 labels: scope-explicit, no misleading "Show once" on a hidden card.
  actions.appendChild(button('Reveal once', () => callbacksValue.showOnce(element)));
  actions.appendChild(button('Why hidden?', () => callbacksValue.why(element)));
  placeholder.appendChild(actions);

  // Why details are created lazily by toggleWhyDetails(); keep the candidate
  // reachable through the element's state store (applyDecision wires it).
  return placeholder;
}

/** Toggle (open/close) the inline Why details on a hidden or warned card. */
export function toggleWhyDetails(
  element: Element,
  decision: FilterDecision,
  candidate: NormalizedVideoCandidate,
): boolean {
  const host =
    element.querySelector<HTMLElement>(':scope .bts-placeholder, :scope .bts-warn-marker') ??
    (element as HTMLElement);
  const existing = host.querySelector<HTMLElement>(':scope .bts-why-details');
  if (existing !== null) {
    existing.remove();
    return false;
  }
  whyDetailsFor(decision, candidate, host as HTMLElement);
  return true;
}

/** The thumbnail anchor for warn markers; marks inline styles we add. */
function warnAnchor(element: Element): HTMLElement {
  const anchor =
    element.querySelector<HTMLElement>(SELECTORS.thumbnail.join(',')) ?? (element as HTMLElement);
  if (getComputedStyle(anchor).position === 'static') {
    anchor.style.position = 'relative';
    anchor.setAttribute(INLINE_MARK, '');
  }
  return anchor;
}

/**
 * N16: the thumbnail marker shown next to warned content. A COMPACT chip
 * anchored to the thumbnail corner — it never covers the video preview area,
 * so YouTube's hover-preview player and native badges cannot hide it.
 */
function warnMarkerFor(
  element: Element,
  decision: FilterDecision,
  candidate: NormalizedVideoCandidate,
  callbacksValue: PresentationCallbacks,
): HTMLElement {
  const marker = document.createElement('div');
  marker.className = 'bts-warn-marker';
  marker.setAttribute('role', 'status');
  marker.setAttribute(
    'aria-label',
    `Warned by BlockTheSlop: ${decision.explanation[0] ?? 'matched your filters'}`,
  );

  const chip = document.createElement('span');
  chip.className = 'bts-warn-chip';
  chip.textContent = 'Filtered';
  marker.appendChild(chip);

  // Commands live OUTSIDE the thumbnail hover-hit area (pointer-events pass
  // through the chip itself except on its buttons).
  const actions = document.createElement('div');
  actions.className = 'bts-overlay-actions';
  actions.appendChild(button('Reveal once', () => callbacksValue.showOnce(element)));
  actions.appendChild(button('Why hidden?', () => callbacksValue.why(element)));
  marker.appendChild(actions);

  return marker;
}

/**
 * Warn: content stays usable; a compact in-flow bar with commands is inserted
 * AFTER the thumbnail (below it), outside YouTube's hover-preview layers.
 * N16: nothing with pointer-events is positioned over the preview, so the
 * hover preview can never cover the review controls.
 */
export function warn(
  element: Element,
  decision: FilterDecision,
  candidate: NormalizedVideoCandidate,
): void {
  if (callbacks === null) return;
  removeStaleState(element);
  element.setAttribute(ATTR_STATE, 'warn');
  element.setAttribute(ATTR_FINGERPRINT, contentFingerprintOf(candidate));
  if (candidate.videoId !== undefined) element.setAttribute(ATTR_VIDEO_ID, candidate.videoId);
  element.removeAttribute('data-bts-collapse');
  // Marker as a SIBLING after the thumbnail: in normal flow, unobstructed.
  // When no thumbnail exists, contain it INSIDE the card instead (after() on
  // the card itself would escape the card and evade cleanup).
  const anchor = warnAnchor(element);
  const marker = warnMarkerFor(element, decision, candidate, callbacks);
  if (anchor === (element as HTMLElement)) element.appendChild(marker);
  else anchor.after(marker);
}

/**
 * Hide a card: placeholder mode suppresses native children; collapse removes
 * the slot.
 *
 * N01/N03 blocker-3: Collapse + history-OFF would otherwise remove the ONLY
 * recovery affordance (the placeholder's Show once) with no durable history
 * row to restore from. In that combination the card keeps a MINIMAL recovery
 * bar (session-only reveal) instead of being fully removed — the layout cost
 * is one slim bar, and every automatic hide keeps an on-page recovery route.
 * With history ON, collapse removes the slot entirely (Review history is the
 * recovery route).
 */
export function hide(
  element: Element,
  decision: FilterDecision,
  candidate: NormalizedVideoCandidate,
  settings: UserSettings,
): void {
  if (callbacks === null) return;
  removeStaleState(element);
  element.setAttribute(ATTR_STATE, 'hidden');
  element.setAttribute(ATTR_FINGERPRINT, contentFingerprintOf(candidate));
  if (candidate.videoId !== undefined) element.setAttribute(ATTR_VIDEO_ID, candidate.videoId);
  if (settings.displayMode === 'collapse') {
    // Gap-free collapse (V5-02/V7-02): the layout slot is removed completely
    // with no placeholder or inline bar. The card AND its single-card outer
    // wrapper (when one exists) carry the collapse mark; Shorts shelf lockups
    // collapse their own cell without ever hiding the shelf. Recovery remains
    // available via Review history (when history is ON) and the page/session
    // recovery list (when history is OFF).
    element.setAttribute('data-bts-collapse', '');
    markCollapseSlot(element);
    return;
  }
  element.appendChild(
    placeholderFor(element, decision, candidate, callbacks, settings.showExplanations),
  );
}

/**
 * N01: announce a failed durable-hide as a non-destructive, self-removing
 * status chip near the affected card. Lives in presentation (not the content
 * script) so tests and the orchestrator hook share one implementation.
 */
export function announcePersistenceError(element: Element): void {
  const status = document.createElement('div');
  status.className = 'bts-status bts-persist-error';
  status.setAttribute('role', 'status');
  status.textContent = 'BlockTheSlop could not record this hide, so the video stays visible.';
  try {
    (element.parentElement ?? element).prepend(status);
    window.setTimeout(() => status.remove(), 8000);
  } catch {
    // Element went away mid-flight: nothing to announce.
  }
}

/**
 * Apply any decision; routes to warn/hide/restore.
 *
 * Idempotent per (state, action) pair. Re-applying the same action repairs a
 * missing UI (YouTube may have pruned it) but never duplicates one. A Show-once
 * override on the element takes precedence and is left untouched here — the
 * orchestrator decides when overrides expire.
 */
export function applyDecision(
  element: Element,
  decision: FilterDecision,
  candidate: NormalizedVideoCandidate,
  settings: UserSettings,
): void {
  if (element.getAttribute('data-bts-show-once') === 'true') return;
  const currentState = element.getAttribute(ATTR_STATE);
  const nextState = decision.action === 'allow' ? null : decision.action;

  if (currentState === nextState) {
    if (decision.action === 'allow') return;
    // Same action: repair only if the owned UI matches the REQUESTED
    // presentation. N04 blocker-4: a bare action-equality check prevented
    // displayMode transitions (placeholder ↔ collapse) from ever applying on
    // already-hidden cards — the UI must match the current mode, not just
    // exist.
    const owned = findOwned(element);
    const collapsed = element.getAttribute('data-bts-collapse') !== null;
    const uiPresent =
      decision.action === 'warn'
        ? owned.some((el) => el.classList.contains('bts-warn-marker'))
        : settings.displayMode === 'collapse'
          ? collapsed && owned.length === 0
          : owned.some(
              (el) =>
                el.classList.contains('bts-placeholder') ||
                el.classList.contains('bts-warn-marker'),
            ) && !collapsed;
    if (uiPresent) return;
  }

  switch (decision.action) {
    case 'allow':
      restore(element);
      break;
    case 'warn':
      warn(element, decision, candidate);
      break;
    case 'hide':
      hide(element, decision, candidate, settings);
      break;
  }
}
