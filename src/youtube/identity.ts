/**
 * Per-element processing state, keyed by (element, identity signature).
 *
 * YouTube recycles DOM nodes for different videos, so an element must be
 * re-processed whenever its parsed identity changes. A plain WeakMap keyed
 * only by element would wrongly treat a recycled node as already processed;
 * the stored signature guards against that.
 */
const stateByElement = new WeakMap<Element, string>();

/**
 * Processing epoch: bumping it forces every card to reprocess on its next
 * sighting (used when filtering is re-enabled or settings change materially).
 */
let epoch = 0;

export function bumpEpoch(): void {
  epoch += 1;
}

/**
 * Returns true when this element+identity combination has already been
 * processed. Records the new signature otherwise.
 */
export function shouldProcess(element: Element, identitySignature: string): boolean {
  const signature = `${epoch}:${identitySignature}`;
  const previous = stateByElement.get(element);
  if (previous === signature) return false;
  stateByElement.set(element, signature);
  return true;
}

/** Clear processing state (used when the extension is disabled/re-enabled). */
export function forget(element: Element): void {
  stateByElement.delete(element);
}
