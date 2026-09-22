import type { Evidence, EvidenceCategory, ClaimScope } from '@/domain/evidence';
import type { NormalizedVideoCandidate } from '@/domain/video';
import type { DetectionContext } from '@/domain/evidence';
import type { Detector } from '../engine';

/**
 * Creator self-disclosure detector — description phrases that clearly state
 * generated provenance, scoped precisely (audit R14):
 * - a thumbnail-only declaration affects ONLY the thumbnail category (DET-20);
 * - voice/music claims stay in their dimension; text STYLE alone is never
 *   script evidence — a script disclosure requires an explicit statement
 *   that the script/text itself was AI-written (DET-21);
 * - every item carries claimScope + correlationKey so overlapping matches
 *   are deduped before aggregation (DET-17).
 */
const DESCRIPTION_PATTERNS: readonly {
  re: RegExp;
  text: string;
  category: EvidenceCategory;
  scope: ClaimScope;
  correlation: string;
}[] = [
  {
    re: /\bthis\s+(video|film|short|story)\s+(was|is)\s+(created|made|generated)\s+(with|using|by)\s+(an?\s+)?A\.?I\.?\b/i,
    text: 'The description states the video was created with AI.',
    category: 'creator-disclosure',
    scope: 'unspecified-generation',
    correlation: 'disclosure:generation',
  },
  {
    re: /\b(all|the)\s+(visuals?|footage|animation|imagery)\s+(in\s+this\s+video\s+)?(are|is|was|were)\s+A\.?I\.?\s*-?\s*generated/i,
    text: 'The description says the visuals are AI-generated.',
    category: 'ai-visual',
    scope: 'visual',
    correlation: 'disclosure:visuals',
  },
  {
    re: /\b(voice|narration)\s+(is|was)\s+(an?\s+)?A\.?I\.?\b|\bgenerated\s+voice\b/i,
    text: 'The description discloses an AI voice.',
    category: 'ai-voice',
    scope: 'audio',
    correlation: 'disclosure:voice',
  },
  {
    re: /\bmusic\s+(was\s+)?(generated|created)\s+(with|using|by)\s+(suno|udio|A\.?I\.?)\b/i,
    text: 'The description says the music was AI-generated.',
    category: 'ai-music',
    scope: 'music',
    correlation: 'disclosure:music',
  },
  {
    // DET-21: explicit script disclosure only — "AI-style text" or "reads like
    // AI" is NOT evidence that the script was AI-written.
    re: /\b(script|screenplay)\s+(was\s+)?(written|generated|created)\s+(with|using|by)\s+(an?\s+)?A\.?I\.?\b/i,
    text: 'The description states the script was AI-written.',
    category: 'ai-script',
    scope: 'script',
    correlation: 'disclosure:script',
  },
  {
    // DET-20: thumbnail-scoped declarations.
    re: /\b(thumbnail|thumbnails)\s+(was\s+|were\s+)?(made|created|generated)\s+(with|using|by|in)\s+\w+/i,
    text: 'The description says the thumbnail was AI-generated; the video itself is not implicated.',
    category: 'ai-thumbnail',
    scope: 'thumbnail',
    correlation: 'disclosure:thumbnail',
  },
];

export const creatorDisclosureDetector: Detector = {
  id: 'creator-disclosure',
  detect(candidate: NormalizedVideoCandidate, _context: DetectionContext): Evidence[] {
    const description = candidate.description;
    if (description === undefined) return [];
    const evidence: Evidence[] = [];
    for (const { re, text, category, scope, correlation } of DESCRIPTION_PATTERNS) {
      const found = re.exec(description);
      if (found !== null) {
        evidence.push({
          id: `creator-disclosure:${correlation}`,
          origin: 'local-rule',
          category,
          detector: 'creator-disclosure',
          strength: 0.8,
          polarity: 'supports',
          reasonCode: 'creator-self-disclosure',
          reasonText: text,
          sourceKind: 'description',
          matchedField: 'description',
          matchedExcerpt: found[0].slice(0, 120),
          claimScope: scope,
          correlationKey: correlation,
        });
      }
      if (evidence.length >= 3) break;
    }
    return evidence;
  },
};
