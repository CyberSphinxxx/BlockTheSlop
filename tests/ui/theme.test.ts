import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyThemeToDocument, resolveTheme } from '@/ui/theme';

/**
 * N15/CFG-10: the theme setting must produce a REAL visible difference on
 * extension-owned pages. These tests verify the document-root contract the
 * CSS consumes (data-bts-theme + .bts-dark + color-scheme), including live
 * OS-preference tracking for 'system'.
 */

const originalMatchMedia = globalThis.matchMedia;

function setSystemDark(dark: boolean): void {
  globalThis.matchMedia = ((query: string) => ({
    matches: query.includes('dark') ? dark : false,
    addEventListener: () => {},
    removeEventListener: () => {},
  })) as unknown as typeof matchMedia;
}

describe('N15: theme resolution and application', () => {
  beforeEach(() => {
    document.documentElement.removeAttribute('data-bts-theme');
    document.documentElement.classList.remove('bts-dark');
    document.documentElement.style.removeProperty('color-scheme');
  });

  afterEach(() => {
    globalThis.matchMedia = originalMatchMedia;
  });

  it('resolveTheme follows the OS for system and forces explicit values', () => {
    setSystemDark(true);
    expect(resolveTheme('system')).toBe('dark');
    expect(resolveTheme('light')).toBe('light');
    expect(resolveTheme('dark')).toBe('dark');
    setSystemDark(false);
    expect(resolveTheme('system')).toBe('light');
  });

  it('dark theme visibly flips the root contract (attribute, class, color-scheme)', () => {
    const dispose = applyThemeToDocument(document, 'dark');
    expect(document.documentElement.getAttribute('data-bts-theme')).toBe('dark');
    expect(document.documentElement.classList.contains('bts-dark')).toBe(true);
    expect(document.documentElement.style.getPropertyValue('color-scheme')).toBe('dark');
    dispose();
  });

  it('light theme flips back', () => {
    applyThemeToDocument(document, 'dark')();
    const dispose = applyThemeToDocument(document, 'light');
    expect(document.documentElement.getAttribute('data-bts-theme')).toBe('light');
    expect(document.documentElement.classList.contains('bts-dark')).toBe(false);
    expect(document.documentElement.style.getPropertyValue('color-scheme')).toBe('light');
    dispose();
  });

  it('system theme resolves from the OS preference and tracks changes live', () => {
    setSystemDark(false);
    let list: { matches: boolean } | null = null;
    globalThis.matchMedia = ((query: string) => {
      const o = {
        matches: query.includes('dark') ? false : false,
        listeners: [] as Array<() => void>,
        addEventListener: (_: string, cb: () => void) => {
          o.listeners.push(cb);
        },
        removeEventListener: (_: string, cb: () => void) => {
          o.listeners = o.listeners.filter((l) => l !== cb);
        },
      };
      list = o as unknown as { matches: boolean };
      return o as unknown as MediaQueryList;
    }) as unknown as typeof matchMedia;

    const dispose = applyThemeToDocument(document, 'system');
    expect(document.documentElement.getAttribute('data-bts-theme')).toBe('light');

    // OS flips to dark: the page follows, live.
    const o = list as unknown as { matches: boolean; listeners: Array<() => void> };
    o.matches = true;
    for (const cb of o.listeners) cb();
    expect(document.documentElement.getAttribute('data-bts-theme')).toBe('dark');
    expect(document.documentElement.classList.contains('bts-dark')).toBe(true);
    dispose();
  });
});
