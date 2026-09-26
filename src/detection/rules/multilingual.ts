import type { TextRule } from './types';

/**
 * V7-10 multilingual disclosure pack — added BECAUSE the frozen dev set
 * flagged a labeled-miss cluster: non-English creator disclosures in the
 * video description ("Este video fue generado con IA", …) produced zero
 * evidence (FN on the AI axis in every mode). This pack mirrors the
 * English `creator-disclosure` rules: same category, same claim scope
 * (unspecified-generation — a disclosure never proves visuals/music/slop),
 * same correlation group (cross-language duplicates are ONE claim, not
 * independent corroboration, DET-17), same strength as `en:created-with-ai`.
 *
 * Rationale per kit contract: "Expand language/disclosure cases based on
 * frozen labeled misses" — each phrase below corresponds to dev-set or
 * parse-layer (V7-08) evidence; nothing was tuned against the holdout.
 *
 * Matching notes: `normalizeForMatch()` is NFKD, so accented characters
 * decompose into base letter + combining mark; `flexibleBody()` tolerates
 * an optional combining mark after every base letter. Negation scoping
 * ("no fue generado con IA") is inherited from the shared `matchRule`.
 */

/** Optional combining mark after a base letter (NFKD-decomposed accents). */
const MARK = '[\\u0300-\\u036f]';

/** Straight/curly apostrophes (normalizeForMatch folds most to '). */
const APOS = "['\u2019\u00B4`]";

function flexibleBody(phrase: string): string {
  const body = phrase
    .split(' ')
    .map((word) =>
      word
        .split('')
        .map((ch) => {
          if (ch === "'") return APOS;
          return /[a-z]/i.test(ch) ? `${ch}${MARK}?` : ch;
        })
        .join(''),
    )
    .join('\\s+');
  // Start at a Latin word boundary; the trailing lookahead stops before any
  // letter (a plain \b would fail after a matched combining mark).
  return `\\b${body}(?![\\p{L}])`;
}

function flexibleAny(phrases: readonly string[]): RegExp {
  return new RegExp(phrases.map(flexibleBody).join('|'), 'iu');
}

/** es/pt share many shapes; Italian/French use l'IA apostrophe forms. */
function disclosureRule(
  id: string,
  locale: string,
  phrases: readonly string[],
  reasonText: string,
): TextRule {
  return {
    id,
    locale,
    pattern: flexibleAny(phrases),
    category: 'creator-disclosure',
    strength: 0.85,
    context: 'both',
    claimScope: 'unspecified-generation',
    correlationKey: 'disclosure:generation',
    reasonText,
  };
}

export const MULTILINGUAL_RULES: readonly TextRule[] = [
  disclosureRule(
    'es:generated-with-ia',
    'es',
    [
      'generado con ia',
      'generada con ia',
      'generado por ia',
      'generada por ia',
      'creado con ia',
      'creada con ia',
      'hecho con ia',
      'generado con inteligencia artificial',
      'creado con inteligencia artificial',
    ],
    'The Spanish description says the video was generated or created with AI.',
  ),
  disclosureRule(
    'pt:criado-com-ia',
    'pt',
    [
      'criado com ia',
      'criada com ia',
      'criado por ia',
      'gerado com ia',
      'gerada com ia',
      'gerado por ia',
      'feito com ia',
      'criado com inteligencia artificial',
      'gerado com inteligencia artificial',
    ],
    'The Portuguese description says the video was generated or created with AI.',
  ),
  disclosureRule(
    'fr:cree-avec-ia',
    'fr',
    [
      'cree avec l ia',
      'creee avec l ia',
      'genere avec l ia',
      'generee avec l ia',
      'cree par ia',
      'generee par ia',
      'cree par intelligence artificielle',
      'genere par intelligence artificielle',
    ],
    'The French description says the video was generated or created with AI.',
  ),
  disclosureRule(
    'it:creato-con-ia',
    'it',
    [
      'creato con l ia',
      'creata con l ia',
      'creato con ia',
      'creata con ia',
      'generato con ia',
      'generata con ia',
      'creato con intelligenza artificiale',
      'generato con intelligenza artificiale',
    ],
    'The Italian description says the video was generated or created with AI.',
  ),
  disclosureRule(
    'de:ki-generiert',
    'de',
    [
      'ki-generiert',
      'ki generiert',
      'mit ki erzeugt',
      'mit ki erstellt',
      'mit kunstlicher intelligenz erstellt',
      'mit kunstlicher intelligenz erzeugt',
    ],
    'The German description says the video was generated or created with AI.',
  ),
  {
    // Japanese has no spaces or Latin word boundaries; anchor on the ASCII
    // "AI" token and allow the standard generation-verb phrases. Scope is
    // deliberately narrow to stay false-positive-safe.
    id: 'ja:ai-generated',
    locale: 'ja',
    pattern:
      /\bAI\s*(?:\u3067|\u306b\u3088\u308a|\u3092\u5229\u7528\u3057\u3066)?\s*\u751F\u6210/iu,
    category: 'creator-disclosure',
    strength: 0.85,
    context: 'both',
    claimScope: 'unspecified-generation',
    correlationKey: 'disclosure:generation',
    reasonText: 'The Japanese text says the content was AI-generated (AI生成).',
  },
];
