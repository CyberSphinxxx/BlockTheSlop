import type { Evidence } from '@/domain/evidence';
import type { NormalizedVideoCandidate } from '@/domain/video';
import type { DetectionContext } from '@/domain/evidence';
import { matchRules, rulesForLocale } from '../rules';
import type { Detector } from '../engine';

/**
 * Title/description rule detector. Produces supporting evidence for
 * generation/description patterns and opposing evidence for AI *discussion*
 * patterns (the false-positive guard required by the spec). Every item
 * carries full provenance (04 §8): rule id, matched field, bounded excerpt,
 * claim scope, and correlation key.
 */
export const textRulesDetector: Detector = {
  id: 'text-rules',
  detect(candidate: NormalizedVideoCandidate, context: DetectionContext): Evidence[] {
    let rules = rulesForLocale(context.locale);
    // CFG-09: the user can disable additive packs (real behavior change).
    if (context.enabledRulePacks?.fil === false) {
      rules = rules.filter((r) => r.locale.split('-')[0] !== 'fil');
    }
    const matches = matchRules(rules, candidate.title, candidate.description);
    return matches.map(({ rule, matchedIn, matchedExcerpt }) => ({
      id: `text:${rule.id}`,
      origin: 'local-rule',
      category: rule.category,
      detector: 'text-rules',
      strength: rule.strength,
      polarity: rule.polarity === 'opposes' ? ('opposes' as const) : ('supports' as const),
      reasonCode: rule.id,
      reasonText: rule.reasonText,
      ruleId: rule.id,
      sourceKind: 'title' as const,
      matchedField: matchedIn,
      matchedExcerpt,
      claimScope: rule.claimScope ?? 'unspecified-generation',
      correlationKey: rule.correlationKey ?? rule.id,
    }));
  },
};
