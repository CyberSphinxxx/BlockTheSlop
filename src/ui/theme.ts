/**
 * N15/CFG-10: real, immediate theming for extension-owned pages.
 *
 * The options/popup `theme` setting must have a VISIBLE end-to-end effect:
 * - 'system'  → follow `prefers-color-scheme` (and track changes live);
 * - 'light'   → force the light palette;
 * - 'dark'    → force the dark palette.
 *
 * Applied on the document root (`color-scheme` + `data-bts-theme`) so native
 * controls, scrollbars and Tailwind `dark:` variants all respond. Both pages
 * call `applyThemeToDocument` on load and on every settings change.
 */

export type ExtensionTheme = 'system' | 'light' | 'dark';

/**
 * V6-13: the SEMANTIC token vocabulary. Components reference tokens, never
 * raw palettes — a future theme only needs to define these variables.
 */
export const SEMANTIC_TOKENS: readonly string[] = [
  '--bts-page-bg',
  '--bts-page-fg',
  '--bts-muted',
  '--bts-panel',
  '--bts-border',
  '--bts-accent',
  '--bts-accent-fg',
  '--bts-danger',
  '--bts-ok',
  '--bts-focus-ring',
];

/** Theme families that must define every token (future themes extend this). */
export const THEME_FAMILIES: readonly ('light' | 'dark')[] = ['light', 'dark'];

/** Read a custom property off an element (test/inspect helper). */
export function getComputedStyleToken(element: Element, token: string): string {
  return globalThis.getComputedStyle?.(element).getPropertyValue(token) ?? '';
}

function systemPrefersDark(): boolean {
  return globalThis.matchMedia?.('(prefers-color-scheme: dark)').matches === true;
}

/** The resolved palette for a theme setting right now. */
export function resolveTheme(theme: ExtensionTheme): 'light' | 'dark' {
  if (theme === 'system') return systemPrefersDark() ? 'dark' : 'light';
  return theme;
}

/**
 * Apply the resolved theme to a document root. Idempotent. Returns a cleanup
 * that stops the live `prefers-color-scheme` listener (only when theme is
 * 'system'); safe to call repeatedly.
 */
export function applyThemeToDocument(doc: Document, theme: ExtensionTheme): () => void {
  const root = doc.documentElement;
  const resolved = resolveTheme(theme);
  root.setAttribute('data-bts-theme', resolved);
  root.style.setProperty('color-scheme', resolved);
  root.classList.toggle('bts-dark', resolved === 'dark');

  const media = globalThis.matchMedia?.('(prefers-color-scheme: dark)');
  const onChange = (): void => {
    if (theme !== 'system') return;
    // Read the CAPTURED live MediaQueryList — re-querying could return a
    // snapshot; the captured object reflects OS changes.
    const next: 'light' | 'dark' = media?.matches === true ? 'dark' : 'light';
    root.setAttribute('data-bts-theme', next);
    root.style.setProperty('color-scheme', next);
    root.classList.toggle('bts-dark', next === 'dark');
  };
  media?.addEventListener('change', onChange);
  return () => media?.removeEventListener('change', onChange);
}
