import type { FilterDecision } from '@/domain/decision';
import type { UserSettings } from '@/domain/settings';
import type { NormalizedVideoCandidate } from '@/domain/video';
import { ATTR_STATE, ATTR_VIDEO_ID, SELECTORS } from '@/youtube/selectors';
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
  /** User allowed the video from an overlay. */
  allowVideo(candidate: NormalizedVideoCandidate): void;
  /** User allowed the channel from an overlay. */
  allowChannel(candidate: NormalizedVideoCandidate): void;
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
  document.documentElement.style.setProperty('color-scheme', prefs.theme);
}

/** Every extension-owned element we may have inserted under a card. */
const OWNED_SELECTOR = '.bts-placeholder, .bts-overlay, .bts-status';

function findOwned(element: Element): Element[] {
  // Nested lookup: warn inserts under the thumbnail anchor, placeholder under
  // the card; cleanup/restore must find and remove all of them (audit A03).
  return [...element.querySelectorAll(`:scope ${OWNED_SELECTOR}`)];
}

function removeStaleState(element: Element): void {
  for (const owned of findOwned(element)) owned.remove();
  element.classList.remove('bts-show-placeholder');
  element.removeAttribute('data-bts-collapse');
}

/** Restore a card to its untouched state. Idempotent. */
export function restore(element: Element): void {
  element.removeAttribute(ATTR_STATE);
  element.removeAttribute(ATTR_VIDEO_ID);
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

function overlayFor(
  element: Element,
  decision: FilterDecision,
  candidate: NormalizedVideoCandidate,
  callbacksValue: PresentationCallbacks,
): HTMLElement {
  const overlay = document.createElement('div');
  overlay.className = 'bts-overlay';
  overlay.setAttribute('role', 'status');

  const headline = document.createElement('div');
  headline.className = 'bts-overlay-headline';
  headline.textContent = decision.explanation[0] ?? 'Filtered by BlockTheSlop';
  overlay.appendChild(headline);

  if (decision.explanation.length > 1) {
    const list = document.createElement('ul');
    list.className = 'bts-overlay-reasons';
    for (const line of decision.explanation.slice(1, 4)) {
      const li = document.createElement('li');
      li.textContent = line;
      list.appendChild(li);
    }
    overlay.appendChild(list);
  }

  const actions = document.createElement('div');
  actions.className = 'bts-overlay-actions';
  actions.appendChild(button('Show once', () => callbacksValue.showOnce(element)));
  actions.appendChild(button('Why?', () => callbacksValue.why(element)));
  actions.appendChild(button('Allow video', () => callbacksValue.allowVideo(candidate)));
  if (candidate.channel.channelId !== undefined || candidate.channel.handle !== undefined) {
    actions.appendChild(button('Allow channel', () => callbacksValue.allowChannel(candidate)));
  }
  overlay.appendChild(actions);

  return overlay;
}

function placeholderFor(
  element: Element,
  decision: FilterDecision,
  candidate: NormalizedVideoCandidate,
  callbacksValue: PresentationCallbacks,
): HTMLElement {
  const placeholder = document.createElement('div');
  placeholder.className = 'bts-placeholder';
  placeholder.setAttribute('role', 'status');

  const title = document.createElement('div');
  title.className = 'bts-placeholder-title';
  title.textContent = 'Hidden by BlockTheSlop';
  placeholder.appendChild(title);

  const reason = document.createElement('div');
  reason.textContent = decision.explanation[0] ?? 'Matched your filters';
  placeholder.appendChild(reason);

  const actions = document.createElement('div');
  actions.className = 'bts-placeholder-actions';
  actions.appendChild(button('Show once', () => callbacksValue.showOnce(element)));
  actions.appendChild(button('Why?', () => callbacksValue.why(element)));
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
    element.querySelector<HTMLElement>(':scope .bts-placeholder, :scope .bts-overlay') ??
    (element as HTMLElement);
  const existing = host.querySelector<HTMLElement>(':scope .bts-why-details');
  if (existing !== null) {
    existing.remove();
    return false;
  }
  whyDetailsFor(decision, candidate, host as HTMLElement);
  return true;
}

/** The thumbnail anchor for warn overlays; marks inline styles we add. */
function warnAnchor(element: Element): HTMLElement {
  const anchor =
    element.querySelector<HTMLElement>(SELECTORS.thumbnail.join(',')) ?? (element as HTMLElement);
  if (getComputedStyle(anchor).position === 'static') {
    anchor.style.position = 'relative';
    anchor.setAttribute(INLINE_MARK, '');
  }
  return anchor;
}

/** Warn overlay anchored over the card's thumbnail area. */
export function warn(
  element: Element,
  decision: FilterDecision,
  candidate: NormalizedVideoCandidate,
): void {
  if (callbacks === null) return;
  removeStaleState(element);
  element.setAttribute(ATTR_STATE, 'warn');
  if (candidate.videoId !== undefined) element.setAttribute(ATTR_VIDEO_ID, candidate.videoId);
  element.removeAttribute('data-bts-collapse');
  warnAnchor(element).appendChild(overlayFor(element, decision, candidate, callbacks));
}

/** Hide a card: placeholder mode suppresses native children; collapse removes the slot. */
export function hide(
  element: Element,
  decision: FilterDecision,
  candidate: NormalizedVideoCandidate,
  settings: UserSettings,
): void {
  if (callbacks === null) return;
  removeStaleState(element);
  element.setAttribute(ATTR_STATE, 'hidden');
  if (candidate.videoId !== undefined) element.setAttribute(ATTR_VIDEO_ID, candidate.videoId);
  if (settings.displayMode === 'collapse') {
    // Entire layout slot removed; siblings untouched (R03/PRE-02).
    element.setAttribute('data-bts-collapse', '');
    return;
  }
  element.appendChild(placeholderFor(element, decision, candidate, callbacks));
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
    // Same action: repair only if the owned UI vanished.
    const owned = findOwned(element);
    const uiPresent =
      decision.action === 'warn'
        ? owned.some((el) => el.classList.contains('bts-overlay'))
        : settings.displayMode === 'collapse' ||
          owned.some((el) => el.classList.contains('bts-placeholder'));
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
