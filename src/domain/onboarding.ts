import type { CategoryAction, FilterMode, UserSettings } from './settings';
import { EVIDENCE_CATEGORIES, type EvidenceCategory } from './evidence';

/**
 * Onboarding lifecycle (V6-02): versioned first-install state and an
 * idempotent opener decision.
 *
 * Product contract:
 * - Open onboarding ONLY for a true new install (runtime.onInstalled reason
 *   'install' — never 'update', 'chrome_update', 'shared_module_update', or a
 *   worker restart). Existing users and updated profiles are never forced
 *   through it.
 * - The state is durable in storage.local so the ephemeral service worker can
 *   be killed and restarted between the install event and a later
 *   chrome_update event without losing first-install status or completion.
 * - A duplicate install event, a reload of the onboarding tab, or an opener
 *   run racing itself must never create multiple onboarding tabs.
 * - Skip is a valid completion: it records setup completion separately from
 *   settings so it can never silently overwrite a user's configuration.
 */

/** Bump when the onboarding flow's steps change materially. */
export const ONBOARDING_VERSION = 1 as const;

/**
 * Onboarding sensitivity labels (V6-06). These are UI-level names that map
 * to REAL existing policy modes — they never invent a new filter behavior.
 * Aggressive is deliberately unreachable from onboarding: it stays an
 * advanced opt-in in Settings.
 */
export const SENSITIVITIES = ['low', 'balanced', 'high'] as const;
export type Sensitivity = (typeof SENSITIVITIES)[number];

export const SENSITIVITY_TO_MODE: Record<Sensitivity, Exclude<FilterMode, 'aggressive'>> = {
  low: 'safe',
  balanced: 'balanced',
  high: 'strict',
};

/** Onboarding treatment choices (V6-05). Hide is the default and recommended. */
export const TREATMENTS = ['hide', 'warn'] as const;
export type OnboardingTreatment = (typeof TREATMENTS)[number];

/**
 * A setup choice card (V6-04). Every card maps to a REAL EvidenceCategory —
 * the onboarding never promises a capability the detector does not have.
 */
export interface OnboardingCategoryCard {
  category: EvidenceCategory;
  label: string;
  description: string;
  /** True only for the separate, opt-in "videos ABOUT AI" card. */
  aboutAi: boolean;
}

/**
 * The six required content choices as separate, honest cards (REQUIREMENTS
 * V6-04 / UX sequence step 3). "Videos about AI" is a DIFFERENT thing from
 * AI-made videos: talking about AI is not evidence of synthetic media.
 */
export const ONBOARDING_CATEGORY_CARDS: readonly OnboardingCategoryCard[] = [
  {
    category: 'ai-visual',
    label: 'AI-generated video',
    description:
      'Videos made substantially with generative AI, when the title, description or labels say so. Text-based detection only — it cannot see inside the video.',
    aboutAi: false,
  },
  {
    category: 'ai-voice',
    label: 'AI voice / TTS',
    description:
      'Robotic text-to-speech narration and AI voiceovers, when the visible text or labels indicate it. Text-based detection only.',
    aboutAi: false,
  },
  {
    category: 'ai-music',
    label: 'AI music',
    description:
      'AI-generated music tracks, when titles, descriptions or labels indicate it. Text-based detection only.',
    aboutAi: false,
  },
  {
    category: 'ai-thumbnail',
    label: 'AI thumbnails',
    description:
      'Videos using AI-generated thumbnails. A generated thumbnail does not mean the video itself is AI-generated.',
    aboutAi: false,
  },
  {
    category: 'content-farm',
    label: 'Automated / content-farm channels',
    description:
      'Mass-produced, repetitive, low-effort channel patterns — including clearly automated uploads.',
    aboutAi: false,
  },
  {
    category: 'ai-discussion',
    label: 'Videos ABOUT AI (news, reviews, tutorials)',
    description:
      'Human-made videos that discuss AI topics. This is separate from AI-made videos and off by default.',
    aboutAi: true,
  },
];

