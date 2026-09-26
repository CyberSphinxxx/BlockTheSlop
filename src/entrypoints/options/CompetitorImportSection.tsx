import { useCallback, useState } from 'react';
import {
  previewCompetitorImport,
  applyCompetitorImport,
  CompetitorImportRejectedError,
} from '@/domain/competitor-import';
import type { ImportPreviewReport } from '@/domain/competitor-import';
import type { UserRules } from '@/domain/rules';
import { Button } from '@/ui/components/primitives';

/**
 * V7-11: optional import preview for BlockTube/FilterTube LOCAL files
 * (Import/export tab). Nothing runs automatically: the user picks a file, a
 * MAPPING REPORT is shown (mapped rules, duplicates, unsupported features,
 * unresolved channel names), and rules change only when the user presses
 * Apply. Apply persists first and re-renders on success; a persistence
 * failure restores the pre-apply snapshot (rollback) with a visible error.
 * Remote lists are never fetched — this section reads one local file.
 */

type Notice = { kind: 'error' | 'info'; text: string } | null;

export function CompetitorImportSection({
  rules,
  onApply,
}: {
  rules: UserRules;
  /** Persist merged rules; return false (or throw) on failure — the caller rolls back its own state. */
  onApply: (next: UserRules) => Promise<boolean>;
}) {
  const [preview, setPreview] = useState<ImportPreviewReport | null>(null);
  const [notice, setNotice] = useState<Notice>(null);
  const [busy, setBusy] = useState(false);

  const onFile = useCallback(async (file: File) => {
    setBusy(true);
    setNotice(null);
    try {
      const text = await file.text();
      setPreview(previewCompetitorImport(text, 'auto', file.name));
    } catch (error) {
      setPreview(null);
      const message =
        error instanceof CompetitorImportRejectedError
          ? error.message
          : 'The file could not be read as a rule list.';
      setNotice({ kind: 'error', text: message });
    } finally {
      setBusy(false);
    }
  }, []);

  const onApplyClick = useCallback(async () => {
    if (preview === null) return;
    const merged = applyCompetitorImport(preview, rules);
    setBusy(true);
    try {
      // Persist BEFORE acknowledging success (transactional contract); the
      // parent owns persistence and rolls back its own state on failure.
      const ok = await onApply(merged);
      if (ok) {
        setPreview({ ...preview, applied: true });
        setNotice({ kind: 'info', text: 'Imported rules were applied.' });
      } else {
        setPreview(null);
        setNotice({
          kind: 'error',
          text: 'Applying the import failed. Your rules were not changed.',
        });
      }
    } catch {
      setPreview(null);
      setNotice({
        kind: 'error',
        text: 'Applying the import failed. Your rules were not changed.',
      });
    } finally {
      setBusy(false);
    }
  }, [preview, rules, onApply]);

  const onDismiss = useCallback(() => {
    setPreview(null);
    setNotice(null);
  }, []);

  return (
    <section className="mt-6 space-y-3 text-sm">
      <div>
        <h3 className="text-base font-semibold">Import from other extensions</h3>
        <p className="mt-1 text-xs opacity-70">
          Read a locally exported BlockTube or FilterTube JSON file and preview how its rules would
          map here. Nothing is applied until you press Apply. Channel names cannot be verified, so
          only channel IDs, @handles, video IDs and literal keywords are imported; regex rules are
          not supported.
        </p>
      </div>

      <input
        type="file"
        accept=".json,application/json"
        aria-label="Competitor rules file"
        className="block w-full cursor-pointer rounded-lg border border-bts-border bg-bts-panel px-3 py-2 text-xs"
        onChange={(e) => {
          const file = e.currentTarget.files?.[0];
          if (file !== undefined) void onFile(file);
          e.currentTarget.value = '';
        }}
      />

      {notice !== null && (
        <p
          role={notice.kind === 'error' ? 'alert' : 'status'}
          className={
            notice.kind === 'error'
              ? 'text-xs text-red-500'
              : 'text-xs text-[var(--bts-ok,#3f9d63)]'
          }
        >
          {notice.text}
        </p>
      )}

      {preview !== null && (
        <div className="space-y-2 rounded-lg border border-bts-border bg-bts-panel px-3 py-2 text-xs">
          <div className="font-semibold">
            Preview: {preview.format} — {preview.fileName}
          </div>
          {preview.isEmpty ? (
            <p className="opacity-70">
              Nothing in this file could be mapped (no channel IDs, video IDs, @handles, or
              keywords).
            </p>
          ) : (
            <ul className="list-disc space-y-0.5 pl-4">
              {preview.mapped.channelIds.length > 0 && (
                <li>
                  {preview.mapped.channelIds.length} channel ID
                  {preview.mapped.channelIds.length === 1 ? '' : 's'}
                </li>
              )}
              {preview.mapped.handles.length > 0 && (
                <li>
                  {preview.mapped.handles.length} @handle
                  {preview.mapped.handles.length === 1 ? '' : 's'}
                </li>
              )}
              {preview.mapped.videoIds.length > 0 && (
                <li>
                  {preview.mapped.videoIds.length} video ID
                  {preview.mapped.videoIds.length === 1 ? '' : 's'}
                </li>
              )}
              {preview.mapped.phrases.length > 0 && (
                <li>
                  {preview.mapped.phrases.length} keyword phrase
                  {preview.mapped.phrases.length === 1 ? '' : 's'}
                  {preview.mapped.phrases.some((p) => p.wholeWord) ? ' (some whole-word)' : ''}
                </li>
              )}
            </ul>
          )}
          {preview.duplicates.channelIds +
            preview.duplicates.videoIds +
            preview.duplicates.phrases >
            0 && (
            <p className="opacity-70">
              Duplicates skipped:{' '}
              {preview.duplicates.channelIds +
                preview.duplicates.videoIds +
                preview.duplicates.phrases}
            </p>
          )}
          {preview.unresolvedChannels.length > 0 && (
            <p className="opacity-70">
              {preview.unresolvedChannels.length} channel name
              {preview.unresolvedChannels.length === 1 ? '' : 's'} not imported (names are not
              verified identities): {preview.unresolvedChannels.slice(0, 5).join(', ')}
              {preview.unresolvedChannels.length > 5 ? '…' : ''}
            </p>
          )}
          {preview.unsupported.length > 0 && (
            <p className="opacity-70">Not imported: {preview.unsupported.join('; ')}</p>
          )}
          <p className="opacity-50">{preview.licenseNote}</p>
          {preview.applied ? (
            <p className="font-semibold">Applied.</p>
          ) : (
            <div className="flex gap-2">
              <Button onClick={() => void onApplyClick()} disabled={busy || preview.isEmpty}>
                Apply import
              </Button>
              <Button variant="secondary" onClick={onDismiss} disabled={busy}>
                Discard
              </Button>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
