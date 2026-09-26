import { describe, expect, it } from 'vitest';
import {
  escapeRegExpLiteral,
  phraseMatchesTitle,
  previewPhraseRule,
  PREVIEW_SAMPLE,
} from '@/domain/rule-preview';
import { applyRuleMutation, defaultRules, validateRules } from '@/domain/rules';
import { decide } from '@/policy/decide';
import { defaultSettings, type UserSettings } from '@/domain/settings';

/**
 * V7-09: safe phrase/whole-word rule preview.
 *
 * Users write LITERAL text — never regex. The matcher is pure and Unicode
 * aware (Filipino titles, emoji, punctuation). The preview runs against a
 * bounded LOCAL sample before saving, showing estimated matches and possible
 * allowed-content conflicts. Raw regex stays out of the release: user input
 * is always escaped before any internal use.
 */

describe('V7-09: phraseMatchesTitle (literal, Unicode-aware)', () => {
  it('substring mode matches case-insensitively inside words', () => {
    expect(phraseMatchesTitle('EASY recipes', { phrase: 'easy', wholeWord: false })).toBe(true);
    expect(phraseMatchesTitle('Sleepeasy Tonight', { phrase: 'easy', wholeWord: false })).toBe(
      true,
    );
  });

  it('whole-word mode respects word boundaries', () => {
    expect(phraseMatchesTitle('EASY recipes', { phrase: 'easy', wholeWord: true })).toBe(true);
    expect(phraseMatchesTitle('Sleepeasy Tonight', { phrase: 'easy', wholeWord: true })).toBe(
      false,
    );
    expect(phraseMatchesTitle('easy-going dogs', { phrase: 'easy', wholeWord: true })).toBe(true);
  });

  it('whole-word mode is Unicode-aware (Filipino and accented letters)', () => {
    // 'maaari' must NOT match inside 'namaaarihan'.
    expect(phraseMatchesTitle('namaaarihan na', { phrase: 'maaari', wholeWord: true })).toBe(false);
    expect(phraseMatchesTitle('maaari bang malaman', { phrase: 'maaari', wholeWord: true })).toBe(
      true,
    );
    // Accented letters count as word characters.
    expect(phraseMatchesTitle('café history', { phrase: 'café', wholeWord: true })).toBe(true);
    expect(phraseMatchesTitle('cafés history', { phrase: 'café', wholeWord: true })).toBe(false);
  });

  it('punctuation and emoji are boundaries, letters are not', () => {
    expect(phraseMatchesTitle('wow! amazing (ai)', { phrase: 'ai', wholeWord: true })).toBe(true);
    expect(phraseMatchesTitle('🌍travel vlog🌍', { phrase: 'travel', wholeWord: true })).toBe(true);
    expect(phraseMatchesTitle('trainless', { phrase: 'ai', wholeWord: true })).toBe(false);
  });

  it('treats the phrase as literal text — regex metacharacters never execute', () => {
    expect(phraseMatchesTitle('cost: 5$ (x.*)', { phrase: 'x.*', wholeWord: false })).toBe(true);
    expect(phraseMatchesTitle('anything', { phrase: '.*', wholeWord: false })).toBe(false);
    expect(phraseMatchesTitle('a+b plan', { phrase: 'a+b', wholeWord: false })).toBe(true);
  });

  it('escapeRegExpLiteral neutralizes metacharacters', () => {
    expect(escapeRegExpLiteral('a.b*c')).toBe('a\\.b\\*c');
  });
});

