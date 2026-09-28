export interface ThemeEntry {
  readonly id: string;
  readonly label: string;
}

export const THEMES: readonly ThemeEntry[] = [
  { id: 'specimen-light', label: 'Specimen light' },
  { id: 'specimen-dark', label: 'Specimen dark' },
] as const;

export type ThemeId = (typeof THEMES)[number]['id'];

export const DEFAULT_THEME_ID: ThemeId = 'specimen-light';

export const SYSTEM_THEME_OPTION = {
  id: 'system',
  label: 'Match system',
} as const;
