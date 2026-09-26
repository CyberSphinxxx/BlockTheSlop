import { useCallback, useEffect, useMemo, useState } from 'react';
import type { DailyStatsState, DayBucket } from '@/domain/stats-daily';
import { STATS_MAX_DAYS } from '@/domain/stats-daily';
import { Button, ConfirmDialog, Section } from '@/ui/components/primitives';
import type { Backend } from '@/ui/messaging';

/**
 * V6-12: local statistics page.
 *
 * Honesty rules:
 * - Ranges: Today / 7 days / 30 days / All time (bounded to the 90-day
 *   retention window — "All time" says so explicitly).
 * - Distinct video counts and event counts are shown separately and labeled;
 *   no lifetime history counts are presented as stats.
 * - Empty state ("no outcomes recorded in this range"), collection-off state
 *   (explains outcomes are not being collected), and error state are all
 *   explicit — never a fake zero.
 * - By-category breakdown appears ONLY where the bucket stores real
 *   provenance (Shorts vs regular surfaces are recorded as separate
 *   distinct-ID entries in V6-11 follow-ups); this page shows aggregate
 *   outcome counts and does not invent categories.
 * - Reset clears ONLY daily stats (rules/review/corrections survive) behind a
 *   confirmation dialog.
 */

type RangeId = 'today' | '7d' | '30d' | 'all';

const RANGES: readonly { id: RangeId; label: string; days: number }[] = [
  { id: 'today', label: 'Today', days: 1 },
  { id: '7d', label: 'Last 7 days', days: 7 },
  { id: '30d', label: 'Last 30 days', days: 30 },
  { id: 'all', label: 'All recorded time', days: STATS_MAX_DAYS },
];

