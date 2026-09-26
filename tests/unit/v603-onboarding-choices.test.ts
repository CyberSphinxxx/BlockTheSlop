import { describe, expect, it } from 'vitest';
import {
  buildOnboardingSettingsPatch,
  defaultOnboardingDraft,
  ONBOARDING_CATEGORY_CARDS,
  SENSITIVITY_TO_MODE,
  validateOnboardingDraft,
  type OnboardingDraft,
} from '@/domain/onboarding';
import { defaultSettings } from '@/domain/settings';
import { DISCOVERY_SOURCES } from '@/domain/onboarding';

describe('onboarding draft (V6-03..07)', () => {
  it('discovery sources are the exact kit list, local-only and optional', () => {
    expect([...DISCOVERY_SOURCES]).toEqual([
      'facebook',
      'tiktok',
      'friend',
      'reddit',
      'chrome-web-store',
      'other',
      'prefer-not-to-say',
    ]);
  });

  it('default draft: AI production + farms on, about-AI OFF, Hide treatment, Balanced', () => {
    const draft = defaultOnboardingDraft();
    expect(draft.categories['ai-visual']).toBe(true);
    expect(draft.categories['ai-voice']).toBe(true);
    expect(draft.categories['ai-music']).toBe(true);
    expect(draft.categories['ai-thumbnail']).toBe(true);
    expect(draft.categories['content-farm']).toBe(true);
    // "Videos about AI" is separate and OPT-IN: off by default.
    expect(draft.categories['ai-discussion']).toBe(false);
    expect(draft.treatment).toBe('hide');
    expect(draft.sensitivity).toBe('balanced');
    expect(draft.discoverySource).toBeUndefined();
  });

  it('validates and repairs drafts; unknown fields never crash Apply', () => {
    const good = validateOnboardingDraft(defaultOnboardingDraft());
    expect(good).not.toBeNull();
    expect(validateOnboardingDraft(undefined)).toBeNull();
    expect(validateOnboardingDraft('x')).toBeNull();
    expect(
      validateOnboardingDraft({ ...defaultOnboardingDraft(), sensitivity: 'maximum' }),
    ).toBeNull();
    expect(validateOnboardingDraft({ ...defaultOnboardingDraft(), treatment: 'blur' })).toBeNull();
    const repaired = validateOnboardingDraft({
      ...defaultOnboardingDraft(),
      categories: { ...defaultOnboardingDraft().categories, 'made-up': true },
    });
    expect(repaired).not.toBeNull();
  });
});

describe('sensitivity mapping (V6-06)', () => {
  it('Low/Balanced/High map to real safe/balanced/strict policies', () => {
    expect(SENSITIVITY_TO_MODE['low']).toBe('safe');
    expect(SENSITIVITY_TO_MODE['balanced']).toBe('balanced');
    expect(SENSITIVITY_TO_MODE['high']).toBe('strict');
    // Aggressive is NOT reachable from onboarding.
    expect(Object.values(SENSITIVITY_TO_MODE)).not.toContain('aggressive');
  });
});

describe('patch builder (V6-04/05/06)', () => {
  it('unchecking a card is an explicit allow; checking follows the treatment', () => {
    const current = defaultSettings();
    const draft: OnboardingDraft = {
      ...defaultOnboardingDraft(),
      categories: { ...defaultOnboardingDraft().categories, 'ai-music': false },
    };
    const patch = buildOnboardingSettingsPatch(draft, current);
    expect(patch.categoryActions).toBeDefined();
    expect(patch.categoryActions!['ai-music']).toBe('allow'); // explicit opt-out wins over High
    expect(patch.categoryActions!['ai-visual']).toBe('inherit'); // follows sensitivity
  });

  it('Warn treatment maps checked cards to warn (never a dead choice)', () => {
    const current = defaultSettings();
    const draft: OnboardingDraft = { ...defaultOnboardingDraft(), treatment: 'warn' };
    const patch = buildOnboardingSettingsPatch(draft, current);
    expect(patch.categoryActions!['ai-visual']).toBe('warn');
    expect(patch.categoryActions!['content-farm']).toBe('warn');
  });

  it('about-AI opt-in hides discussions; default never touches them', () => {
    const current = defaultSettings();
    const off = buildOnboardingSettingsPatch(defaultOnboardingDraft(), current);
    expect(off.categoryActions!['ai-discussion']).toBe('allow');

    const on = buildOnboardingSettingsPatch(
      {
        ...defaultOnboardingDraft(),
        categories: { ...defaultOnboardingDraft().categories, 'ai-discussion': true },
      },
      current,
    );
    expect(on.categoryActions!['ai-discussion']).toBe('hide');
  });

  it('writes only mode and categoryActions — nothing else is touched', () => {
    const patch = buildOnboardingSettingsPatch(defaultOnboardingDraft(), defaultSettings());
    expect(Object.keys(patch).sort()).toEqual(['categoryActions', 'mode']);
  });

  it('warn + about-AI opt-in warns discussions instead of hiding (treatment is coherent)', () => {
    const current = defaultSettings();
    const patch = buildOnboardingSettingsPatch(
      {
        ...defaultOnboardingDraft(),
        treatment: 'warn',
        categories: { ...defaultOnboardingDraft().categories, 'ai-discussion': true },
      },
      current,
    );
    expect(patch.categoryActions!['ai-discussion']).toBe('warn');
  });

  it('sensitivity maps through to the mode in the patch', () => {
    const patch = buildOnboardingSettingsPatch(
      { ...defaultOnboardingDraft(), sensitivity: 'high' },
      defaultSettings(),
    );
    expect(patch.mode).toBe('strict');
  });
});

describe('category cards (V6-04)', () => {
  it('every card maps to a real existing evidence category and honest copy', () => {
    for (const card of ONBOARDING_CATEGORY_CARDS) {
      expect(card.category).toBeTruthy();
      expect(card.label.length).toBeGreaterThan(0);
      // No card may promise frame/audio/transcript analysis.
      expect(card.description.toLowerCase()).not.toMatch(
        /frames? analysis|transcript|listens? to audio/,
      );
    }
    const categories = ONBOARDING_CATEGORY_CARDS.map((c) => c.category);
    // The six required choices exist as separate cards.
    for (const required of [
      'ai-visual',
      'ai-voice',
      'ai-music',
      'ai-thumbnail',
      'content-farm',
      'ai-discussion',
    ]) {
      expect(categories).toContain(required);
    }
    // about-AI is its own card, never conflated with AI production.
    const discussion = ONBOARDING_CATEGORY_CARDS.find((c) => c.category === 'ai-discussion');
    expect(discussion?.aboutAi).toBe(true);
    expect(ONBOARDING_CATEGORY_CARDS.find((c) => c.category === 'ai-visual')?.aboutAi).toBe(false);
  });
});
