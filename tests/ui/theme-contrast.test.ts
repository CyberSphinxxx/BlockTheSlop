import { describe, expect, it } from 'vitest';
import { THEMES } from '@/ui/theme-registry';

// Dynamic Node built-in imports for tests
declare const process: { cwd: () => string };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
declare function require(id: string): any;

const fs = require('node:fs');
const path = require('node:path');

function sRGBtoLinear(c: number): number {
  c = c / 255;
  return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

function luminance(hex: string): number {
  hex = hex.replace('#', '').trim();
  if (hex.length === 3)
    hex = hex
      .split('')
      .map((x) => x + x)
      .join('');
  const r = parseInt(hex.slice(0, 2), 16);
  const g = parseInt(hex.slice(2, 4), 16);
  const b = parseInt(hex.slice(4, 6), 16);
  return 0.2126 * sRGBtoLinear(r) + 0.7152 * sRGBtoLinear(g) + 0.0722 * sRGBtoLinear(b);
}

function contrastRatio(hex1: string, hex2: string): number {
  const l1 = luminance(hex1);
  const l2 = luminance(hex2);
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

describe('Theme contrast guard (WCAG AA 4.5:1 minimum)', () => {
  const palettesCss = fs.readFileSync(
    path.join(process.cwd(), 'src/ui/styles/palettes.css'),
    'utf8',
  ) as string;
  const themesCss = fs.readFileSync(
    path.join(process.cwd(), 'src/ui/styles/themes.css'),
    'utf8',
  ) as string;

  // Parse raw palette
  const palette: Record<string, string> = {};
  for (const match of palettesCss.matchAll(/(--[\w-]+)\s*:\s*(#[0-9a-fA-F]{3,8})/g)) {
    if (match[1] && match[2]) {
      palette[match[1]] = match[2];
    }
  }

  // Parse theme definitions
  function getThemeColors(themeId: string): Record<string, string> {
    const regex = new RegExp(`\\[data-theme=["']?${themeId}["']?\\][^{]*\\{([^}]+)\\}`, 'm');
    const match = themesCss.match(regex);
    if (!match || !match[1]) throw new Error(`Could not find CSS block for theme "${themeId}"`);
    const block = match[1];
    const colors: Record<string, string> = {};
    for (const line of block.split(';')) {
      const parts = line.split(':');
      if (parts.length >= 2) {
        const prop = (parts[0] ?? '').trim();
        const val = parts.slice(1).join(':').trim();
        const varMatch = val.match(/var\((--[\w-]+)\)/);
        if (varMatch && varMatch[1] && palette[varMatch[1]]) {
          colors[prop] = palette[varMatch[1]]!;
        } else if (val.startsWith('#')) {
          colors[prop] = val;
        }
      }
    }
    return colors;
  }

  it('all registered themes exist in themes.css and have valid palettes', () => {
    expect(THEMES.length).toBeGreaterThanOrEqual(2);
    for (const theme of THEMES) {
      const colors = getThemeColors(theme.id);
      expect(colors['--color-bg'], `${theme.id} --color-bg`).toBeDefined();
      expect(colors['--color-surface'], `${theme.id} --color-surface`).toBeDefined();
      expect(colors['--color-text'], `${theme.id} --color-text`).toBeDefined();
      expect(colors['--color-text-muted'], `${theme.id} --color-text-muted`).toBeDefined();
      expect(colors['--color-accent'], `${theme.id} --color-accent`).toBeDefined();
      expect(colors['--color-on-accent'], `${theme.id} --color-on-accent`).toBeDefined();
    }
  });

  for (const theme of THEMES) {
    it(`theme "${theme.id}" passes WCAG AA 4.5:1 contrast requirements`, () => {
      const colors = getThemeColors(theme.id);
      const text = colors['--color-text']!;
      const bg = colors['--color-bg']!;
      const surface = colors['--color-surface']!;
      const muted = colors['--color-text-muted']!;
      const accent = colors['--color-accent']!;
      const onAccent = colors['--color-on-accent']!;

      const textBgRatio = contrastRatio(text, bg);
      expect(
        textBgRatio,
        `${theme.id} text/bg contrast (${textBgRatio.toFixed(2)})`,
      ).toBeGreaterThanOrEqual(4.5);

      const textSurfaceRatio = contrastRatio(text, surface);
      expect(
        textSurfaceRatio,
        `${theme.id} text/surface contrast (${textSurfaceRatio.toFixed(2)})`,
      ).toBeGreaterThanOrEqual(4.5);

      const mutedBgRatio = contrastRatio(muted, bg);
      expect(
        mutedBgRatio,
        `${theme.id} muted/bg contrast (${mutedBgRatio.toFixed(2)})`,
      ).toBeGreaterThanOrEqual(4.5);

      const onAccentAccentRatio = contrastRatio(onAccent, accent);
      expect(
        onAccentAccentRatio,
        `${theme.id} on-accent/accent contrast (${onAccentAccentRatio.toFixed(2)})`,
      ).toBeGreaterThanOrEqual(4.5);
    });
  }
});
