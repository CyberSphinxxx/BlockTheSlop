import React, { useMemo, useState } from 'react';
import { Button } from '@/ui/components/primitives';
import { previewPhraseRule, type PhrasePreviewResult } from '@/domain/rule-preview';

/**
 * CFG-05 + V7-09: literal phrase block rules with a SAFE PREVIEW.
 *
 * - Phrases are LITERAL text (no wildcards, no regex — user input is never
 *   interpreted as a pattern).
 * - Two match modes: substring (legacy behavior) and whole word
 *   (Unicode-aware boundaries — Filipino, accents, emoji, punctuation).
 * - While typing, the rule is previewed against a bounded LOCAL sample with
 *   an honest denominator, estimated matches, and warnings for accidental
 *   broad matches and likely human-made titles it would also hide.
 * - Enter previews/updates only; saving is an explicit button click.
 */

export function PhraseEditor({
  phrases,
  phraseRules,
  onAdd,
  onRemove,
}: {
  phrases: string[];
  phraseRules: { phrase: string; wholeWord: boolean }[];
  onAdd: (phrase: string, wholeWord: boolean) => void;
  onRemove: (phrase: string) => void;
}): React.ReactElement {
  const [draft, setDraft] = useState('');
  const [wholeWord, setWholeWord] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const allPhrases = useMemo(
    () => [...phrases.map((p) => ({ phrase: p, wholeWord: false })), ...phraseRules],
    [phrases, phraseRules],
  );

  // Live preview via useMemo (pure, bounded 24-item sample — no effect, no
  // cascading renders; the eslint react-hooks rule forbids setState-in-effect).
  const preview: PhrasePreviewResult | null = useMemo(() => {
    const phrase = draft.trim();
    if (phrase.length === 0) return null;
    return previewPhraseRule({ phrase, wholeWord });
  }, [draft, wholeWord]);

  const duplicate = allPhrases.some((p) => p.phrase.toLowerCase() === draft.trim().toLowerCase());

  const submit = (): void => {
    const phrase = draft.trim();
    if (phrase.length === 0) {
      setError('Enter a phrase first.');
      return;
    }
    if (duplicate) {
      setError('That phrase is already blocked.');
      return;
    }
    setError(null);
    onAdd(phrase, wholeWord);
    setDraft('');
  };

  return (
    <div className="mt-3">
      <h3 className="text-xs font-semibold uppercase opacity-60">Blocked phrases</h3>
      <p className="mb-2 text-xs opacity-70">
        Hide any video whose title contains one of these phrases. Literal text only — no wildcards,
        no regex. Checked before your Not-AI corrections.
      </p>
      <form
        className="flex flex-wrap items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <input
          type="text"
          value={draft}
          onChange={(e) => {
            setDraft(e.currentTarget.value);
            setError(null);
          }}
          aria-label="Phrase to block"
          placeholder="e.g. ai generated"
          className="w-56 rounded border border-black/20 px-2 py-1 text-sm"
        />
        <label className="flex items-center gap-1 text-xs">
          <input
            type="checkbox"
            checked={wholeWord}
            onChange={(e) => setWholeWord(e.currentTarget.checked)}
          />
          Whole word
        </label>
        <Button onClick={submit}>Add phrase</Button>
        {error !== null && (
          <span role="alert" className="text-xs text-red-700">
            {error}
          </span>
        )}
      </form>

      {preview !== null && (
        <div
          className="mt-2 rounded-lg border border-black/10 bg-black/[0.03] px-3 py-2 text-xs dark:border-white/10 dark:bg-white/[0.06]"
          data-testid="phrase-preview"
        >
          <div className="font-semibold">
            Preview: {preview.matchCount === 0 ? 'no matches' : `~${preview.matchCount}`} of{' '}
            {preview.sampleSize} in the local sample
          </div>
          {preview.matches.length > 0 && (
            <ul className="mt-1 list-disc pl-4 opacity-80">
              {preview.matches.map((m) => (
                <li key={m.title}>“{m.title}”</li>
              ))}
            </ul>
          )}
          {preview.warnings.map((w) => (
            <div key={w.kind} className="mt-1 text-amber-700 dark:text-amber-400">
              <span className="font-semibold">
                {w.kind === 'too-short' ? 'Broad match risk:' : 'May hide human-made videos:'}
              </span>{' '}
              {w.message}
              {w.samples.length > 0 && (
                <ul className="mt-0.5 list-disc pl-4">
                  {w.samples.map((s) => (
                    <li key={s}>“{s}”</li>
                  ))}
                </ul>
              )}
            </div>
          ))}
        </div>
      )}

      {allPhrases.length > 0 && (
        <ul className="mt-2 text-sm">
          {allPhrases.map((p) => (
            <li
              key={`${p.wholeWord ? 'w' : 's'}:${p.phrase}`}
              className="flex items-center justify-between py-0.5"
            >
              <span>
                “{p.phrase}”
                {p.wholeWord && <span className="ml-2 text-xs opacity-60">(whole word)</span>}
              </span>
              <Button onClick={() => onRemove(p.phrase)}>Remove</Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