/**
 * The user's setup choices as drafted (V6-03..07). Held in memory on the
 * onboarding page until Apply commits them in ONE settings transaction;
 * nothing here is persisted until then, and Skip never persists a draft.
 */
export interface OnboardingDraft {
  categories: Record<EvidenceCategory, boolean>;
  treatment: OnboardingTreatment;
  sensitivity: Sensitivity;
  /** Local-only; persisted (separately) only when the user answers. */
  discoverySource?: DiscoverySource | undefined;
}

/**
 * Default draft: the sensible defaults from the UX contract — AI-made media
 * and content farms ON, "videos about AI" OFF (separate + opt-in), Hide
 * (recommended), Balanced sensitivity.
 */
export function defaultOnboardingDraft(): OnboardingDraft {
  const categories = {} as Record<EvidenceCategory, boolean>;
  for (const category of EVIDENCE_CATEGORIES) categories[category] = false;
  for (const category of [
    'ai-visual',
    'ai-voice',
    'ai-music',
    'ai-thumbnail',
    'content-farm',
  ] as const) {
    categories[category] = true;
  }
  return { categories, treatment: 'hide', sensitivity: 'balanced' };
}

/**
 * Structural validation of a restored draft. Returns null for anything that
 * cannot be repaired to a meaningful draft (callers then fall back to
 * defaults); unknown extra fields are ignored, never crash Apply.
 */
export function validateOnboardingDraft(raw: unknown): OnboardingDraft | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;

  const categoriesRaw = record['categories'];
  if (typeof categoriesRaw !== 'object' || categoriesRaw === null || Array.isArray(categoriesRaw)) {
    return null;
  }
  const categories = defaultOnboardingDraft().categories;
  for (const [key, value] of Object.entries(categoriesRaw as Record<string, unknown>)) {
    if ((EVIDENCE_CATEGORIES as readonly string[]).includes(key) && typeof value === 'boolean') {
      categories[key as EvidenceCategory] = value;
    }
  }

  const treatment = (TREATMENTS as readonly string[]).includes(record['treatment'] as string)
    ? (record['treatment'] as OnboardingTreatment)
    : null;
  const sensitivity = (SENSITIVITIES as readonly string[]).includes(record['sensitivity'] as string)
    ? (record['sensitivity'] as Sensitivity)
    : null;
  if (treatment === null || sensitivity === null) return null;

  const discoveryRaw = record['discoverySource'];
  const discoverySource =
    typeof discoveryRaw === 'string' &&
    (DISCOVERY_SOURCES as readonly string[]).includes(discoveryRaw)
      ? (discoveryRaw as DiscoverySource)
      : undefined;

  return discoverySource === undefined
    ? { categories, treatment, sensitivity }
    : { categories, treatment, sensitivity, discoverySource };
}

/**
 * Build the settings PATCH the Apply step will commit (V6-04/05/06).
 * Pure: takes the CURRENT stored settings so existing user intent outside
 * the onboarding's scope survives. Writes ONLY `mode` and `categoryActions`:
 *
 * - sensitivity → real mode (Low→safe, Balanced→balanced, High→strict).
 * - each card the user left checked follows the chosen treatment, expressed
 *   as 'inherit' (follow the mode's default action) — so later mode changes
 *   keep the setup coherent.
 * - each card the user UNCHECKED is an explicit 'allow' (an opt-out wins
 *   over any sensitivity level) — except "videos about AI" unchecked, which
 *   is pinned to explicit 'allow' too: opting out of about-AI filtering is
 *   always honored.
 * - checking "videos about AI" applies the chosen treatment to discussions.
 */
export function buildOnboardingSettingsPatch(
  draft: OnboardingDraft,
  _current: UserSettings,
): Partial<UserSettings> {
  void _current;
  const categoryActions = {} as Record<EvidenceCategory, CategoryAction>;
  for (const card of ONBOARDING_CATEGORY_CARDS) {
    const checked = draft.categories[card.category] === true;
    if (card.aboutAi) {
      categoryActions[card.category] = checked
        ? draft.treatment === 'hide'
          ? 'hide'
          : 'warn'
        : 'allow';
    } else if (!checked) {
      categoryActions[card.category] = 'allow';
    } else if (draft.treatment === 'warn') {
      categoryActions[card.category] = 'warn';
    } else {
      categoryActions[card.category] = 'inherit';
    }
  }
  return { mode: SENSITIVITY_TO_MODE[draft.sensitivity], categoryActions };
}

