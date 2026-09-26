import { useCallback, useState } from 'react';
import type { Backend } from '@/ui/messaging';
import type { MissReason, MissReviewEntry } from '@/domain/miss-review';
import { Button } from '@/ui/components/primitives';

/**
 * V7-07: local miss-review diagnostics (Review tab).
 *
 * These entries explain why the automatic filter did NOT hide a video the
 * user has marked as AI/slop. They are private local diagnostics — never
 * training data, never sent anywhere. Export produces a local JSON snapshot
 * only on explicit user action; clearing requires explicit confirmation.
 */

const REASON_LABELS: Record<MissReason, string> = {
  'no-evidence': 'No evidence found',
  'below-threshold': 'Below threshold',
  'category-warn': 'Category set to warn',
  'explicit-allow': 'Explicit allow',
  'unsupported-surface': 'Surface disabled',
  'unresolved-identity': 'Unresolved identity',
  error: 'Processing error',
};

const REASON_HINTS: Record<MissReason, string> = {
  'no-evidence': 'No visible text matched any rule or detector.',
  'below-threshold': 'Some evidence was present, but not strong enough for this mode.',
  'category-warn': 'The matched category is set to warn, so the video stayed visible.',
  'explicit-allow': 'A rule or correction of yours allowed this video.',
  'unsupported-surface': 'Filtering is off for the surface where this appeared.',
  'unresolved-identity': 'The video id could not be read from the card.',
  error: 'The pipeline hit an error while evaluating this card.',
};

function formatDate(ms: number): string {
  try {
    return new Date(ms).toLocaleString();
  } catch {
    return String(ms);
  }
}

export function MissReviewSection({ backend }: { backend: Backend }) {
  const [entries, setEntries] = useState<MissReviewEntry[] | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    const list = await backend.listMissReview();
    setEntries(list);
  }, [backend]);

  if (entries === null && !busy) {
    void refresh().catch(() => setEntries([]));
  }

  const onClear = async (): Promise<void> => {
    setBusy(true);
    try {
      await backend.clearMissReview();
      await refresh();
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  };

  const onExport = async (): Promise<void> => {
    setBusy(true);
    try {
      const snapshot = await backend.exportMissReview();
      const blob = new Blob(
        [JSON.stringify({ version: 1, exportedAt: Date.now(), entries: snapshot }, null, 2)],
        {
          type: 'application/json',
        },
      );
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `blocktheslop-miss-review-${new Date().toISOString().slice(0, 10)}.json`;
      anchor.click();
      URL.revokeObjectURL(url);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="mt-6 space-y-3 text-sm">
      <div>
        <h3 className="text-base font-semibold">Missed-video diagnostics</h3>
        <p className="mt-1 text-xs opacity-70">
          When you mark a video the filter missed, BlockTheSlop records WHY it stayed visible —
          locally only. This is <strong>never used for training</strong>, never sent anywhere, and
          stays on this device until you clear it.
        </p>
      </div>

      {entries !== null && entries.length === 0 ? (
        <p className="text-xs opacity-70">
          No missed videos recorded. Use “Report missed AI video” in YouTube's right-click menu to
          diagnose a video the filter passed.
        </p>
      ) : (
        <ul className="space-y-2">
          {(entries ?? []).map((entry) => (
            <li
              key={entry.id}
              className="rounded-lg border border-bts-border bg-bts-panel px-3 py-2"
            >
              <div className="flex items-baseline justify-between gap-2">
                <span className="min-w-0 truncate font-medium">{entry.title || entry.videoId}</span>
                <span className="shrink-0 text-xs opacity-60">seen {entry.sightingCount}×</span>
              </div>
              <div className="mt-0.5 text-xs opacity-80">
                <span className="font-semibold">{REASON_LABELS[entry.reason]}</span>
                {' — '}
                {REASON_HINTS[entry.reason]}
              </div>
              <div className="mt-0.5 text-xs opacity-60">
                {(entry.surfaces ?? [entry.surface]).join(', ')} · last seen{' '}
                {formatDate(entry.lastSeenAt)}
              </div>
            </li>
          ))}
        </ul>
      )}

      <div className="flex items-center gap-2">
        <Button variant="secondary" onClick={() => void onExport()} disabled={busy}>
          Export JSON
        </Button>
        {confirming ? (
          <>
            <Button variant="danger" onClick={() => void onClear()} disabled={busy}>
              Confirm clear
            </Button>
            <Button variant="secondary" onClick={() => setConfirming(false)} disabled={busy}>
              Cancel
            </Button>
          </>
        ) : (
          <Button variant="danger" onClick={() => setConfirming(true)} disabled={busy}>
            Clear
          </Button>
        )}
      </div>
    </section>
  );
}
