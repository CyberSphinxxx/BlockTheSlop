import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyThemeToDocument, resolveTheme } from '@/ui/theme';

/**
 * Specimen theme resolution and application tests.
 * Verifies data-theme attribute on root, live system preference tracking,
 * and backwards-compatible data-bts-theme and color-scheme settings.
 */

const originalMatchMedia = globalThis.matchMedia;

function setSystemDark(dark: boolean): void {
  globalThis.matchMedia = ((query: string) => ({
    matches: query.includes('dark') ? dark : false,
    addEventListener: () => {},
    removeEventListener: () => {},
  })) as unknown as typeof matchMedia;
}

describe('Specimen: theme resolution and application', () => {
  beforeEach(() => {
    document.documentElement.removeAttribute('data-theme');
    document.documentElement.removeAttribute('data-bts-theme');
    document.documentElement.classList.remove('bts-dark');
    document.documentElement.style.removeProperty('color-scheme');
  });

  afterEach(() => {
    globalThis.matchMedia = originalMatchMedia;
  });

  it('resolveTheme follows the OS for system and forces explicit values', () => {
    setSystemDark(true);
    expect(resolveTheme('system')).toBe('specimen-dark');
    expect(resolveTheme('specimen-light')).toBe('specimen-light');
    expect(resolveTheme('specimen-dark')).toBe('specimen-dark');
    expect(resolveTheme('light')).toBe('specimen-light');
    expect(resolveTheme('dark')).toBe('specimen-dark');
    setSystemDark(false);
    expect(resolveTheme('system')).toBe('specimen-light');
  });

  it('dark theme visibly flips the root contract (data-theme, attribute, class, color-scheme)', () => {
    const dispose = applyThemeToDocument(document, 'specimen-dark');
    expect(document.documentElement.getAttribute('data-theme')).toBe('specimen-dark');
    expect(document.documentElement.getAttribute('data-bts-theme')).toBe('dark');
    expect(document.documentElement.classList.contains('bts-dark')).toBe(true);
    expect(document.documentElement.style.getPropertyValue('color-scheme')).toBe('dark');
    dispose();
  });

  it('light theme flips back', () => {
    applyThemeToDocument(document, 'specimen-dark')();
    const dispose = applyThemeToDocument(document, 'specimen-light');
    expect(document.documentElement.getAttribute('data-theme')).toBe('specimen-light');
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
    expect(document.documentElement.getAttribute('data-theme')).toBe('specimen-light');
    expect(document.documentElement.getAttribute('data-bts-theme')).toBe('light');

    // OS flips to dark: the page follows, live.
    const o = list as unknown as { matches: boolean; listeners: Array<() => void> };
    o.matches = true;
    for (const cb of o.listeners) cb();
    expect(document.documentElement.getAttribute('data-theme')).toBe('specimen-dark');
    expect(document.documentElement.getAttribute('data-bts-theme')).toBe('dark');
    expect(document.documentElement.classList.contains('bts-dark')).toBe(true);
    dispose();
  });
});