/** Local-only, optional answer to the discovery-source question (V6-03). */
export const DISCOVERY_SOURCES = [
  'facebook',
  'tiktok',
  'friend',
  'reddit',
  'chrome-web-store',
  'other',
  'prefer-not-to-say',
] as const;
export type DiscoverySource = (typeof DISCOVERY_SOURCES)[number];

export interface OnboardingState {
  /** Setup was finished (Apply or Skip). Versioned, never inferred from settings. */
  completed: boolean;
  /** Which onboarding flow version last ran (or was offered). */
  version: number;
  /** Set only if the user explicitly answered the optional discovery question. */
  discoverySource?: DiscoverySource | undefined;
}

export function defaultOnboardingState(): OnboardingState {
  return { completed: false, version: ONBOARDING_VERSION };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Sanitize loaded state; corrupt shapes repair to defaults, never throw. */
export function validateOnboardingState(raw: unknown): OnboardingState {
  const out = defaultOnboardingState();
  if (!isRecord(raw)) return out;
  if (typeof raw['completed'] === 'boolean') out.completed = raw['completed'];
  if (typeof raw['version'] === 'number' && Number.isFinite(raw['version'])) {
    out.version = Math.max(0, Math.round(raw['version']));
  }
  const source = raw['discoverySource'];
  if (typeof source === 'string' && (DISCOVERY_SOURCES as readonly string[]).includes(source)) {
    out.discoverySource = source as DiscoverySource;
  }
  return out;
}

export type InstallReason =
  | 'install'
  | 'update'
  | 'chrome_update'
  | 'shared_module_update'
  | 'browser_update'
  | 'unknown'
  | (string & {});

export interface OpenerContext {
  /** A visible onboarding tab already exists (another window/tab). */
  hasOnboardingTab: boolean;
  /** This worker already opened (or decided to open) onboarding in this lifetime. */
  openedThisRun: boolean;
}

export interface OpenerDecision {
  /** Create the onboarding tab. */
  open: boolean;
  /** Persist that this run offered/opened the flow (duplicate-event guard). */
  markOpening: boolean;
}

/**
 * A true first install: the onInstalled reason is 'install' AND setup has
 * never completed. Reloads/updates of an unpacked extension keep storage,
 * so completed state blocks re-onboarding even on an 'install' reason.
 */
export function isTrueFirstInstall(reason: InstallReason, state: OnboardingState): boolean {
  return reason === 'install' && !state.completed;
}

/**
 * The single decision point for "should this event open onboarding".
 * Pure and synchronous so the whole matrix is unit-testable:
 *
 * | reason            | state          | result            |
 * |-------------------|----------------|-------------------|
 * | install           | not completed  | open once         |
 * | install           | completed      | never (existing user; unpacked reload keeps storage) |
 * | update            | any            | never (updates are NOT onboarding — REQUIREMENTS V6-02) |
 * | chrome_update etc.| any            | never (a browser restart is not a new install) |
 * | any               | tab already open / opened this run | never |
 *
 * An interrupted first install (tab-open failure, closed tab, browser
 * restart) deliberately does NOT nag: the flow is reachable any time from
 * Settings (reopen path) and the popup surfaces "Finish setup" until it is
 * completed. This keeps the "new installs only" guarantee exact.
 */
export function decideOnboardingOpener(
  reason: InstallReason,
  state: OnboardingState,
  ctx: OpenerContext,
): OpenerDecision {
  if (ctx.hasOnboardingTab || ctx.openedThisRun) {
    return { open: false, markOpening: !state.completed };
  }
  if (!isTrueFirstInstall(reason, state)) {
    return { open: false, markOpening: false };
  }
  return { open: true, markOpening: true };
}
