import { useCallback, useEffect, useState } from 'react';
import type { EvidenceCategory } from '@/domain/evidence';
import { EVIDENCE_CATEGORIES } from '@/domain/evidence';
import type { CategoryAction, FilterMode, UserSettings } from '@/domain/settings';
import { validateSettings } from '@/domain/settings';
import type { DailyStatsState } from '@/domain/stats-daily';
import { dayBucketFor } from '@/domain/stats-daily';
import { Button, SegmentedControl } from '@/ui/components/primitives';
import type { Backend } from '@/ui/messaging';
import { applyThemeToDocument } from '@/ui/theme';

/** Quick category controls shown in the popup (explicit select, no cycling). */
const QUICK_CATEGORIES: readonly EvidenceCategory[] = [
  'ai-visual',
  'ai-voice',
  'ai-music',
  'ai-thumbnail',
  'content-farm',
];

const CATEGORY_LABELS: Record<EvidenceCategory, string> = {
  'ai-visual': 'AI-generated video',
  'ai-voice': 'AI voice',
  'ai-script': 'AI-written script',
  'ai-music': 'AI music',
  'ai-thumbnail': 'AI thumbnail',
  'ai-unspecified': 'AI-generated (type unspecified)',
  deepfake: 'Synthetic person',
  'content-farm': 'Content farms',
  repetitive: 'Repetitive content',
  clickbait: 'Clickbait',
  'ai-discussion': 'AI discussion',
  'creator-disclosure': 'Creator disclosure',
};

const ACTION_OPTIONS: readonly { value: CategoryAction; label: string }[] = [
  { value: 'allow', label: 'Allow' },
  { value: 'warn', label: 'Warn' },
  { value: 'hide', label: 'Hide' },
];

/**
 * Status of the ACTIVE tab, from the content script's own report (V6-08).
 * 'unavailable' covers non-YouTube pages and tabs where the content script
 * is not (yet) loaded; 'error' covers a real failure. No blind "connected".
 */
type TabStatus =
  | { kind: 'checking' }
  | { kind: 'active'; surface: string; distinctHidden: number; collectLocalStats: boolean }
  | { kind: 'paused' }
  | { kind: 'unavailable' }
  | { kind: 'error'; message: string };

interface StatusResponse {
  state?: 'active' | 'paused';
  surface?: string;
  distinctHidden?: number;
  collectLocalStats?: boolean;
}