function dayKey(offsetDaysAgo: number): string {
  const d = new Date();
  d.setDate(d.getDate() - offsetDaysAgo);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function StatsTab({ backend }: { backend: Backend }) {
  const [state, setState] = useState<DailyStatsState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [range, setRange] = useState<RangeId>('today');
  const [confirmReset, setConfirmReset] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [collectLocalStats, setCollectLocalStats] = useState(true);

  const reload = useCallback(async () => {
    try {
      const [daily, settings] = await Promise.all([backend.getDailyStats(), backend.getSettings()]);
      setState(daily);
      setCollectLocalStats(settings.collectLocalStats);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [backend]);

  useEffect(() => {
    void Promise.resolve().then(() => {
      void reload();
    });
  }, [reload]);

  const days: Array<{ key: string; bucket: DayBucket }> = useMemo(() => {
    if (state === null) return [];
    const rangeDef = RANGES.find((r) => r.id === range)!;
    const keys: string[] = [];
    for (let i = 0; i < rangeDef.days; i++) keys.push(dayKey(i));
    return keys
      .filter((key) => state.days[key] !== undefined)
      .map((key) => ({ key, bucket: state.days[key]! }))
      .reverse();
  }, [state, range]);

  // Audit H3: multi-day DISTINCT tiles use the UNION of identity sets —
  // summing per-day sizes counted the same video once per day it appeared,
  // contradicting the "distinct" label. Sightings stay event totals.
  const totals = useMemo(() => {
    const hiddenUnion = new Set<string>();
    const warnedUnion = new Set<string>();
    let hides = 0;
    let warns = 0;
    let restores = 0;
    let manualBlocks = 0;
    let activeDays = 0;
    for (const { bucket } of days) {
      for (const id of bucket.distinctHidden) hiddenUnion.add(id);
      for (const id of bucket.distinctWarned) warnedUnion.add(id);
      hides += bucket.hides;
      warns += bucket.warns;
      restores += bucket.restores;
      manualBlocks += bucket.manualBlocks;
      if (bucket.hides + bucket.warns > 0) activeDays += 1;
    }
    return {
      distinctHidden: hiddenUnion.size,
      distinctWarned: warnedUnion.size,
      hides,
      warns,
      restores,
      manualBlocks,
      activeDays,
    };
  }, [days]);

  if (error !== null) {
    return (
      <Section title="Statistics">
        <div role="alert" className="text-sm">
          <p className="font-semibold">Statistics could not be loaded.</p>
          <p className="mt-1 opacity-70">{error}</p>
          <div className="mt-2">
            <Button onClick={() => void reload()}>Retry</Button>
          </div>
        </div>
      </Section>
    );
  }

  if (state === null) {
    return (
      <Section title="Statistics">
        <p className="text-sm opacity-70" aria-busy="true">
          Loading statistics…
        </p>
      </Section>
    );
  }

  // Audit H2: read the REAL setting — the hardcoded false made the required
  // collection-off state unreachable.
  const collectionOff = !collectLocalStats;

  return (
    <>
      <Section title="Statistics (stored only on this device)">
        <div className="mb-3 flex flex-wrap gap-1" role="tablist" aria-label="Time range">
          {RANGES.map((r) => (
            <button
              key={r.id}
              type="button"
              role="tab"
              aria-selected={range === r.id}
              onClick={() => setRange(r.id)}
              className={`rounded px-2 py-1 text-sm ${
                range === r.id
                  ? 'bg-black/10 font-semibold dark:bg-white/20'
                  : 'opacity-70 hover:opacity-100'
              }`}
            >
              {r.label}
            </button>
          ))}
        </div>

        {collectionOff && (
          <p role="note" className="mb-2 text-sm opacity-70">
            Local statistics are currently OFF (General tab) — new outcomes are not being recorded.
            Existing recorded days below are still shown; no data was deleted.
          </p>
        )}

        {days.length === 0 ? (
          <p className="text-sm opacity-70" role="status">
            No outcomes recorded in this range. When videos are hidden or warned on YouTube, the
            daily totals appear here — stored only on this device, never uploaded.
          </p>
        ) : (
          <>
            <div className="mb-3 grid grid-cols-2 gap-2 text-sm sm:grid-cols-4" role="status">
              <div className="rounded border border-black/10 p-2 dark:border-white/10">
                <div className="text-xs uppercase tracking-wide opacity-70">Distinct hidden</div>
                <div className="text-lg font-bold">{totals.distinctHidden}</div>
              </div>
              <div className="rounded border border-black/10 p-2 dark:border-white/10">
                <div className="text-xs uppercase tracking-wide opacity-70">Distinct warned</div>
                <div className="text-lg font-bold">{totals.distinctWarned}</div>
              </div>
              <div className="rounded border border-black/10 p-2 dark:border-white/10">
                <div className="text-xs uppercase tracking-wide opacity-70">Restored by you</div>
                <div className="text-lg font-bold">{totals.restores}</div>
              </div>
              <div className="rounded border border-black/10 p-2 dark:border-white/10">
                <div className="text-xs uppercase tracking-wide opacity-70">Days with activity</div>
                <div className="text-lg font-bold">{totals.activeDays}</div>
              </div>
            </div>

            {/* Accessible data table (not a decorative chart): every value is
                real recorded data; distinct vs event counts are separate. */}
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <caption className="sr-only">
                  Daily outcome counts. Distinct counts are unique videos; event counts include
                  repeat sightings.
                </caption>
                <thead>
                  <tr className="border-b border-black/10 text-left dark:border-white/10">
                    <th scope="col" className="py-1 pr-3 font-semibold">
                      Day
                    </th>
                    <th scope="col" className="py-1 pr-3 font-semibold">
                      Hidden (distinct)
                    </th>
                    <th scope="col" className="py-1 pr-3 font-semibold">
                      Warned (distinct)
                    </th>
                    <th scope="col" className="py-1 pr-3 font-semibold">
                      Restored
                    </th>
                    <th scope="col" className="py-1 font-semibold">
                      Manually blocked
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {days.map(({ key, bucket }) => (
                    <tr key={key} className="border-b border-black/5 dark:border-white/5">
                      <td className="py-1 pr-3">{key}</td>
                      <td className="py-1 pr-3">
                        {bucket.distinctHidden.size}
                        {bucket.distinctHidden.size !== bucket.hides && (
                          <span className="ml-1 text-xs opacity-60">
                            ({bucket.hides} sightings)
                          </span>
                        )}
                      </td>
                      <td className="py-1 pr-3">
                        {bucket.distinctWarned.size}
                        {bucket.distinctWarned.size !== bucket.warns && (
                          <span className="ml-1 text-xs opacity-60">
                            ({bucket.warns} sightings)
                          </span>
                        )}
                      </td>
                      <td className="py-1 pr-3">{bucket.restores}</td>
                      <td className="py-1">{bucket.manualBlocks}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <p className="mt-2 text-xs opacity-70">
              Range covers up to {STATS_MAX_DAYS} days (bounded storage). Counts are observed
              outcomes — they never measure detector accuracy and never claim any video is
              definitely AI. Corrections and restores are recorded; they do not erase the historical
              observation.
            </p>
          </>
        )}

        {notice !== null && (
          <p className="mt-2 text-sm" role="status">
            {notice}
          </p>
        )}

        <div className="mt-4 flex gap-2">
          <Button onClick={() => void reload()}>Refresh</Button>
          <Button onClick={() => setConfirmReset(true)}>Reset statistics…</Button>
        </div>
        <p className="mt-1 text-xs opacity-70">
          Reset clears ONLY these daily statistics. Filtering rules, review history and corrections
          are never touched.
        </p>
      </Section>

      {confirmReset && (
        <ConfirmDialog
          label="Reset daily statistics?"
          confirmLabel="Reset statistics"
          danger
          onConfirm={() => {
            void (async () => {
              try {
                await backend.resetDailyStats();
                setNotice('Daily statistics were reset. Rules and review data are untouched.');
                await reload();
              } catch (e) {
                setNotice(
                  `Reset failed: ${e instanceof Error ? e.message : String(e)} — nothing was deleted.`,
                );
              }
              setConfirmReset(false);
            })();
          }}
          onCancel={() => setConfirmReset(false)}
        >
          This clears the recorded daily outcome counts on this device. Your filtering rules, review
          history and corrections are NOT affected. This cannot be undone.
        </ConfirmDialog>
      )}
    </>
  );
}
