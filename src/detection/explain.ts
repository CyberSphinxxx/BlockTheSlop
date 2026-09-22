import type { Classification } from '@/domain/classification';

/**
 * Human-readable explanation lines for a classification. Every automatic
 * warn/hide must produce at least one line (DETECTION_ENGINE.md §10).
 * Language is deliberately hedged: "Likely", "Suspected" — never certain.
 */
export function explainClassification(classification: Classification): string[] {
  const lines: string[] = [];

  const supporting = classification.evidence.filter((e) => e.polarity === 'supports');
  const disclosure = supporting.filter((e) => e.origin === 'first-party');
  const rules = supporting.filter(
    (e) => e.origin === 'local-rule' && e.category !== 'ai-discussion',
  );

  if (classification.aiLikelihood >= 0.6) {
    lines.push('Likely AI-generated');
  } else if (classification.slopLikelihood >= 0.6) {
    lines.push('Suspected automated or low-effort content');
  }

  for (const item of disclosure) {
    lines.push(item.reasonText);
  }
  for (const item of rules.slice(0, 3)) {
    lines.push(item.reasonText);
  }

  if (lines.length === 0) {
    lines.push('Heuristic signals matched; this may be a false positive.');
  }
  if (classification.confidence === 'low' || classification.confidence === 'medium') {
    lines.push('This is a heuristic and may be wrong.');
  }
  return lines.slice(0, 6);
}
