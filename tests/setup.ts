import '@testing-library/jest-dom/vitest';
import { beforeEach } from 'vitest';

// Deterministic, fast IDs where code does not rely on crypto randomness.
// (Code that needs randomness uses crypto.randomUUID directly in tests.)

/**
 * Minimal `browser.storage.local` + `onChanged` stub so integration-style
 * tests (orchestrator + real stores) run without the extension runtime.
 * Individual tests may override with vi.stubGlobal as before.
 */
beforeEach(() => {
  if ((globalThis as Record<string, unknown>)['browser'] !== undefined) return;
  const storage: Record<string, unknown> = {};
  const listeners = new Set<(c: unknown, area: string) => void>();
  const stub = {
    storage: {
      local: {
        get: async (key: string) => ({ [key]: storage[key] }),
        set: async (items: Record<string, unknown>) => {
          Object.assign(storage, items);
          for (const l of listeners) l({ ...items }, 'local');
        },
        remove: async (key: string) => {
          delete storage[key];
        },
      },
      onChanged: {
        addListener: (l: (c: unknown, area: string) => void) => listeners.add(l),
        removeListener: (l: (c: unknown, area: string) => void) => listeners.delete(l),
      },
    },
    runtime: { id: 'test-extension', getURL: (path: string) => `chrome-extension://test/${path}` },
  };
  (globalThis as Record<string, unknown>)['browser'] = stub;
});
