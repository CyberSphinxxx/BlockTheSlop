import { ATTR_STATE } from '@/youtube/selectors';

/** Remove all extension state from the page (used when disabling filtering). */
export function cleanupAll(root: ParentNode = document): void {
  for (const el of root.querySelectorAll(`[${ATTR_STATE}]`)) {
    restoreRecursively(el);
  }
  root.querySelectorAll('.bts-manual-action, .bts-activity-notice').forEach((el) => el.remove());
}

/** Restore one card subtree: markers, owned UI, inline styles. Idempotent. */
export function restoreRecursively(element: Element): void {
  element.removeAttribute(ATTR_STATE);
  element.removeAttribute('data-bts-video-id');
  element.removeAttribute('data-bts-collapse');
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
