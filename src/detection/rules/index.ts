import type { RuleMatch, TextRule } from './types';
import { firstMatch } from './types';
import { EN_RULES } from './en';
import { FIL_RULES } from './fil';
import { MULTILINGUAL_RULES } from './multilingual';

/**
 * Rule pack version — the single authoritative source is domain/versions.ts
 * (DET-23: one version source; bumping it must invalidate fingerprint caches).
 */
import { RULES_VERSION } from '@/domain/versions';
export { RULES_VERSION };

/** All known rule packs, keyed by locale prefix. */
const PACKS: readonly TextRule[] = [...EN_RULES, ...FIL_RULES, ...MULTILINGUAL_RULES];

const PACK_LANGS: readonly string[] = [...new Set(PACKS.map((r) => r.locale.split('-')[0] ?? ''))];

/**
 * Select rules applicable to a locale hint (DET-16): English is always
 * included as the dominant YouTube language, and EVERY known pack is additive
 * for mixed-language content — the selected packs depend on the CONTENT
 * language, not the UI language. With only two packs this means Filipino
 * content gets both packs regardless of UI locale.
 */
export function rulesForLocale(localeHint: string | undefined): readonly TextRule[] {
  void localeHint; // packs are additive; see doc above
  return PACKS;
}

/**
 * Run a rule set against title/description, returning one match per rule.
 * Two regexes hitting the SAME phrase share a correlationKey and are reduced
 * to the strongest match (DET-17: overlapping claims are not independent).
 */
export function matchRules(
  rules: readonly TextRule[],
  title: string,
  description: string | undefined,
): RuleMatch[] {
  const matches: RuleMatch[] = [];
  for (const rule of rules) {
    const match = firstMatch(rule, title, description);
    if (match !== null) matches.push(match);
  }

  // Correlation dedupe: strongest per correlation group (falling back to the
  // rule id when no group is declared).
  const byGroup = new Map<string, RuleMatch>();
  for (const match of matches) {
    const group = match.rule.correlationKey ?? match.rule.id;
    const existing = byGroup.get(group);
    if (existing === undefined || match.rule.strength > existing.rule.strength) {
      byGroup.set(group, match);
    }
  }
  return [...byGroup.values()];
}

/** Exposed for diagnostics: the set of pack languages compiled in. */
export const PACK_LANGUAGES = PACK_LANGS;
