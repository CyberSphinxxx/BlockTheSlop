import { useCallback, useEffect, useState } from 'react';
import type { EvidenceCategory } from '@/domain/evidence';
import type { CategoryAction, FilterMode, UserSettings } from '@/domain/settings';
import { validateSettings } from '@/domain/settings';
import type { DailyStatsState } from '@/domain/stats-daily';
import { dayBucketFor } from '@/domain/stats-daily';
import type { LocalStats } from '@/domain/stats';
import { SegmentedControl } from '@/ui/components/primitives';
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
  const [localStats, setLocalStats] = useState<LocalStats | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tabStatus, setTabStatus] = useState<TabStatus>({ kind: 'checking' });
  // The local day is computed ONCE per popup mount (stable across re-renders).
  const [todayKey] = useState(() => dayBucketFor(Date.now()));
  const [tabHides, setTabHides] = useState<Array<{ id: string; title?: string; videoId?: string }>>(
    [],
  );

  const refresh = useCallback(async () => {
    try {
      const [s, d, ls] = await Promise.all([
        backend.getSettings(),
        backend.getDailyStats(),
        backend.getStats(),
      ]);
      setSettings(s);
      setDaily(d);
      setLocalStats(ls);
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
      setSettings(optimistic);
      try {
        await backend.saveSettings(patch);
        setError(null);
      } catch {
        setSettings(previous);
        setError('Saving failed — the change was not applied. Please try again.');
      }
    },
    [backend, settings],
  );

  if (error !== null && settings === null) {
    return (
      <div className="btsl-popup" role="alert">
        <div className="btsl-stripe"></div>
        <div className="btsl-popup__body">
          <div className="btsl-panel" style={{ color: 'var(--color-danger)' }}>
            <h2 className="btsl-h" style={{ fontSize: '18px' }}>
              BlockTheSlop could not load its settings.
            </h2>
            <p className="btsl-help">{error}</p>
            <p className="btsl-help">YouTube filtering is unaffected by this error.</p>
          </div>
        </div>
      </div>
    );
  }

  if (settings === null) {
    return (
      <div className="btsl-popup" aria-busy="true">
        <div className="btsl-stripe"></div>
        <div className="btsl-popup__body">
          <div className="btsl-panel btsl-help">Loading…</div>
        </div>
      </div>
    );
  }

  const loadError = error;
  const todayBucket = daily?.days[todayKey];
  const statsNote = !settings.collectLocalStats
    ? 'Statistics are turned off in Settings — outcomes are not being collected.'
    : null;

  const distinctHiddenCount = todayBucket ? todayBucket.distinctHidden.size : 0;
  const distinctWarnedCount = todayBucket ? todayBucket.distinctWarned.size : 0;

  return (
    <div className="btsl-popup">
      <div className="btsl-stripe"></div>
      <div className="btsl-popup__body">
        {loadError !== null && (
          <div
            role="alert"
            className="btsl-notice"
            style={{ color: 'var(--color-danger)', borderColor: 'var(--color-danger)' }}
          >
            {loadError}
          </div>
        )}

        <header className="btsl-bar">
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <img
              src={browser.runtime.getURL('/icon/32.png')}
              alt=""
              width={20}
              height={20}
              style={{ borderRadius: '4px', display: 'block' }}
            />
            <h1 className="btsl-wordmark" style={{ margin: 0 }}>
              BlockTheSlop
            </h1>
          </div>
          <SegmentedControl<'on' | 'off'>
            legend=""
            name="enabled"
            autoWidth
            value={settings.enabled ? 'on' : 'off'}
            onChange={(v) => void save({ enabled: v === 'on' })}
            options={[
              { value: 'on', label: 'On' },
              { value: 'off', label: 'Off' },
            ]}
          />
        </header>

        {/* Stats card */}
        <section className="btsl-panel btsl-stat" role="region" aria-label="Outcomes today">
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 'var(--sp-2)' }}>
            <strong style={{ fontSize: '28px', lineHeight: 1, fontWeight: 'var(--fw-strong)' }}>
              {localStats?.hidden ?? (todayBucket ? todayBucket.hides : 0)}
            </strong>
            <span
              style={{
                fontSize: '18px',
                fontWeight: 'var(--fw-strong)',
                color: 'var(--color-text)',
              }}
            >
              videos blocked
            </span>
          </div>
          <div
            className="btsl-help"
            style={{
              marginTop: '2px',
              fontSize: '13px',
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            }}
          >
            {statsNote ??
              (distinctWarnedCount > 0
                ? `${distinctHiddenCount} distinct videos hidden · ${distinctWarnedCount} warned on this device`
                : `${distinctHiddenCount} distinct videos hidden on this device`)}
          </div>
        </section>

        {/* Mode selector */}
        <SegmentedControl<FilterMode>
          legend=""
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

        {/* Category controls */}
        <section
          className="btsl-panel"
          style={{ paddingTop: '4px', paddingBottom: '4px' }}
          role="region"
          aria-label="Quick category controls"
        >
          <span
            style={{
              position: 'absolute',
              width: '1px',
              height: '1px',
              padding: 0,
              margin: '-1px',
              overflow: 'hidden',
              clip: 'rect(0, 0, 0, 0)',
              whiteSpace: 'nowrap',
              border: 0,
            }}
          >
            Quick controls
          </span>
          {QUICK_CATEGORIES.map((category) => {
            const action = settings.categoryActions[category];
            const effective: CategoryAction = action === 'inherit' ? 'allow' : action;
            return (
              <div key={category} className="btsl-row btsl-row--cat">
                <label htmlFor={`qc-${category}`}>{CATEGORY_LABELS[category]}</label>
                <span className="btsl-select">
                  <select
                    id={`qc-${category}`}
                    aria-label={CATEGORY_LABELS[category]}
                    value={effective}
                    onChange={(event) =>
                      void save({
                        categoryActions: {
                          ...settings.categoryActions,
                          [category]: event.currentTarget.value as CategoryAction,
                        },
                      })
                    }
                  >
                    {ACTION_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </span>
              </div>
            );
          })}
        </section>

        {/* Notice / Session recovery banner */}
        {tabHides[0] ? (
          <div
            className="btsl-notice btsl-bar"
            role="region"
            aria-label="Session recovery"
            style={{ padding: '4px 8px' }}
          >
            <span
              style={{
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                maxWidth: '200px',
              }}
            >
              {tabHides[0]?.title || tabHides[0]?.videoId || 'Hidden video'}
            </span>
            <button
              type="button"
              className="btsl-link"
              onClick={async () => {
                const item = tabHides[0];
                if (!item) return;
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
              aria-label={`Restore ${tabHides[0]?.title || tabHides[0]?.videoId || 'Hidden video'}`}
            >
              Restore
            </button>
          </div>
        ) : tabStatus.kind === 'unavailable' ? (
          <div
            className="btsl-notice"
            role="status"
            aria-label="Active tab status"
            style={{ padding: '4px 8px' }}
          >
            <span className="btsl-help" style={{ fontSize: '13px' }}>
              Not available here · youtube.com only
            </span>
          </div>
        ) : tabStatus.kind === 'active' ? (
          <div
            className="btsl-notice btsl-bar"
            role="status"
            aria-label="Active tab status"
            style={{ padding: '4px 8px' }}
          >
            <span>Active on YouTube · {tabStatus.surface}</span>
            <span className="btsl-help">{tabStatus.distinctHidden} on page</span>
          </div>
        ) : null}

        {/* Action buttons */}
        <nav style={{ display: 'flex', gap: 'var(--sp-2)' }} aria-label="Open pages">
          <button
            type="button"
            className="btsl-btn btsl-btn--primary"
            style={{ flex: 2 }}
            onClick={() =>
              void browser.tabs.create({
                url: `${browser.runtime.getURL('/options.html')}#review`,
              })
            }
          >
            Review hidden
          </button>
          <button
            type="button"
            className="btsl-btn"
            style={{ flex: 1 }}
            onClick={() =>
              void browser.tabs.create({ url: browser.runtime.getURL('/options.html') })
            }
          >
            Settings
          </button>
        </nav>
      </div>
    </div>
  );
}
