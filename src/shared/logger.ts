/**
 * Debug logger, gated behind a debug flag that is OFF by default in
 * production. Never log page content, video titles, or history — only
 * coarse operational events and error objects.
 *
 * The console calls are centralized here; eslint no-console is disabled for
 * this file only (never blanket-disabled elsewhere).
 */
let debugEnabled = false;

export function setDebugEnabled(enabled: boolean): void {
  debugEnabled = enabled;
}

export function isDebugEnabled(): boolean {
  return debugEnabled;
}

/* eslint-disable no-console -- this module is the single console gateway */
export const logger = {
  debug(...args: unknown[]): void {
    if (debugEnabled) console.debug('[bts]', ...args);
  },
  warn(...args: unknown[]): void {
    // Warnings are allowed always but must never contain sensitive payloads.
    console.warn('[bts]', ...args);
  },
  error(...args: unknown[]): void {
    console.error('[bts]', ...args);
  },
};
/* eslint-enable no-console */
