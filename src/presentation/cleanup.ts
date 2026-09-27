import { ATTR_STATE } from '@/youtube/selectors';
import {
  ATTR_SLOT_COLLAPSE,
  SLOT_COLLAPSE_VALUE,
  clearOrphanedCollapseSlots,
} from '@/presentation/apply-decision';

/**
 * Remove all extension state from the page (used when disabling filtering,
 * extension-context teardown, and SPA navigation resets).
 *
 * Audit Finding 1: collapse-slot marks live on OUTER wrappers that are not
 * themselves extension-marked with data-bts-state, and a marked wrapper may
 * no longer contain its card (YouTube recycles slot wrappers wholesale). The
 * first selector group therefore walks BOTH marked cards AND slot-marked
 * wrappers directly, so orphaned marks on recycled wrappers are cleared too.
 */
export function cleanupAll(root: ParentNode = document): void {
  for (const el of root.querySelectorAll(`[${ATTR_STATE}]`)) {
    restoreRecursively(el);
  }
  for (const el of root.querySelectorAll(`[${ATTR_SLOT_COLLAPSE}="${SLOT_COLLAPSE_VALUE}"]`)) {
    restoreRecursively(el);
  }
  // Audit Finding 1: a marked wrapper may no longer hold its card (YouTube
  // recycles slot wrappers wholesale); the walk above misses that orphan, so
  // sweep any mark left hiding content we never decided on.
  clearOrphanedCollapseSlots(root);
  root.querySelectorAll('.bts-manual-action, .bts-activity-notice').forEach((el) => el.remove());
}

/** Restore one card subtree: markers, owned UI, inline styles. Idempotent. */
export function restoreRecursively(element: Element): void {
  element.removeAttribute(ATTR_STATE);
  element.removeAttribute('data-bts-video-id');
  element.removeAttribute('data-bts-collapse');
  // Audit Finding 1: the collapse-slot mark is EXTENSION-OWNED (set by
  // markCollapseSlot in apply-decision.ts). Clear it unconditionally when a
  // restore reaches the marked element — including when this call was scoped
  // to the wrapper itself because the card it marked has moved on or been
  // replaced. Never touches any YouTube-owned attribute.
  element.removeAttribute(ATTR_SLOT_COLLAPSE);
  // Nested removal (audit A03): warn overlays live under the thumbnail
  // anchor, placeholders under the card — clean every owned descendant.
  element
    .querySelectorAll(
      '.bts-overlay, .bts-placeholder, .bts-warn-marker, .bts-status, .bts-manual-action',
    )
    .forEach((n) => n.remove());
  element.classList.remove('bts-show-placeholder');
  // Restore inline styles we set on warn anchors.
  element.querySelectorAll('[data-bts-inline]').forEach((n) => {
    (n as HTMLElement).style.removeProperty('position');
    n.removeAttribute('data-bts-inline');
  });
  if (element.hasAttribute('data-bts-inline')) {
    (element as HTMLElement).style.removeProperty('position');
    element.removeAttribute('data-bts-inline');
  }
}