describe('V7-09: previewPhraseRule (bounded local sample)', () => {
  it('counts matches in the bounded sample and reports the denominator', () => {
    const preview = previewPhraseRule({ phrase: 'ai generated', wholeWord: false });
    expect(preview.sampleSize).toBe(PREVIEW_SAMPLE.length);
    expect(preview.sampleSize).toBeLessThanOrEqual(24);
    expect(preview.matches.length).toBeGreaterThan(0);
    for (const m of preview.matches) {
      expect(m.title.toLowerCase()).toContain('ai generated');
    }
  });

  it('flags a too-short phrase as an accidental-broad-match risk', () => {
    const preview = previewPhraseRule({ phrase: 'ai', wholeWord: false });
    expect(preview.warnings.some((w) => w.kind === 'too-short')).toBe(true);
  });

  it('flags conflicts when the phrase would also hide known-safe sample titles', () => {
    const preview = previewPhraseRule({ phrase: 'history', wholeWord: false });
    expect(preview.warnings.some((w) => w.kind === 'may-hide-safe-content')).toBe(true);
    expect(
      preview.warnings.some((w) => w.kind === 'may-hide-safe-content' && w.samples.length > 0),
    ).toBe(true);
  });

  it('a specific phrase produces no warnings', () => {
    const preview = previewPhraseRule({ phrase: 'unsettling ai voices', wholeWord: false });
    expect(preview.warnings).toHaveLength(0);
  });
});

describe('V7-09: whole-word phrase rules decide hiding', () => {
  const settings: UserSettings = defaultSettings();
  const candidate = { videoId: 'v1', title: 'Sleepeasy Tonight — relaxing rain' };

  it('substring rule still hides (legacy list unchanged)', () => {
    const rules = applyRuleMutation(defaultRules(), { kind: 'block-phrase', phrase: 'easy' });
    const decision = decide({ settings, rules, candidate });
    expect(decision.action).toBe('hide');
    expect(decision.ruleId).toBe('phrase-block');
  });

  it('a whole-word rule does NOT hide when the word only appears inside another word', () => {
    const rules = applyRuleMutation(defaultRules(), {
      kind: 'block-phrase',
      phrase: 'easy',
      wholeWord: true,
    });
    const decision = decide({ settings, rules, candidate });
    expect(decision.action).toBe('allow');
  });

  it('a whole-word rule hides when the word stands alone', () => {
    const rules = applyRuleMutation(defaultRules(), {
      kind: 'block-phrase',
      phrase: 'tonight',
      wholeWord: true,
    });
    const decision = decide({ settings, rules, candidate });
    expect(decision.action).toBe('hide');
  });
});

describe('V7-09: rules storage compatibility', () => {
  it('validateRules keeps legacy string phrases and loads new whole-word rules', () => {
    const rules = validateRules({
      allowedVideoIds: [],
      blockedVideoIds: [],
      allowedChannelIds: [],
      blockedChannelIds: [],
      fallbackAllowedHandles: [],
      fallbackBlockedHandles: [],
      blockedPhrases: ['legacy phrase'],
      blockedPhraseRules: [{ phrase: 'exact word', wholeWord: true }],
    });
    expect(rules?.blockedPhrases).toEqual(['legacy phrase']);
    expect(rules?.blockedPhraseRules).toEqual([{ phrase: 'exact word', wholeWord: true }]);
  });

  it('defaults and corrupt payloads stay safe', () => {
    expect(defaultRules().blockedPhraseRules).toEqual([]);
    const corrupt = validateRules({ blockedPhraseRules: 'junk', blockedPhrases: [42] });
    expect(corrupt?.blockedPhraseRules).toEqual([]);
    expect(corrupt?.blockedPhrases).toEqual([]);
  });

  it('mutation round-trips both modes and dedupes case-insensitively', () => {
    let rules = applyRuleMutation(defaultRules(), { kind: 'block-phrase', phrase: 'Ai' });
    expect(rules.blockedPhrases).toContain('Ai');
    rules = applyRuleMutation(rules, { kind: 'block-phrase', phrase: 'exact', wholeWord: true });
    expect(rules.blockedPhraseRules.map((r) => r.phrase)).toContain('exact');
    // Removing by phrase works across both lists.
    rules = applyRuleMutation(rules, { kind: 'unblock-phrase', phrase: 'exact' });
    expect(rules.blockedPhraseRules.map((r) => r.phrase)).not.toContain('exact');
  });
});
