import { describe, expect, it } from 'vitest';
import { applyRuleMutation, defaultRules, getRuleIndex, type UserRules } from '@/domain/rules';
import { decide } from '@/policy/decide';
import { defaultSettings, type UserSettings } from '@/domain/settings';

/**
 * V7-09: rule preview and matching must stay fast at the documented cap
 * (MAX_LIST_LENGTH = 10_000). Whole-word matchers compile ONCE per rules
 * snapshot (WeakMap-cached RuleIndex) — building the index for 10k rules
 * must be bounded, and deciding a title against them must be milliseconds,
 * not re-compile-per-card territory.
 */

const TEN_K = 10_000;

function rulesWith10k(): UserRules {
  let rules = defaultRules();
  for (let i = 0; i < TEN_K / 2; i++) {
    rules = applyRuleMutation(rules, {
      kind: 'block-phrase',
      phrase: `wholeword${String(i).padStart(5, '0')}`,
      wholeWord: true,
    });
    rules = applyRuleMutation(rules, {
      kind: 'block-phrase',
      phrase: `substring${String(i).padStart(5, '0')}`,
    });
  }
  return rules;
}

describe('V7-09: performance at 10k phrase rules', () => {
  it('builds the matcher index once within a bounded budget', () => {
    const rules = rulesWith10k();
    expect(rules.blockedPhraseRules).toHaveLength(TEN_K / 2);
    const started = Date.now();
    const index = getRuleIndex(rules);
    const elapsed = Date.now() - started;
    // Single-token whole-word rules become a Set (no regex compilation); the
    // substring halves land in blockedPhrasesLower.
    expect(index.blockedSingleWords.size).toBe(TEN_K / 2);
    expect(index.blockedMultiWordMatchers).toHaveLength(0);
    expect(index.blockedPhrasesLower.length).toBe(TEN_K / 2);
    // Index build is bounded (and happens ONCE per snapshot, amortized to
    // O(1) per card afterwards).
    expect(elapsed).toBeLessThan(2_000);
  });

  it('deciding 2,000 titles against 10k rules stays bounded (no per-card recompile)', () => {
    const rules = rulesWith10k();
    getRuleIndex(rules); // warm the cache
    const settings: UserSettings = defaultSettings();
    const started = Date.now();
    let hidden = 0;
    for (let i = 0; i < 2_000; i++) {
      const decision = decide({
        settings,
        rules,
        candidate: { videoId: `v${i}`, title: `A calm video about bread #${i}` },
      });
      if (decision.action === 'hide') hidden += 1;
    }
    const elapsed = Date.now() - started;
    expect(hidden).toBe(0);
    // 2,000 titles × 10k rules ≈ 20M cheap scans; must stay under 10s even
    // on slow CI boxes (real grids decide 100s of cards, not 2k).
    expect(elapsed).toBeLessThan(10_000);
  });

  it('a matching rule is still found among 10k (correctness at scale)', () => {
    const rules = rulesWith10k();
    const decision = decide({
      settings: defaultSettings(),
      rules,
      candidate: { videoId: 'vm', title: 'Streaming wholeword00421 tonight' },
    });
    expect(decision.action).toBe('hide');
    expect(decision.ruleId).toBe('phrase-block');
  });
});
