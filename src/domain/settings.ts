import type { EvidenceCategory } from './evidence';
import { EVIDENCE_CATEGORIES } from './evidence';
import type { Surface } from './video';

export type FilterMode = 'safe' | 'balanced' | 'strict';
export type CategoryAction = 'allow' | 'warn' | 'hide' | 'inherit';
/** How a hidden card is presented: styled placeholder (default) or full collapse. */
export type DisplayMode = 'placeholder' | 'collapse';
/** Processing preset — controls actual bounded-queue parameters (CFG-09). */
export type ProcessingPreset = 'battery' | 'balanced' | 'quality';
/** Placeholder text density on hidden cards (CFG-10). */
export type Density = 'comfortable' | 'compact';
/** Color scheme for extension-owned pages (CFG-10); 'system' follows the OS. */
export type Theme = 'system' | 'light' | 'dark';

/** Surfaces the extension can filter; 'unknown' is deliberately absent. */
export const SUPPORTED_SURFACES: readonly Surface[] = [
  'home',
  'search',
  'subscriptions',
  'watch-sidebar',
  'channel',
  'playlist',
  'history',
  'watch-later',
  'shorts-shelf',
  'shorts-feed',
];

function defaultSurfaceToggles(): Record<Surface, boolean> {
  const out = {} as Record<Surface, boolean>;
  for (const s of SUPPORTED_SURFACES) out[s] = true;
  return out;
}

/** Bounded-queue parameters each preset controls (real behavior, CFG-09). */
export interface QueueLimits {
  /** Max cards evaluated per processing tick before yielding. */
  maxCardsPerTick: number;
  /** Yield between ticks in ms. */
  yieldMs: number;
}

export const QUEUE_LIMITS: Record<ProcessingPreset, QueueLimits> = {
  battery: { maxCardsPerTick: 10, yieldMs: 200 },
  balanced: { maxCardsPerTick: 40, yieldMs: 50 },
  quality: { maxCardsPerTick: 120, yieldMs: 0 },
};

export function queueLimitsFor(preset: ProcessingPreset): QueueLimits {
  return QUEUE_LIMITS[preset] ?? QUEUE_LIMITS['balanced'];
}

export interface RemoteProviderSettings {
  /** Default OFF — the core extension never requires a remote service. */
  enabled: boolean;
  /** HTTPS endpoint of the optional community reputation provider. */
  endpoint?: string | undefined;
  /** Timeout for provider requests in milliseconds. */
  timeoutMs: number;
}

export interface UserSettings {
  enabled: boolean;
  mode: FilterMode;

  categoryActions: Record<EvidenceCategory, CategoryAction>;

  /** Placeholder shows a styled replacement; collapse removes the layout slot. */
  displayMode: DisplayMode;
  showExplanations: boolean;
  collectLocalStats: boolean;

  /** Per-surface filtering toggles (product contract §5 Filtering group). */
  surfaces: Record<Surface, boolean>;

  /**
   * Opt-in active Shorts playback guard (product contract §1): when ON, a
   * matched active Short is paused and covered; default OFF — the player
   * behavior is preserved and shelf filtering stays enabled.
   */
  shortsGuard: { enabled: boolean };

  /** Processing preset controlling bounded-queue behavior. */
  performance: { preset: ProcessingPreset };

  /**
   * Persistent review history (PRE-13): when OFF no durable history is
   * written; automatic hides keep bounded tab-session recovery only and the
   * review UI explains the loss of persistent review.
   */
  history: { enabled: boolean; retentionDays: number };

  /** Placeholder text density on hidden cards (CFG-10). */
  density: Density;

  /** Color scheme for extension-owned pages (CFG-10). */
  theme: Theme;

  /** Additive text rule packs beyond English (CFG-09 real behavior). */
  rulePacks: { fil: boolean };
  /**
   * "Also tell YouTube Not interested" — changes the user's YouTube account
   * state, therefore default OFF and never invoked silently.
   */
  youtubeFeedback: {
    enabled: boolean;
  };

  remoteProvider: RemoteProviderSettings;
}

/** Current settings schema version. Bump when shape changes; add migration. */
export const SETTINGS_SCHEMA_VERSION = 5 as const;

/** Retention bounds (DATA-07): deterministic and documented. */
export const HISTORY_RETENTION_MIN_DAYS = 1;
export const HISTORY_RETENTION_MAX_DAYS = 365;
export const HISTORY_RETENTION_DEFAULT_DAYS = 30;

