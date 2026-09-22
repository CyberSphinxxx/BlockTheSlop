import type { EvidenceCategory } from '@/domain/evidence';

/** A structured text rule — never a raw substring match. */
export interface TextRule {
  id: string;
  /** BCP-47 language this rule applies to. */
  locale: string;
  /** Pre-anchored regex with word boundaries; must be case-insensitive. */
  pattern: RegExp;
  category: EvidenceCategory;
  /** 0..1 weight if this rule matches alone. */
  strength: number;
  context: 'title' | 'description' | 'both';
  /** Human-readable reason template, e.g. "The title mentions generating {tool}". */
  reasonText: string;
  /** Whether matching this rule indicates the content is *about* AI (opposing). */
  polarity?: 'supports' | 'opposes';
  /**
   * Claim scope (DET-19/20/21): what part of the video this rule's evidence
   * applies to. Defaults to 'unspecified-generation' for AI rules.
   */
  claimScope?: 'visual' | 'audio' | 'script' | 'music' | 'thumbnail' | 'unspecified-generation';
  /** Correlation group for dedupe of overlapping claims (DET-17). */
  correlationKey?: string | undefined;
  /**
   * Educational/negation-style frames that SUPPRESS this rule when they occur
   * in the same sentence before the match (DET-08: "how to spot AI-generated
   * videos" discusses detection; it does not disclose provenance).
   */
  suppressedBy?: readonly RegExp[] | undefined;
}

export interface RuleMatch {
  rule: TextRule;
  matchedIn: 'title' | 'description';
  /** Bounded excerpt of the actual matched text (display-safe). */
  matchedExcerpt: string;
}

/**
 * Unicode-normalization for matching (DET-15): NFKD folds fullwidth/halfwidth
 * forms; homoglyph/dash/space folding keeps the DISPLAY text untouched while
 * making matching robust ("A․I" with one-dot leaders, non-breaking spaces,
 * smart hyphens). We deliberately do NOT fold arbitrary letters.
 */
export function normalizeForMatch(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/[\u2010-\u2015\u2212\uFE58\uFE63\uFF0D]/g, '-')
    .replace(/[\u00A0\u2000-\u200B\u202F\u205F\u3000]/g, ' ')
    .replace(/[\u2024\u2025\u2026\uFE52\uFF0E]/g, '.')
    .replace(/[\u2018\u2019\u201B\uFF07]/g, "'")
    .replace(/[\u201C\u201D\uFF02]/g, '"');
}

export function boundExcerpt(text: string, max = 120): string {
  const trimmed = text.trim().replace(/\s+/g, ' ');
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max - 1)}…`;
}

/**
 * Scoped negation (DET-09): a match is suppressed only when a negation cue
 * appears in the SAME sentence, BEFORE the match, within 60 chars. Cues that
 * follow the match or live in other sentences must not erase it — e.g.
 * "This is NOT AI-generated" (negated) vs "Practical effects, not AI, made
 * this famous scene" style constructs still need care, but a trailing clause
 * "… and it is not AI-generated" describes a DIFFERENT sentence subject.
 */
const NEGATION_CUES: readonly RegExp[] = [
  /\b(?:isn'?t|aren'?t|wasn'?t|weren'?t|not|no|never|nothing|neither|nor)\b/i,
  /\b(?:without|zero|none\s+of\s+the)\b/i,
  /\b(?:walang|hindi)\b/i, // Filipino negation
];

const SENTENCE_SPLIT = /[.!?;\n]+/g;

export function isNegated(sentenceBeforeMatch: string): boolean {
  const windowText = sentenceBeforeMatch.slice(-60);
  return NEGATION_CUES.some((cue) => cue.test(windowText));
}

/** Find the sentence (in normalized text) containing the match start. */
function sentenceAround(text: string, index: number): string {
  let start = 0;
  for (const separator of text.matchAll(SENTENCE_SPLIT)) {
    if (separator.index === undefined) continue;
    if (separator.index >= index) break;
    start = separator.index + 1;
  }
  return text.slice(start, index);
}

/** Run one rule against title/description text with normalization + negation scoping. */
export function matchRule(rule: TextRule, title: string, description: string | undefined): boolean {
  return firstMatch(rule, title, description) !== null;
}

/**
 * First negation-unaffected match of a rule, with location + excerpt.
 * Returns null when no (non-negated) match exists.
 */
export function firstMatch(
  rule: TextRule,
  title: string,
  description: string | undefined,
): RuleMatch | null {
  const targets: { where: 'title' | 'description'; text: string }[] = [];
  if (rule.context === 'title' || rule.context === 'both') {
    targets.push({ where: 'title', text: normalizeForMatch(title) });
  }
  if ((rule.context === 'description' || rule.context === 'both') && description) {
    targets.push({ where: 'description', text: normalizeForMatch(description) });
  }
  for (const { where, text } of targets) {
    // Clone with the `g` flag so exec() ADVANCES between matches. The rule
    // patterns are authored without `g` (they are also used via .test()); a
    // non-global exec would return the same match forever on a negated or
    // suppressed first hit — an infinite loop.
    const pattern = new RegExp(
      rule.pattern.source,
      rule.pattern.flags.includes('g') ? rule.pattern.flags : `${rule.pattern.flags}g`,
    );
    let found: RegExpExecArray | null;
    let guard = 0;
    while ((found = pattern.exec(text)) !== null) {
      guard += 1;
      if (guard > 100) break; // defensive bound; matches per field are tiny
      if (found[0].length === 0) {
        // Zero-width match would also loop forever; force progress.
        pattern.lastIndex += 1;
        continue;
      }
      const before = sentenceAround(text, found.index);
      if (isNegated(before)) continue;
      if (rule.suppressedBy?.some((frame) => frame.test(before)) === true) continue;
      return { rule, matchedIn: where, matchedExcerpt: boundExcerpt(found[0]) };
    }
  }
  return null;
}
