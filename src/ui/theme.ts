/**
 * Specimen theme manager for BlockTheSlop.
 *
 * Supports registered themes: 'specimen-light' and 'specimen-dark', plus 'system'.
 * When 'system' is selected, follows `prefers-color-scheme` live.
 * Applies data-theme on the document root (and data-bts-theme for legacy compatibility).
 */
import { DEFAULT_THEME_ID, THEMES, type ThemeId } from './theme-registry';

export type ExtensionTheme = 'system' | ThemeId | 'light' | 'dark';

/**
 * Specimen layer 2 semantic tokens. Components consume ONLY these variables.
 */
export const SEMANTIC_TOKENS: readonly string[] = [
  '--color-bg',
  '--color-surface',
  '--color-text',
  '--color-text-muted',
  '--color-border',
  '--color-rule',
  '--color-accent',
  '--color-on-accent',
  '--color-accent-hover',
  '--color-danger',
  '--color-on-danger',
  '--color-success',
  '--color-focus',
];

/** Theme families that must define every token. */
export const THEME_FAMILIES: readonly ThemeId[] = THEMES.map((t) => t.id as ThemeId);

/** Read a custom property off an element (test/inspect helper). */
export function getComputedStyleToken(element: Element, token: string): string {
  return globalThis.getComputedStyle?.(element).getPropertyValue(token) ?? '';
}

export function systemPrefersDark(): boolean {
  return globalThis.matchMedia?.('(prefers-color-scheme: dark)').matches === true;
}

/** The resolved theme ID for a theme setting right now. */
export function resolveTheme(theme: string): ThemeId {
  if (theme === 'specimen-dark' || theme === 'dark') return 'specimen-dark';
  if (theme === 'specimen-light' || theme === 'light') return 'specimen-light';
  if (theme === 'system') {
    return systemPrefersDark() ? 'specimen-dark' : 'specimen-light';
  }
  return DEFAULT_THEME_ID;
}

/**
 * Apply the resolved theme to a document root. Idempotent. Returns a cleanup
 * that stops the live `prefers-color-scheme` listener (only when theme is
 * 'system'); safe to call repeatedly.
 */
export function applyThemeToDocument(doc: Document, theme: string): () => void {
  const root = doc.documentElement;
  const resolved = resolveTheme(theme);

  root.setAttribute('data-theme', resolved);
  // Keep legacy attribute, class and color-scheme for native elements/compatibility:
  const isDark = resolved === 'specimen-dark';
  root.setAttribute('data-bts-theme', isDark ? 'dark' : 'light');
  root.style.setProperty('color-scheme', isDark ? 'dark' : 'light');
  root.classList.toggle('bts-dark', isDark);

  // Cache in localStorage for immediate synchronous pre-paint application
  try {
    globalThis.localStorage?.setItem('bts-theme-setting', theme);
    globalThis.localStorage?.setItem('bts-resolved-theme', resolved);
  } catch {
    // Storage access might be restricted in some contexts
  }

  const media = globalThis.matchMedia?.('(prefers-color-scheme: dark)');
  const onChange = (): void => {
    if (theme !== 'system') return;
    const next: ThemeId = media?.matches === true ? 'specimen-dark' : 'specimen-light';
    root.setAttribute('data-theme', next);
    const nextIsDark = next === 'specimen-dark';
    root.setAttribute('data-bts-theme', nextIsDark ? 'dark' : 'light');
    root.style.setProperty('color-scheme', nextIsDark ? 'dark' : 'light');
    root.classList.toggle('bts-dark', nextIsDark);
    try {
      globalThis.localStorage?.setItem('bts-resolved-theme', next);
    } catch {
      // Ignore
    }
  };

  media?.addEventListener('change', onChange);
  return () => media?.removeEventListener('change', onChange);
}