export function PopupApp({ backend }: { backend: Backend }) {
  const [settings, setSettings] = useState<UserSettings | null>(null);
  const [daily, setDaily] = useState<DailyStatsState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tabStatus, setTabStatus] = useState<TabStatus>({ kind: 'checking' });
  // The local day is computed ONCE per popup mount (stable across re-renders).
  const [todayKey] = useState(() => dayBucketFor(Date.now()));
  const [tabHides, setTabHides] = useState<Array<{ id: string; title?: string; videoId?: string }>>(
    [],
  );

  const refresh = useCallback(async () => {
    try {
      const [s, d] = await Promise.all([backend.getSettings(), backend.getDailyStats()]);
      setSettings(s);
      setDaily(d);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [backend]);

  const loadTabStatus = useCallback(async () => {
    try {
      const tabs = await browser.tabs.query({ active: true, currentWindow: true });
      const activeTab = tabs[0];
      if (!activeTab?.id) {
        setTabStatus({ kind: 'unavailable' });
        return;
      }
      const isYouTube = /^https?:\/\/([^/]*\.)?youtube\.com\//.test(activeTab.url ?? '');
      if (!isYouTube) {
        setTabStatus({ kind: 'unavailable' });
        return;
      }
      const status = (await browser.tabs.sendMessage(activeTab.id, {
        type: 'orchestrator:status',
      })) as StatusResponse | undefined;
      if (status === undefined) {
        setTabStatus({ kind: 'unavailable' });
        return;
      }
      if (status.state === 'paused') {
        setTabStatus({ kind: 'paused' });
        return;
      }
      setTabStatus({
        kind: 'active',
        surface: status.surface ?? 'unknown',
        distinctHidden: status.distinctHidden ?? 0,
        collectLocalStats: status.collectLocalStats ?? true,
      });
    } catch (e) {
      // No tabs API / no content script on this tab. A truly hostile failure
      // still must not crash the popup or produce a fake "connected" state.
      setTabStatus({
        kind: 'error',
        message: e instanceof Error ? e.message : String(e),
      });
    }
  }, []);

  const loadTabHides = useCallback(async () => {
    try {
      const tabs = await browser.tabs.query({ active: true, currentWindow: true });
      const activeTab = tabs[0];
      if (!activeTab?.id) return;
      const res = (await browser.tabs.sendMessage(activeTab.id, {
        type: 'session:listHides',
      })) as { hides?: Array<{ id: string; title?: string; videoId?: string }> } | undefined;
      if (Array.isArray(res?.hides)) setTabHides(res.hides);
    } catch {
      // Current tab is not YouTube or the content script is not loaded.
    }
  }, []);

  useEffect(() => {
    void Promise.resolve().then(() => {
      void refresh();
      void loadTabStatus();
      void loadTabHides();
    });
  }, [refresh, loadTabStatus, loadTabHides]);

  // Theme follows the setting immediately (same as options/onboarding).
  const theme = settings === null ? undefined : settings.theme;
  useEffect(() => {
    if (theme === undefined) return;
    return applyThemeToDocument(document, theme);
  }, [theme]);

  const save = useCallback(
    async (patch: Partial<UserSettings>) => {
      if (settings === null) return;
      const previous = settings;
      const optimistic = validateSettings({ ...previous, ...patch });
      if (optimistic === null) return;
      setSettings(optimistic); // immediate visible update
      try {
        await backend.saveSettings(patch);
        setError(null); // a later successful save clears any earlier notice
      } catch {
        // Visible rollback: the control returns to the stored value.
        setSettings(previous);
        setError('Saving failed — the change was not applied. Please try again.');
      }
    },
    [backend, settings],
  );

  if (error !== null && settings === null) {
    return (
      <div className="p-4 text-sm" role="alert">
        <p className="font-semibold">BlockTheSlop could not load its settings.</p>
        <p className="mt-1 opacity-70">{error}</p>
        <p className="mt-2 opacity-70">YouTube filtering is unaffected by this error.</p>
      </div>
    );
  }
  if (settings === null) {
    return (
      <div className="p-4 text-sm opacity-70" aria-busy="true">
        Loading…
      </div>
    );
  }

  const loadError = error; // non-null here means a SAVE failed (rolled back)

  // The local day is computed ONCE per popup mount (stable across re-renders).
  const todayBucket = daily?.days[todayKey];
  // Audit M3: the note comes from the AUTHORITATIVE settings the popup already
  // loaded — not from the content script's status report (which may be absent
  // when the content script has not loaded, hiding the note entirely).
  const statsNote = !settings.collectLocalStats
    ? 'Statistics are turned off in Settings — outcomes are not being collected.'
    : null;

  return (
    <div className="w-[340px] max-w-full p-4">
      {loadError !== null && (
        <div
          role="alert"
          className="mb-2 rounded border border-red-400/40 bg-red-500/10 p-2 text-xs"
        >
          {loadError}
        </div>
      )}
      <header className="mb-3 flex items-center justify-between gap-2">
        <h1 className="text-base font-bold">BlockTheSlop</h1>
        <SegmentedControl<'on' | 'off'>
          legend="Filtering"
          name="enabled"
          value={settings.enabled ? 'on' : 'off'}
          onChange={(v) => void save({ enabled: v === 'on' })}
          options={[
            { value: 'on', label: 'On' },
            { value: 'off', label: 'Off' },
          ]}
        />
      </header>

      {/* V6-08: active-tab status — honest states, never a blind "connected". */}
      <section
        className="rounded-md border border-black/10 p-2 text-sm dark:border-white/10"
        aria-label="Active tab status"
      >
        {tabStatus.kind === 'checking' && (
          <p className="opacity-70" aria-busy="true">
            Checking this tab…
          </p>
        )}
        {tabStatus.kind === 'active' && (
          <p>
            <span className="font-semibold">Active</span> on YouTube · {tabStatus.surface} ·{' '}
            {tabStatus.distinctHidden} hidden on this page
          </p>
        )}
        {tabStatus.kind === 'paused' && <p>Filtering is paused on this tab.</p>}
        {tabStatus.kind === 'unavailable' && (
          <p className="opacity-70">
            Not available here — BlockTheSlop only filters youtube.com pages.
          </p>
        )}
        {tabStatus.kind === 'error' && (
          <p className="opacity-70">
            This YouTube tab has not reported status yet (try reopening the popup).
          </p>
        )}
      </section>

      {statsNote !== null && (
        <p className="mt-2 text-xs opacity-70" role="note">
          {statsNote}
        </p>
      )}

      <SegmentedControl<FilterMode>
        legend="Filtering mode"
        name="mode"
        value={settings.mode}
        onChange={(mode) => void save({ mode })}
        options={[
          { value: 'safe', label: 'Safe', hint: 'Hide only very high-confidence content' },
          { value: 'balanced', label: 'Balanced', hint: 'Recommended' },
          {
            value: 'strict',
            label: 'Strict',
            hint: 'Hide moderate-confidence content; more false positives',
          },
          {
            value: 'aggressive',
            label: 'Aggressive',
            hint: 'Maximum AI recall; expect false positives (recoverable)',
          },
        ]}
      />

      {/* V6-08: LOCAL-CALENDAR-DAY outcomes (distinct videos), explicitly
          labeled — the old cumulative lifetime section labeled "Today" is
          gone. Distinct hidden IDs and warned IDs are different numbers. */}
      <section className="mt-3" aria-label="Outcomes today">
        <h2 className="text-xs font-semibold uppercase tracking-wide opacity-70">
          Today ({todayKey}) — this device
        </h2>
        {todayBucket === undefined ? (
          <p className="text-sm opacity-70">No outcomes recorded yet today.</p>
        ) : (
          <p className="text-sm">
            <span className="font-semibold">{todayBucket.distinctHidden.size}</span> distinct videos
            hidden · <span className="font-semibold">{todayBucket.distinctWarned.size}</span>{' '}
            distinct videos warned
          </p>
        )}
        <details className="mt-1 text-xs opacity-70">
          <summary>Why these numbers</summary>
          <p className="mt-1">
            Counts are distinct videos seen today (a video repeated on this page or across tabs
            counts once). They are not lifetime totals, do not include ads, and do not claim any
            video is definitely AI.
          </p>
        </details>
      </section>

      <section className="mt-3" aria-label="Quick category controls">
        <h2 className="mb-1 text-xs font-semibold uppercase tracking-wide opacity-70">
          Quick controls
        </h2>
        {QUICK_CATEGORIES.map((category) => {
          const action = settings.categoryActions[category];
          const effective: CategoryAction = action === 'inherit' ? 'allow' : action;
          return (
            <div key={category} className="flex items-center justify-between py-1">
              <label htmlFor={`qc-${category}`} className="text-sm">
                {CATEGORY_LABELS[category]}
              </label>
              <select
                id={`qc-${category}`}
                value={effective}
                onChange={(event) =>
                  void save({
                    categoryActions: {
                      ...settings.categoryActions,
                      [category]: event.currentTarget.value as CategoryAction,
                    },
                  })
                }
                className="rounded border border-black/20 bg-transparent px-1 py-0.5 text-sm dark:border-white/30"
              >
                {ACTION_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </div>
          );
        })}
      </section>

      {tabHides.length > 0 && (
        <section
          className="mt-3 border-t border-black/10 pt-2 dark:border-white/10"
          aria-label="Session recovery"
        >
          <h2 className="mb-1 text-xs font-semibold uppercase tracking-wide opacity-70">
            Hidden on this page ({tabHides.length})
          </h2>
          <div className="max-h-36 space-y-1 overflow-y-auto">
            {tabHides.map((item) => (
              <div key={item.id} className="flex items-center justify-between gap-2 py-1 text-xs">
                <span className="flex-1 truncate font-medium">
                  {item.title || item.videoId || 'Hidden video'}
                </span>
                <Button
                  onClick={async () => {
                    try {
                      const tabs = await browser.tabs.query({
                        active: true,
                        currentWindow: true,
                      });
                      const activeTab = tabs[0];
                      if (activeTab?.id) {
                        await browser.tabs.sendMessage(activeTab.id, {
                          type: 'session:restore',
                          payload: { id: item.id },
                        });
                        void loadTabHides();
                      }
                    } catch {
                      // Tab unavailable.
                    }
                  }}
                  aria-label={`Restore ${item.title}`}
                >
                  Restore
                </Button>
              </div>
            ))}
          </div>
        </section>
      )}

      <nav className="mt-4 flex gap-2" aria-label="Open pages">
        <Button
          variant="primary"
          onClick={() =>
            void browser.tabs.create({ url: `${browser.runtime.getURL('/options.html')}#review` })
          }
        >
          Review hidden content
        </Button>
        <Button
          onClick={() => void browser.tabs.create({ url: browser.runtime.getURL('/options.html') })}
        >
          Settings
        </Button>
      </nav>

      <details className="mt-3 text-xs opacity-70">
        <summary className="cursor-pointer">
          {EVIDENCE_CATEGORIES.length} categories · heuristics are imperfect · every hidden item can
          be restored
        </summary>
        <p className="mt-1">
          BlockTheSlop works entirely on your device. No history is uploaded, and no account is
          needed. It filters visible-text evidence on youtube.com only.
        </p>
      </details>
    </div>
  );
}
