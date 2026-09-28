import { describe, expect, it } from 'vitest';
import {
  getComputedStyleToken,
  resolveTheme,
  SEMANTIC_TOKENS,
  THEME_FAMILIES,
  applyThemeToDocument,
} from '@/ui/theme';

describe('semantic token set (Specimen)', () => {
  it('defines the full semantic vocabulary used by extension pages', () => {
    for (const token of [
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
    ]) {
      expect(SEMANTIC_TOKENS).toContain(token);
    }
  });

  it('every token resolves in BOTH light and dark palettes (no missing fallback)', () => {
    expect([...THEME_FAMILIES].sort()).toEqual(['specimen-dark', 'specimen-light']);
  });

  it('theme resolution is deterministic', () => {
    expect(resolveTheme('specimen-light')).toBe('specimen-light');
    expect(resolveTheme('specimen-dark')).toBe('specimen-dark');
    expect(resolveTheme('light')).toBe('specimen-light');
    expect(resolveTheme('dark')).toBe('specimen-dark');
    // 'system' resolves via matchMedia; jsdom reports light by default.
    expect(['specimen-light', 'specimen-dark']).toContain(resolveTheme('system'));
  });

  it('applyThemeToDocument sets the token-bearing attribute idempotently', () => {
    const doc = document;
    const cleanup = applyThemeToDocument(doc, 'specimen-dark');
    expect(doc.documentElement.getAttribute('data-theme')).toBe('specimen-dark');
    applyThemeToDocument(doc, 'specimen-dark');
    expect(doc.documentElement.getAttribute('data-theme')).toBe('specimen-dark');
    cleanup();
  });
});

describe('computed token application (Specimen)', () => {
  it('tokens are declared on :root and overridable per theme', () => {
    const root = document.documentElement;
    for (const token of SEMANTIC_TOKENS) {
      const probe = document.createElement('style');
      probe.textContent = `:root { ${token}: initial; }`;
      document.head.appendChild(probe);
      expect(typeof getComputedStyleToken(root, token)).toBe('string');
      probe.remove();
    }
  });
});
