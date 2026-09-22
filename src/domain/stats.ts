/** Local-only usage statistics. Never transmitted by default (see security spec). */
export interface LocalStats {
  cardsEvaluated: number;
  hidden: number;
  warned: number;
  restored: number;
  manualBlocks: number;
  falsePositiveCorrections: number;
  rulesTriggered: number;
  /** Duration of classification batches in ms, bucketed. */
  processingBatches: number;
  totalProcessingMs: number;
  maxProcessingMs: number;
  /** Epoch ms of the last stats reset. */
  resetAt: number;
}

export const STATS_SCHEMA_VERSION = 1 as const;

export function defaultStats(): LocalStats {
  return {
    cardsEvaluated: 0,
    hidden: 0,
    warned: 0,
    restored: 0,
    manualBlocks: 0,
    falsePositiveCorrections: 0,
    rulesTriggered: 0,
    processingBatches: 0,
    totalProcessingMs: 0,
    maxProcessingMs: 0,
    resetAt: Date.now(),
  };
}

const NUMERIC_FIELDS: readonly (keyof LocalStats)[] = [
  'cardsEvaluated',
  'hidden',
  'warned',
  'restored',
  'manualBlocks',
  'falsePositiveCorrections',
  'rulesTriggered',
  'processingBatches',
  'totalProcessingMs',
  'maxProcessingMs',
  'resetAt',
];

/** Sanitize stats loaded from storage; corrupt fields reset to defaults. */
export function validateStats(raw: unknown): LocalStats {
  const base = defaultStats();
  if (typeof raw !== 'object' || raw === null) return base;
  const record = raw as Record<string, unknown>;
  const out = { ...base };
  for (const field of NUMERIC_FIELDS) {
    const value = record[field];
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
      (out[field] as number) = Math.min(value, Number.MAX_SAFE_INTEGER);
    }
  }
  return out;
}

export type StatsDelta = Partial<Record<Exclude<keyof LocalStats, 'resetAt'>, number>>;
