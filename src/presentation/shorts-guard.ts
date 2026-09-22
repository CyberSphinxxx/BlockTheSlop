import type { FilterDecision } from '@/domain/decision';
import type { NormalizedVideoCandidate } from '@/domain/video';

/**
 * Opt-in active Shorts playback guard (product contract §1, R09/DOM-24).
 *
 * When enabled and the ACTIVE Short matches hide criteria: pause playback
 * and cover the player with accessible controls. Never auto-skip, never
 * autoplay another video, and preserve native controls when disabled.
 * The cover is extension-owned UI rendered from text only (XSS contract).
 */

const COVER_ID = 'bts-shorts-guard';
const STYLE_ID = 'bts-shorts-guard-style';

const GUARD_CSS = `
#${COVER_ID} {
  position: fixed;
  inset: 0;
  z-index: 2147483647;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  background: rgba(8, 8, 8, 0.94);
  color: #f1f1f1;
  padding: 24px;
  text-align: center;
}
#${COVER_ID} .bts-guard-title {
  font-size: 18px;
  font-weight: 600;
  max-width: 560px;
  overflow-wrap: anywhere;
}
#${COVER_ID} .bts-guard-detail {
  font-size: 13px;
  opacity: 0.85;
  max-width: 560px;
  overflow-wrap: anywhere;
}
#${COVER_ID} .bts-button {
  cursor: pointer;
}
`;

function ensureGuardStyles(): void {
  if (document.getElementById(STYLE_ID) !== null) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = GUARD_CSS;
  document.head.appendChild(style);
}

function guardButton(label: string, onClick: () => void): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'bts-button';
  btn.textContent = label;
  btn.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    onClick();
  });
  return btn;
}

/** Pause every playing media element (the Shorts player included). */
function pausePlayback(): void {
  for (const video of document.querySelectorAll('video')) {
    try {
      video.pause();
    } catch {
      // A paused/detached element throws in some engines — ignore.
    }
  }
}

/**
 * Pause the active Short and cover the player. Returns true when applied.
 * Idempotent: an existing cover is replaced, never duplicated.
 */
export function pauseAndCoverShorts(
  candidate: NormalizedVideoCandidate,
  decision: FilterDecision,
): boolean {
  ensureGuardStyles();
  pausePlayback();
  removeShortsGuard();

  const cover = document.createElement('div');
  cover.id = COVER_ID;
  cover.setAttribute('role', 'alertdialog');
  cover.setAttribute('aria-modal', 'true');
  cover.setAttribute('aria-label', 'Blocked Short — BlockTheSlop');

  const title = document.createElement('div');
  title.className = 'bts-guard-title';
  title.textContent =
    candidate.title.length > 0 ? candidate.title : 'This Short matched your filters';
  cover.appendChild(title);

  const detail = document.createElement('div');
  detail.className = 'bts-guard-detail';
  detail.textContent = decision.explanation[0] ?? 'Hidden by BlockTheSlop. Playback is paused.';
  cover.appendChild(detail);

  const actions = document.createElement('div');
  actions.className = 'bts-overlay-actions';
  // The only escape is user-deliberate: resume means removing our guard and
  // restoring native controls. No auto-skip, no autoplay of another video.
  actions.appendChild(
    guardButton('Resume Short (show this time)', () => {
      removeShortsGuard();
    }),
  );
  cover.appendChild(actions);

  document.body.appendChild(cover);
  const firstButton = cover.querySelector('button');
  firstButton?.focus();
  return true;
}

/** Remove the guard cover and restore native player behavior. */
export function removeShortsGuard(): void {
  document.getElementById(COVER_ID)?.remove();
  // Also remove when YouTube re-parents it (defensive; id lookup is primary).
  document.querySelectorAll(`#${COVER_ID}`).forEach((el) => el.remove());
}
