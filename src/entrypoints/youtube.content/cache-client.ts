import { classificationFromSlot, type NormalizedCached } from '@/pipeline/orchestrator';
import { MAX_BATCH_INPUTS } from '@/storage/fingerprint';

/**
 * N08 cache client (content side).
 *
 * - Chunks lookups and writes to the wire limit (MAX_BATCH_INPUTS) so large
 *   batches (a 500-card grid) still get ONE request per chunk instead of a
 *   rejected oversized message (= all-miss degradation on exactly the huge
 *   pages where the cache matters most).
 * - Every chunk is individually guarded: a failed chunk degrades to misses
 *   for its own range; the other chunks still hit. A cache failure can only
 *   cost speed, never correctness.
 * - Response slots are sanitized through classificationFromSlot: JSON
 *   transports turn undefined holes into null, and a junk slot must never
 *   be mistaken for a classification.
 */

/** Per-chunk cache lookup; returns one sanitized slot per input. */
export type CacheGetChunk = (
  inputs: readonly unknown[],
) => Promise<Array<NormalizedCached | undefined>>;

/** Per-chunk cache write (best-effort; failures are swallowed). */
export type CachePutChunk = (
  inputs: readonly unknown[],
  classifications: readonly NormalizedCached[],
) => Promise<void>;

export async function chunkedGet(
  inputs: readonly unknown[],
  sendChunk: CacheGetChunk,
): Promise<Array<NormalizedCached | undefined>> {
  if (inputs.length === 0) return [];
  const out: Array<NormalizedCached | undefined> = new Array(inputs.length).fill(undefined);
  for (let start = 0; start < inputs.length; start += MAX_BATCH_INPUTS) {
    const slice = inputs.slice(start, start + MAX_BATCH_INPUTS);
    try {
      const hits = await sendChunk(slice);
      if (Array.isArray(hits) && hits.length === slice.length) {
        hits.forEach((hit, i) => {
          out[start + i] = classificationFromSlot(hit);
        });
      }
      // A short/malformed chunk response leaves its range as misses.
    } catch {
      // Chunk-level degradation: this range stays all-miss.
    }
  }
  return out;
}

export async function chunkedPut(
  inputs: readonly unknown[],
  classifications: readonly NormalizedCached[],
  sendChunk: CachePutChunk,
): Promise<void> {
  if (inputs.length === 0 || inputs.length !== classifications.length) return;
  for (let start = 0; start < inputs.length; start += MAX_BATCH_INPUTS) {
    try {
      await sendChunk(
        inputs.slice(start, start + MAX_BATCH_INPUTS),
        classifications.slice(start, start + MAX_BATCH_INPUTS),
      );
    } catch {
      // Writes are best-effort: the next lookup is a miss and re-classifies.
    }
  }
}
