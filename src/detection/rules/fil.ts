import type { TextRule } from './types';

/**
 * Filipino/Tagalog rules (DETECTION_ENGINE.md §9; audit R14).
 *
 * DET-02: mixed EN/FIL titles like
 * "Foodtrip muna ng Lava Chocolate Cake!! ai generated tagalog video using
 * veo 3! #ai" must yield EN/FIL generation evidence but NOT music evidence.
 * The English pack always runs additively (rules/index.ts), so these rules
 * cover the Filipino-specific phrases; word boundaries keep "ai" safe.
 */
export const FIL_RULES: readonly TextRule[] = [
  {
    id: 'fil:gawa-sa-ai',
    locale: 'fil',
    pattern: /\bgawa\s+(ng|sa)\s+A\.?I\.?\b|\binilikha\s+ng\s+A\.?I\.?\b/i,
    category: 'creator-disclosure',
    strength: 0.8,
    context: 'both',
    claimScope: 'unspecified-generation',
    correlationKey: 'disclosure:generation',
    reasonText: 'Ipinapahiwatig ng teksto na gawa ito ng AI.',
  },
  {
    id: 'fil:ai-generated-video',
    locale: 'fil',
    pattern:
      /\bA\.?I\.?\s+generated\s+(tagalog|filipino|bisaya)?\s*(video|kwento|storya|short)\b|\b(tagalog|filipino)\s+A\.?I\.?\s+(video|kwento)\b/i,
    category: 'creator-disclosure',
    strength: 0.8,
    context: 'both',
    claimScope: 'unspecified-generation',
    correlationKey: 'disclosure:generation',
    reasonText: 'Ang teksto ay nagsasabing AI-generated ang video.',
  },
  {
    id: 'fil:ai-boses',
    locale: 'fil',
    pattern: /\bA\.?I\.?\s+(na\s+)?(boses?|pagkukuwento|narration)\b/i,
    category: 'ai-voice',
    strength: 0.6,
    context: 'both',
    claimScope: 'audio',
    correlationKey: 'disclosure:voice',
    reasonText: 'Ang teksto ay tumutukoy sa boses na gawa ng AI.',
  },
  {
    id: 'fil:discussion-paliwanag',
    locale: 'fil',
    pattern:
      /\b(paliwanag|pagtalakay|balita|panganib|epekto)\s+(ng|tungkol\s+sa)\s+(A\.?I\.?|artipisyal\s+na\s+katalinuhan)\b/i,
    category: 'ai-discussion',
    strength: 0.55,
    context: 'title',
    polarity: 'opposes',
    reasonText: 'Paliwanag o balita ito tungkol sa AI, hindi gawang AI.',
  },
  {
    id: 'fil:clickbait',
    locale: 'fil',
    pattern: /\bhindi\s+ka\s+maniniwala\b|\bkakagulat\b.*\bpangyayari\b/i,
    category: 'clickbait',
    strength: 0.35,
    context: 'title',
    reasonText: 'Klasikong clickbait na pamagat.',
  },
];
