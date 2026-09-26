import type { EvidenceCategory } from './evidence';

/**
 * V7-09: safe phrase rule preview.
 *
 * Users write LITERAL text — never regex. `escapeRegExpLiteral` exists only
 * for internal matcher construction; user input is escaped before any regex
 * engine sees it, so metacharacters in a phrase can never widen the match or
 * execute. The preview runs against a bounded LOCAL sample (no network, no
 * user history) before saving, so a rule can be judged before it hides
 * anything.
 */

/** A user phrase rule: literal text plus match mode. */
export interface PhraseRule {
  phrase: string;
  wholeWord: boolean;
}

/** Escape all regex metacharacters in a literal string. */
export function escapeRegExpLiteral(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** True when `text` contains the phrase under the requested match mode. */
export function phraseMatchesTitle(
  title: string,
  rule: { phrase: string; wholeWord: boolean },
): boolean {
  const phrase = rule.phrase.trim().toLowerCase();
  if (phrase.length === 0) return false;
  const haystack = title.toLowerCase();

  if (!rule.wholeWord) return haystack.includes(phrase);

  // Whole word: the phrase must not be glued to letters/digits/underscore on
  // either side. Constructed from the ESCAPED literal — regex metacharacters
  // in the phrase stay literal.
  const pattern = new RegExp(
    `(?<![\\p{L}\\p{N}_])${escapeRegExpLiteral(phrase)}(?![\\p{L}\\p{N}_])`,
    'u',
  );
  return pattern.test(haystack);
}

/**
 * Bounded LOCAL sample of title-like strings used for previews. Frozen,
 * bundled (no network): representative AI-disclosure, AI-made, Filipino,
 * emoji, and clearly-safe human titles. Deliberately small (≤24) so the
 * preview stays instant and the denominator is honest.
 */
export const PREVIEW_SAMPLE: readonly { title: string; safe: boolean }[] = [
  // Official disclosure / explicit AI labels.
  { title: 'The fall of Rome, retold — AI generated film', safe: false },
  { title: 'AI generated: underwater city tour', safe: false },
  { title: 'Altered or synthetic content — history recap', safe: false },
  // Common AI/slop phrasing.
  { title: 'unsettling ai voices reading weird stories', safe: false },
  { title: 'AI generated song that broke the charts', safe: false },
  { title: '10 ai tools that feel illegal to know', safe: false },
  { title: 'this ai video will unsettle you', safe: false },
  { title: 'satisfying ai generatedoddly process', safe: false },
  // Filipino-language titles (V7-09 Unicode checks).
  { title: 'maaari bang malaman kung paano', safe: true },
  { title: 'Ang dokumentaryo ni Juana Dela Cruz', safe: true },
  { title: 'paano gumawa ng pancit — maaari mo itong subukan', safe: true },
  { title: 'namaaarihan na mga kwento ng bayan', safe: true },
  // Emoji / punctuation boundaries.
  { title: '🌍travel vlog: 48 hours in Geneva🌍', safe: true },
  { title: 'wow! amazing (ai) reaction compilation', safe: false },
  { title: 'EASY recipes — 5-minute dinners', safe: true },
  // Clearly human-made / safe content (must NOT be hidden by sane rules).
  { title: 'The history of bread: 6,000 years of baking', safe: true },
  { title: 'How volcanoes work — explained by a geologist', safe: true },
  { title: 'Making sourdough with my grandmother', safe: true },
  { title: 'A calm documentary about bread', safe: true },
  { title: 'Sleepeasy Tonight — relaxing rain sounds', safe: true },
  { title: 'Why the Romans feared the sea', safe: true },
  { title: 'Woodworking: hand-cut dovetails', safe: true },
  { title: 'Solar system tour for kids', safe: true },
  { title: 'Restoring a 1972 vw bus engine', safe: true },
].map((entry) => ({ title: entry.title, safe: entry.safe }));

const PREVIEW_SAMPLE_MAX = 24;

/** Why the preview warns the user. */
export type PreviewWarningKind = 'too-short' | 'may-hide-safe-content';

export interface PreviewWarning {
  kind: PreviewWarningKind;
  message: string;
  /** Titles from the sample that triggered the conflict (bounded). */
  samples: string[];
}

export interface PhrasePreviewResult {
  phrase: string;
  wholeWord: boolean;
  /** Number of sample titles matched. */
  matchCount: number;
  /** Total sample size — the honest denominator. */
  sampleSize: number;
  /** Matched sample titles (bounded to 5 for display). */
  matches: { title: string; safe: boolean }[];
  warnings: PreviewWarning[];
}

/** Preview a phrase rule against the bounded local sample. Pure. */
export function previewPhraseRule(rule: {
  phrase: string;
  wholeWord: boolean;
}): PhrasePreviewResult {
  const phrase = rule.phrase.trim();
  const matches: { title: string; safe: boolean }[] = [];
  const sample = PREVIEW_SAMPLE.slice(0, PREVIEW_SAMPLE_MAX);
  for (const entry of sample) {
    if (phraseMatchesTitle(entry.title, { phrase, wholeWord: rule.wholeWord })) {
      matches.push(entry);
    }
  }

  const warnings: PreviewWarning[] = [];

  // Accidental broad match: a short substring sweep over an open-ended word
  // (e.g. "ai" in "rain", "train", "maintain") hides far more than intended.
  if (!rule.wholeWord && phrase.length < 4) {
    warnings.push({
      kind: 'too-short',
      message:
        'Short phrases match inside many words (e.g. "ai" hides "rain"). Use a longer phrase or enable Whole word.',
      samples: [],
    });
  }

  // Safe-content conflict: matches inside titles the sample marks as
  // human-made/safe. These are the false positives the user is about to
  // create — shown BEFORE saving.
  const safeHits = matches.filter((m) => m.safe).slice(0, 3);
  if (safeHits.length > 0) {
    warnings.push({
      kind: 'may-hide-safe-content',
      message: `This phrase also matches ${safeHits.length} likely human-made title${
        safeHits.length === 1 ? '' : 's'
      } in the sample:`,
      samples: safeHits.map((m) => m.title),
    });
  }

  return {
    phrase,
    wholeWord: rule.wholeWord,
    matchCount: matches.length,
    sampleSize: sample.length,
    matches: matches.slice(0, 5),
    warnings,
  };
}

/** Placeholder for future category scoping (kept out of V7 policy changes). */
export type PreviewScopeCategory = EvidenceCategory | undefined;