function defaultCategoryActions(): Record<EvidenceCategory, CategoryAction> {
  const actions = {} as Record<EvidenceCategory, CategoryAction>;
  for (const c of EVIDENCE_CATEGORIES) {
    actions[c] = 'inherit';
  }
  // Conservative defaults: thumbnails and discussion are not the video itself.
  actions['ai-thumbnail'] = 'warn';
  actions['ai-discussion'] = 'allow';
  // 04 §8: the dedicated generated-content policy maps UNSPECIFIED disclosure
  // (e.g. YouTube's altered/synthetic label) intentionally to hide — the
  // evidence itself never claims a modality; this policy decision does.
  actions['ai-unspecified'] = 'hide';
  return actions;
}

export function defaultSettings(): UserSettings {
  return {
    enabled: true,
    mode: 'balanced',
    categoryActions: defaultCategoryActions(),
    displayMode: 'placeholder',
    showExplanations: true,
    collectLocalStats: true,
    surfaces: defaultSurfaceToggles(),
    shortsGuard: { enabled: false },
    performance: { preset: 'balanced' },
    history: { enabled: true, retentionDays: HISTORY_RETENTION_DEFAULT_DAYS },
    density: 'comfortable',
    theme: 'system',
    rulePacks: { fil: true },
    youtubeFeedback: { enabled: false },
    remoteProvider: { enabled: false, timeoutMs: 5000 },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const FILTER_MODES: readonly FilterMode[] = ['safe', 'balanced', 'strict'];
const CATEGORY_ACTIONS: readonly CategoryAction[] = ['allow', 'warn', 'hide', 'inherit'];
const PROCESSING_PRESETS: readonly ProcessingPreset[] = ['battery', 'balanced', 'quality'];
const DENSITIES: readonly Density[] = ['comfortable', 'compact'];
const THEMES: readonly Theme[] = ['system', 'light', 'dark'];

/** Structural validation used on load and on import. Never trust stored JSON. */
export function validateSettings(raw: unknown): UserSettings | null {
  if (!isRecord(raw)) return null;
  const defaults = defaultSettings();

  const enabled = typeof raw['enabled'] === 'boolean' ? raw['enabled'] : defaults.enabled;
  const mode = FILTER_MODES.includes(raw['mode'] as FilterMode)
    ? (raw['mode'] as FilterMode)
    : defaults.mode;

  const categoryActions = defaults.categoryActions;
  if (isRecord(raw['categoryActions'])) {
    for (const key of Object.keys(raw['categoryActions'])) {
      const value = raw['categoryActions'][key];
      if ((EVIDENCE_CATEGORIES as readonly string[]).includes(key) && typeof value === 'string') {
        if (CATEGORY_ACTIONS.includes(value as CategoryAction)) {
          categoryActions[key as EvidenceCategory] = value as CategoryAction;
        }
      }
    }
  }

  const surfaces = defaults.surfaces;
  if (isRecord(raw['surfaces'])) {
    for (const key of Object.keys(raw['surfaces'])) {
      const value = raw['surfaces'][key];
      if ((SUPPORTED_SURFACES as readonly string[]).includes(key) && typeof value === 'boolean') {
        surfaces[key as Surface] = value;
      }
    }
  }

  const shortsGuardRaw = raw['shortsGuard'];
  const shortsGuard = {
    enabled:
      isRecord(shortsGuardRaw) && typeof shortsGuardRaw['enabled'] === 'boolean'
        ? shortsGuardRaw['enabled']
        : defaults.shortsGuard.enabled,
  };

  const performance = {
    preset:
      isRecord(raw['performance']) &&
      PROCESSING_PRESETS.includes(raw['performance']['preset'] as ProcessingPreset)
        ? (raw['performance']['preset'] as ProcessingPreset)
        : defaults.performance.preset,
  };

  // History retention (DATA-07): bounded and clamped — a corrupt value never
  // disables pruning entirely or wipes everything after one day.
  const historyRaw = raw['history'];
  const retentionDaysRaw = isRecord(historyRaw) ? historyRaw['retentionDays'] : undefined;
  const retentionDays =
    typeof retentionDaysRaw === 'number' &&
    Number.isFinite(retentionDaysRaw) &&
    retentionDaysRaw >= HISTORY_RETENTION_MIN_DAYS &&
    retentionDaysRaw <= HISTORY_RETENTION_MAX_DAYS
      ? Math.round(retentionDaysRaw)
      : defaults.history.retentionDays;
  const history = {
    enabled:
      isRecord(historyRaw) && typeof historyRaw['enabled'] === 'boolean'
        ? historyRaw['enabled']
        : defaults.history.enabled,
    retentionDays,
  };

  const density = DENSITIES.includes(raw['density'] as Density)
    ? (raw['density'] as Density)
    : defaults.density;
  const theme = THEMES.includes(raw['theme'] as Theme) ? (raw['theme'] as Theme) : defaults.theme;

  const rulePacksRaw = raw['rulePacks'];
  const rulePacks = {
    fil:
      isRecord(rulePacksRaw) && typeof rulePacksRaw['fil'] === 'boolean'
        ? rulePacksRaw['fil']
        : defaults.rulePacks.fil,
  };

  const youtubeFeedbackRaw = raw['youtubeFeedback'];
  const youtubeFeedback = {
    enabled:
      isRecord(youtubeFeedbackRaw) && typeof youtubeFeedbackRaw['enabled'] === 'boolean'
        ? youtubeFeedbackRaw['enabled']
        : false,
  };

  const providerRaw = raw['remoteProvider'];
  let endpoint: string | undefined;
  if (isRecord(providerRaw) && typeof providerRaw['endpoint'] === 'string') {
    // Only https URLs are accepted for remote providers.
    try {
      const url = new URL(providerRaw['endpoint']);
      if (url.protocol === 'https:') endpoint = url.toString();
    } catch {
      endpoint = undefined;
    }
  }
  const timeoutMs =
    isRecord(providerRaw) &&
    typeof providerRaw['timeoutMs'] === 'number' &&
    Number.isFinite(providerRaw['timeoutMs']) &&
    providerRaw['timeoutMs'] >= 100 &&
    providerRaw['timeoutMs'] <= 60_000
      ? Math.round(providerRaw['timeoutMs'])
      : defaults.remoteProvider.timeoutMs;

  // A provider cannot be enabled without a valid HTTPS endpoint — a corrupt
  // or malicious settings blob must never turn on remote calls by itself.
  const providerEnabled =
    isRecord(providerRaw) && providerRaw['enabled'] === true && endpoint !== undefined;
  const remoteProvider: RemoteProviderSettings = {
    enabled: providerEnabled,
    timeoutMs,
    ...(endpoint !== undefined ? { endpoint } : {}),
  };

  return {
    enabled,
    mode,
    categoryActions,
    displayMode:
      raw['displayMode'] === 'collapse' || raw['displayMode'] === 'placeholder'
        ? raw['displayMode']
        : defaults.displayMode,
    showExplanations:
      typeof raw['showExplanations'] === 'boolean'
        ? raw['showExplanations']
        : defaults.showExplanations,
    collectLocalStats:
      typeof raw['collectLocalStats'] === 'boolean'
        ? raw['collectLocalStats']
        : defaults.collectLocalStats,
    surfaces,
    shortsGuard,
    performance,
    history,
    density,
    theme,
    rulePacks,
    youtubeFeedback,
    remoteProvider,
  };
}

/**
 * Migrate older settings shapes to the current schema.
 * v1 → v2: introduced `remoteProvider.timeoutMs`.
 * v2 → v3: introduced `displayMode` (default placeholder).
 * v3 → v4: introduced per-surface toggles, Shorts guard, performance preset.
 * v4 → v5: introduced history controls, density, theme, rule packs.
 */
export function migrateSettings(raw: unknown, fromVersion: number): UserSettings | null {
  if (!isRecord(raw)) return null;
  let value = raw as Record<string, unknown>;
  if (fromVersion < 2) {
    // Schema v1 stored provider settings without timeout; validation fills it.
    value = { ...value };
    if (isRecord(value['remoteProvider']) && value['remoteProvider']['timeoutMs'] === undefined) {
      value['remoteProvider'] = { ...value['remoteProvider'], timeoutMs: 5000 };
    }
  }
  if (fromVersion < 3) {
    // v2 had no displayMode; placeholder was implicit via showExplanations.
    value = { ...value };
    if (value['displayMode'] === undefined) {
      value['displayMode'] = value['showExplanations'] === false ? 'collapse' : 'placeholder';
    }
  }
  // v3 → v4 fields (surfaces/shortsGuard/performance) are defaulted by
  // validateSettings — no legacy intent to preserve beyond the defaults.
  return validateSettings(value);
}
