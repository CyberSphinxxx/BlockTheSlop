import { useCallback, useEffect, useRef, useState } from 'react';
import type { EvidenceCategory } from '@/domain/evidence';
import { EVIDENCE_CATEGORIES } from '@/domain/evidence';
import type {
  CategoryAction,
  Density,
  DisplayMode,
  FilterMode,
  ProcessingPreset,
  Theme,
  ActivityIndicatorPosition,
  UserSettings,
} from '@/domain/settings';
import {
  HISTORY_RETENTION_MAX_DAYS,
  HISTORY_RETENTION_MIN_DAYS,
  SETTINGS_SCHEMA_VERSION,
  SUPPORTED_SURFACES,
  defaultSettings,
  validateSettings,
} from '@/domain/settings';
import { applyRuleMutation, validateRules, type UserRules } from '@/domain/rules';
import { RuleStore } from '@/storage/rule-store';
import { AutoChannelStore } from '@/storage/auto-channel-store';
import type { AutoChannelState } from '@/domain/auto-channel';
import { BrowserKVStore } from '@/storage/db';
import type { ReviewRecord } from '@/domain/review';
import type { ReviewSummary, ReviewEvent, QuarantineItem } from '@/domain/history';
import { videoKey as durableVideoKey } from '@/domain/history';
import type { ImportOutcome } from '@/import-export/schema';
import type { HistoryQuery, HistoryQueryResult } from '@/storage/history-repository';
import { defaultStats, type LocalStats } from '@/domain/stats';
import { buildExport, parseImport, ImportRejectedError } from '@/import-export/schema';
import { applyThemeToDocument } from '@/ui/theme';
import { StatsTab } from './StatsTab';
import { MissReviewSection } from './MissReviewSection';
import { CompetitorImportSection } from './CompetitorImportSection';
import { PhraseEditor } from './PhraseEditor';
import { formatDecisionReason } from '@/presentation/activity';

/**
 * Map an imported legacy review record to a durable summary. Deterministic
 * session key for video-less rows keeps re-imports idempotent (same op id).
 */
function legacyRecordToSummary(record: ReviewRecord): ReviewSummary {
  const key = durableVideoKey(record.videoId, `imp-${record.id}`);
  return {
    key,
    videoId: record.videoId,
    title: record.title,
    channelId: record.channelId,
    channelName: record.channelName,
    handle: undefined,
    surfaces: [record.surface],
    latestDecision: record.decision,
    resolution: record.restoredAt !== undefined ? 'restored' : 'pending',
    firstSeen: record.createdAt,
    lastSeen: record.restoredAt ?? record.createdAt,
    count: 1,
    evidenceSummary: record.decision.explanation.join(' · '),
    revision: 1,
  };
}
import {
  Button,
  ConfirmDialog,
  Section,
  SegmentedControl,
  Toggle,
} from '@/ui/components/primitives';
import type { Backend } from '@/ui/messaging';

type Tab =
  | 'general'
  | 'filtering'
  | 'categories'
  | 'allowed'
  | 'blocked'
  | 'review'
  | 'stats'
  | 'data'
  | 'privacy'
  | 'about';

const TABS: readonly { id: Tab; label: string }[] = [
  { id: 'general', label: 'General' },
  { id: 'filtering', label: 'Filtering' },
  { id: 'categories', label: 'Categories' },
  { id: 'allowed', label: 'Allowed content' },
  { id: 'blocked', label: 'Blocked content' },
  { id: 'review', label: 'Review history' },
  { id: 'stats', label: 'Statistics' },
  { id: 'data', label: 'Import/export' },
  { id: 'privacy', label: 'Privacy' },
  { id: 'about', label: 'About' },
];

const CATEGORY_LABELS: Record<EvidenceCategory, string> = {
  'ai-visual': 'AI-generated video',
  'ai-voice': 'AI voice / TTS',
  'ai-script': 'AI-written script likelihood',
  'ai-music': 'AI music',
  'ai-thumbnail': 'AI thumbnail',
  'ai-unspecified': 'AI-generated (type unspecified)',
  deepfake: 'Synthetic / deepfake person',
  'content-farm': 'Automated content farms',
  repetitive: 'Repetitive compilations',
  clickbait: 'Clickbait / misleading packaging',
  'ai-discussion': 'AI discussion / news / tutorials',
  'creator-disclosure': 'Creator disclosure',
};

const ACTION_LABELS: Record<CategoryAction, string> = {
  allow: 'Allow',
  warn: 'Warn',
  hide: 'Hide',
  inherit: 'Use mode default',
};

const SURFACE_LABELS: Partial<Record<string, string>> = {
  home: 'Home',
  search: 'Search',
  subscriptions: 'Subscriptions',
  'watch-sidebar': 'Watch sidebar',
  channel: 'Channel pages',
  playlist: 'Playlists',
  history: 'History page',
  'watch-later': 'Watch later',
  'shorts-shelf': 'Shorts shelf',
  'shorts-feed': 'Shorts feed',
};

export function OptionsApp({ backend }: { backend: Backend }) {
  const [tab, setTab] = useState<Tab>('general');
  const [settings, setSettings] = useState<UserSettings | null>(null);
  const [rules, setRules] = useState<UserRules | null>(null);
  const [review, setReview] = useState<ReviewRecord[]>([]);
  const [stats, setStats] = useState<LocalStats | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  /** N04 blocker-5: honest save state — never claim saved before it is. */
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');

  const refresh = useCallback(async () => {
    const [s, r, rv, st] = await Promise.all([
      backend.getSettings(),
      backend.getRules(),
      backend.getReview(),
      backend.getStats(),
    ]);
    setSettings(s);
    setRules(r);
    setReview(rv);
    setStats(st);
  }, [backend]);

  useEffect(() => {
    // Deferred so state updates never happen synchronously in the effect.
    void Promise.resolve().then(() =>
      refresh().catch((e: unknown) => setNotice(e instanceof Error ? e.message : String(e))),
    );
  }, [refresh]);

  // N15/CFG-10: the theme setting must have a real, immediate visible effect
  // on this page (and follow the OS while 'system' is selected).
  // The effect re-runs ONLY when the theme value changes (not on any other
  // settings mutation); `theme` is a stable primitive so exhaustive-deps is
  // satisfied without re-applying the theme on unrelated saves.
  const theme = settings === null ? undefined : settings.theme;
  useEffect(() => {
    if (theme === undefined) return;
    return applyThemeToDocument(document, theme);
  }, [theme]);

  const saveSettings = useCallback(
    async (next: UserSettings) => {
      const validated = validateSettings(next);
      if (validated === null) return;
      const previous = settings;
      // Optimistic update (responsiveness), but NEVER without rollback: if
      // persistence fails the shown state must return to the last persisted
      // value, and the failure must be VISIBLE (N01/N05 blocker-5).
      setSettings(validated);
      setSaveState('saving');
      // CFG-03: send only the fields THIS surface changed — a concurrent
      // popup edit must survive because untouched fields are not in the patch.
      const patch: Partial<UserSettings> = {};
      if (previous !== null) {
        for (const key of Object.keys(validated) as (keyof UserSettings)[]) {
          if (JSON.stringify(validated[key]) !== JSON.stringify(previous[key])) {
            (patch as Record<string, unknown>)[key] = validated[key];
          }
        }
      } else {
        Object.assign(patch, validated);
      }
      try {
        await backend.saveSettings(patch);
        setSaveState('saved');
      } catch (error) {
        if (previous !== null) setSettings(previous); // rollback
        setSaveState('error');
        setNotice(
          `Saving failed: ${error instanceof Error ? error.message : String(error)}. Your change was not kept.`,
        );
      }
    },
    [backend, settings],
  );

  const saveRules = useCallback(
    async (next: UserRules): Promise<boolean> => {
      const validated = validateRules(next);
      if (validated === null) return false;
      const previous = rules;
      setRules(validated);
      setSaveState('saving');
      try {
        const store = new RuleStore(new BrowserKVStore());
        await store.save(validated);
        setSaveState('saved');
        return true;
      } catch (error) {
        if (previous !== null) setRules(previous); // rollback
        setSaveState('error');
        setNotice(
          `Saving failed: ${error instanceof Error ? error.message : String(error)}. Your change was not kept.`,
        );
        return false;
      }
    },
    [rules],
  );

  if (settings === null || rules === null || stats === null) {
    return (
      <div className="p-6 text-sm opacity-70" aria-busy="true">
        Loading settings…
      </div>
    );
  }

  return (
    <div className="mx-auto flex min-h-screen max-w-4xl gap-6 p-6">
      <nav aria-label="Settings sections" className="w-48 shrink-0">
        <h1 className="mb-3 text-lg font-bold">BlockTheSlop</h1>
        {/* N04 blocker-5: honest, visible save state with rollback on failure. */}
        <p
          aria-live="polite"
          data-testid="save-status"
          className={`mb-2 text-xs ${saveState === 'error' ? 'text-red-600' : 'opacity-60'}`}
        >
          {saveState === 'saving' && 'Saving…'}
          {saveState === 'saved' && 'All changes saved'}
          {saveState === 'error' && 'Save failed — change reverted'}
        </p>
        <ul className="space-y-1">
          {TABS.map((t) => (
            <li key={t.id}>
              <button
                type="button"
                onClick={() => setTab(t.id)}
                aria-current={tab === t.id ? 'page' : undefined}
                className={`w-full rounded px-3 py-1.5 text-left text-sm ${
                  tab === t.id
                    ? 'bg-slate-800 text-white dark:bg-slate-200 dark:text-slate-900'
                    : 'hover:bg-black/5 dark:hover:bg-white/10'
                }`}
              >
                {t.label}
              </button>
            </li>
          ))}
        </ul>
      </nav>

      <main className="min-w-0 flex-1">
        {notice !== null && (
          <p role="status" className="mb-3 rounded bg-amber-100 px-3 py-2 text-sm">
            {notice}
          </p>
        )}

        {tab === 'general' && (
          <>
            <Section title="Enable">
              <Toggle
                id="opt-enabled"
                label="Filtering enabled"
                description="When off, nothing on YouTube is touched."
                checked={settings.enabled}
                onChange={(enabled) => void saveSettings({ ...settings, enabled })}
              />
              <div className="pt-1">
                <Button
                  onClick={() =>
                    void browser.tabs.create({
                      url: browser.runtime.getURL('/onboarding.html'),
                    })
                  }
                >
                  Reopen setup
                </Button>
                <p className="mt-1 text-xs opacity-70">
                  Replays the first-install introduction. It never changes your settings on its own
                  — only an explicit Apply inside setup does.
                </p>
              </div>
            </Section>
            <Section title="Statistics">
              <Toggle
                id="opt-stats"
                label="Collect local statistics"
                description="Stored on this device only. Never uploaded."
                checked={settings.collectLocalStats}
                onChange={(collectLocalStats) =>
                  void saveSettings({ ...settings, collectLocalStats })
                }
              />
              <p className="text-sm opacity-70">
                {stats.cardsEvaluated} cards evaluated · {stats.hidden} hidden · {stats.restored}{' '}
                restored · {stats.falsePositiveCorrections} corrections
              </p>
            </Section>
            <Section title="Review history">
              <Toggle
                id="opt-history"
                label="Keep review history on this device"
                description="When off, hidden videos are not persisted — recovery works only for the current page, and the Review tab cannot list past hides."
                checked={settings.history.enabled}
                onChange={(enabled) =>
                  void saveSettings({ ...settings, history: { ...settings.history, enabled } })
                }
              />
              {settings.history.enabled && (
                <label className="mt-2 flex items-center gap-2 text-sm">
                  Delete history older than
                  <input
                    type="number"
                    min={HISTORY_RETENTION_MIN_DAYS}
                    max={HISTORY_RETENTION_MAX_DAYS}
                    value={settings.history.retentionDays}
                    onChange={(e) => {
                      const parsed = Number(e.currentTarget.value);
                      if (!Number.isFinite(parsed)) return;
                      const retentionDays = Math.min(
                        HISTORY_RETENTION_MAX_DAYS,
                        Math.max(HISTORY_RETENTION_MIN_DAYS, Math.round(parsed)),
                      );
                      void saveSettings({
                        ...settings,
                        history: { ...settings.history, retentionDays },
                      });
                    }}
                    aria-label="History retention in days"
                    className="w-20 rounded border border-black/20 px-2 py-1 text-sm"
                  />
                  days
                </label>
              )}
            </Section>
            <Section title="Appearance">
              <SegmentedControl<DisplayMode>
                legend="Hidden card presentation"
                name="opt-display-mode"
                value={settings.displayMode}
                onChange={(displayMode) => void saveSettings({ ...settings, displayMode })}
                options={[
                  {
                    value: 'collapse',
                    label: 'Collapse',
                    hint: 'Removes the video card from layout completely — no blank space or placeholder',
                  },
                  {
                    value: 'placeholder',
                    label: 'Placeholder',
                    hint: 'Keeps a styled replacement card in place with inline controls',
                  },
                ]}
              />
              <div className="mt-3">
                <SegmentedControl<Density>
                  legend="Placeholder density"
                  name="opt-density"
                  value={settings.density}
                  onChange={(density) => void saveSettings({ ...settings, density })}
                  options={[
                    { value: 'comfortable', label: 'Comfortable' },
                    { value: 'compact', label: 'Compact' },
                  ]}
                />
              </div>
              <div className="mt-2">
                <label className="flex items-center gap-2 text-sm">
                  Color scheme
                  <select
                    aria-label="Color scheme"
                    value={settings.theme}
                    onChange={(e) =>
                      void saveSettings({ ...settings, theme: e.currentTarget.value as Theme })
                    }
                    className="rounded border border-black/20 px-2 py-1 text-sm"
                  >
                    <option value="system">Follow system</option>
                    <option value="light">Light</option>
                    <option value="dark">Dark</option>
                  </select>
                </label>
              </div>
              <div className="mt-2">
                <label className="flex items-center gap-2 text-sm">
                  On-page activity chip
                  <select
                    aria-label="On-page activity chip position"
                    value={settings.activityIndicator.position}
                    onChange={(e) =>
                      void saveSettings({
                        ...settings,
                        activityIndicator: {
                          position: e.currentTarget.value as ActivityIndicatorPosition,
                        },
                      })
                    }
                    className="rounded border border-black/20 px-2 py-1 text-sm"
                  >
                    <option value="off">Off (no chip on the page)</option>
                    <option value="top-left">Top left</option>
                    <option value="top-right">Top right</option>
                    <option value="bottom-left">Bottom left</option>
                    <option value="bottom-right">Bottom right (default)</option>
                  </select>
                </label>
                <p className="mt-1 text-xs opacity-70">
                  Shows how many distinct videos are hidden on the current page, with quick restore.
                  Off removes it entirely — the popup and Review tab still list hidden items.
                  Corners are placed to avoid YouTube's own controls.
                </p>
              </div>
            </Section>
            <Section title="Automatic Channel Blocking (Opt-in)">
              <Toggle
                id="opt-autochannel"
                label="Automatically block channels with repeated AI-generated videos"
                description="Default is OFF (suggestions only). When enabled, automatically blocks channels with at least 3 distinct high-confidence AI-generated videos across visits (requires canonical UC... channel ID and strong video evidence; max 5 promotions per day; 30-day expiry; strictly local-only). Explicit user rules never expire."
                checked={settings.autoChannel.enabled}
                onChange={(enabled) =>
                  void saveSettings({
                    ...settings,
                    autoChannel: { ...settings.autoChannel, enabled },
                  })
                }
              />
            </Section>
            <Section title="Privacy & System Architecture Disclosures">
              <div className="space-y-3 text-xs leading-relaxed opacity-85">
                <div>
                  <h4 className="font-semibold text-slate-800 dark:text-slate-200">
                    Verdict Memory (Tier 2 Fast-Path)
                  </h4>
                  <p>
                    Temporarily caches recent classification verdicts with a 24-hour time-to-live
                    (TTL) and a 10,000-entry LRU cap. Allows remembered repeated videos to collapse
                    quickly without layout flash, while avoiding permanent false positives. Any
                    changes to settings, rule packs, or user Not AI / Not slop corrections
                    immediately invalidate relevant cached entries.
                  </p>
                </div>
                <div>
                  <h4 className="font-semibold text-slate-800 dark:text-slate-200">
                    Automatic Channel Threshold
                  </h4>
                  <p>
                    Requires a verified canonical channel ID (UC...), at least 3 distinct qualifying
                    videos with strong video-production AI evidence (likelihood ≥ 70%), and is
                    capped at 5 promotions per day. Suggested channels require user confirmation
                    unless automatic blocking is explicitly enabled.
                  </p>
                </div>
                <div>
                  <h4 className="font-semibold text-slate-800 dark:text-slate-200">
                    False-Positive Cost &amp; One-Click Demotion
                  </h4>
                  <p>
                    Heuristic classification has a non-zero false-positive rate. Automatic blocks
                    expire after 30 days and are demoted immediately if any associated video is
                    marked as Not AI or added to the Allowlist. All hides remain one-click
                    recoverable via the corner notice, popup session recovery, or the Review tab.
                  </p>
                </div>
                <div>
                  <h4 className="font-semibold text-slate-800 dark:text-slate-200">
                    Local-First &amp; Offline Privacy
                  </h4>
                  <p>
                    BlockTheSlop runs 100% locally in your browser. No accounts, no backend server,
                    no cloud AI, no telemetry, and no background network requests. All rules,
                    history, and statistics are stored locally on your device.
                  </p>
                </div>
              </div>
            </Section>
          </>
        )}

        {tab === 'filtering' && (
          <>
            <Section title="Mode">
              <SegmentedControl<FilterMode>
                legend="Filtering mode"
                name="opt-mode"
                value={settings.mode}
                onChange={(mode) => void saveSettings({ ...settings, mode })}
                options={[
                  { value: 'safe', label: 'Safe', hint: 'Hide only very high-confidence content' },
                  { value: 'balanced', label: 'Balanced', hint: 'Recommended default' },
                  { value: 'strict', label: 'Strict', hint: 'Higher false-positive risk' },
                  {
                    value: 'aggressive',
                    label: 'Aggressive',
                    hint: 'Maximum AI recall; accepts false positives',
                  },
                ]}
              />
              <p className="mt-2 text-xs opacity-70">
                Strict acts only on evidence the extension actually observed (labels, disclosures,
                text signals): hide thresholds drop from high to moderate confidence. It never hides
                a video for lacking metadata alone. Tradeoff: more false positives — every hide
                keeps one-click recovery on the card and in Review history. Aggressive goes further
                on observed evidence only: lower score floor and it admits low-confidence signals.
                Expect false positives; every one stays one-click recoverable. Category overrides,
                surface toggles, corrections and unknown-visibility rules apply in every mode.
                Detection ceiling: content with no observable signal in its card metadata
                (undisclosed AI with a clean title, for example) stays visible in every mode —
                scores are heuristics, not proof, and missing metadata is never treated as evidence.
              </p>
            </Section>
            <Section title="Explanations">
              <Toggle
                id="opt-explanations"
                label="Show explanation placeholders on hidden cards"
                checked={settings.showExplanations}
                onChange={(showExplanations) =>
                  void saveSettings({ ...settings, showExplanations })
                }
              />
              <div className="mt-2">
                <SegmentedControl<DisplayMode>
                  legend="Hidden card presentation"
                  name="opt-display"
                  value={settings.displayMode}
                  onChange={(displayMode) => void saveSettings({ ...settings, displayMode })}
                  options={[
                    { value: 'placeholder', label: 'Placeholder', hint: 'Keep the layout slot' },
                    { value: 'collapse', label: 'Collapse', hint: 'Remove the slot entirely' },
                  ]}
                />
              </div>
            </Section>
            <Section title="Surfaces">
              <p className="mb-2 text-xs opacity-70">
                Choose which YouTube areas are filtered. Changes apply immediately.
              </p>
              <div className="grid grid-cols-2 gap-1">
                {SUPPORTED_SURFACES.map((s) => (
                  <Toggle
                    key={s}
                    id={`opt-surface-${s}`}
                    label={SURFACE_LABELS[s] ?? s}
                    checked={settings.surfaces[s]}
                    onChange={(on) =>
                      void saveSettings({
                        ...settings,
                        surfaces: { ...settings.surfaces, [s]: on },
                      })
                    }
                  />
                ))}
              </div>
            </Section>
            <Section title="Performance">
              <SegmentedControl<ProcessingPreset>
                legend="Processing preset"
                name="opt-performance"
                value={settings.performance.preset}
                onChange={(preset) => void saveSettings({ ...settings, performance: { preset } })}
                options={[
                  {
                    value: 'battery',
                    label: 'Battery',
                    hint: 'Slower, fewer cards per pass',
                  },
                  { value: 'balanced', label: 'Balanced', hint: 'Recommended' },
                  { value: 'quality', label: 'Quality', hint: 'Fastest processing' },
                ]}
              />
              <div className="mt-2">
                <Toggle
                  id="opt-rulepack-fil"
                  label="Filipino text rules"
                  description="Adds Filipino-language disclosure patterns to detection."
                  checked={settings.rulePacks.fil}
                  onChange={(fil) => void saveSettings({ ...settings, rulePacks: { fil } })}
                />
              </div>
            </Section>
            <Section title="Shorts guard">
              <Toggle
                id="opt-shorts-guard"
                label="Pause and cover matched Shorts while playing"
                description="Default off: Shorts shelf still filtered, active playback untouched."
                checked={settings.shortsGuard.enabled}
                onChange={(on) => void saveSettings({ ...settings, shortsGuard: { enabled: on } })}
              />
            </Section>
          </>
        )}

        {tab === 'categories' && (
          <Section title="Per-category actions">
            <table className="w-full text-sm">
              <caption className="sr-only">Per-category filtering actions</caption>
              <thead>
                <tr className="text-left opacity-70">
                  <th scope="col" className="py-1">
                    Category
                  </th>
                  <th scope="col">Action</th>
                </tr>
              </thead>
              <tbody>
                {EVIDENCE_CATEGORIES.map((category) => (
                  <tr key={category}>
                    <th scope="row" className="py-1 pr-2 text-left font-normal">
                      {CATEGORY_LABELS[category]}
                    </th>
                    <td>
                      <select
                        aria-label={`${CATEGORY_LABELS[category]} action`}
                        value={settings.categoryActions[category]}
                        onChange={(e) =>
                          void saveSettings({
                            ...settings,
                            categoryActions: {
                              ...settings.categoryActions,
                              [category]: e.currentTarget.value as CategoryAction,
                            },
                          })
                        }
                        className="block w-40 cursor-pointer rounded-md border border-black/20 bg-white px-2 py-1.5 text-sm shadow-sm focus-visible:border-slate-500 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-slate-600 dark:border-white/20 dark:bg-slate-800 dark:text-slate-100"
                      >
                        {(Object.keys(ACTION_LABELS) as CategoryAction[]).map((action) => (
                          <option key={action} value={action}>
                            {ACTION_LABELS[action]}
                          </option>
                        ))}
                      </select>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Section>
        )}

        {tab === 'allowed' && (
          <RuleListSection tab={tab} rules={rules} onChange={(next) => void saveRules(next)} />
        )}

        {tab === 'blocked' && (
          <>
            <RuleListSection tab={tab} rules={rules} onChange={(next) => void saveRules(next)} />
            <AutoChannelSection onChanged={() => void refresh()} />
          </>
        )}

        {tab === 'review' && (
          <>
            <ReviewSection records={review} onChanged={() => void refresh()} backend={backend} />
            <MissReviewSection backend={backend} />
          </>
        )}

        {tab === 'stats' && <StatsTab backend={backend} />}
        {tab === 'data' && (
          <>
            <DataSection
              settings={settings}
              rules={rules}
              review={review}
              stats={stats}
              onImported={() => void refresh()}
              setNotice={setNotice}
              backend={backend}
            />
            <CompetitorImportSection rules={rules} onApply={saveRules} />
          </>
        )}

        {tab === 'privacy' && (
          <>
            <Section title="YouTube feedback">
              <Toggle
                id="opt-ytfeedback"
                label='Also tell YouTube "Not interested" when hiding'
                description="OFF by default. When enabled, hiding a card also changes your YouTube recommendation data. BlockTheSlop filtering works identically either way."
                checked={settings.youtubeFeedback.enabled}
                disabled
                disabledReason="Not available in this build: no YouTube actions are performed. The control is disabled until the feature ships."
                onChange={(enabled) =>
                  void saveSettings({ ...settings, youtubeFeedback: { enabled } })
                }
              />
            </Section>
            <Section title="Community reputation">
              <Toggle
                id="opt-remote"
                label="Enable remote reputation provider (experimental)"
                description="OFF by default. If enabled, only video/channel IDs are sent over HTTPS to the endpoint you configure. Local filtering works without it."
                checked={settings.remoteProvider.enabled}
                disabled
                disabledReason="Not available in this build: no remote provider is used and nothing leaves your device. The control is disabled until the feature ships."
                onChange={(enabled) =>
                  void saveSettings({
                    ...settings,
                    remoteProvider: { ...settings.remoteProvider, enabled },
                  })
                }
              />
            </Section>
            <Section title="Data promise">
              <ul className="list-disc pl-5 text-sm opacity-80">
                <li>No analytics or telemetry.</li>
                <li>No watch/search history leaves your device.</li>
                <li>No page content is uploaded.</li>
                <li>No account, no API keys, works offline.</li>
              </ul>
            </Section>
          </>
        )}

        {tab === 'about' && (
          <Section title="About">
            <p className="text-sm">
              BlockTheSlop — AI Slop Blocker for YouTube. Heuristics, not oracles: every automatic
              decision is explainable and reversible. Detection is probabilistic; legitimate videos
              can be mislabeled, so use the review queue to correct mistakes.
            </p>
          </Section>
        )}
      </main>
    </div>
  );
}

function RuleListSection({
  tab,
  rules,
  onChange,
}: {
  tab: 'allowed' | 'blocked';
  rules: UserRules;
  onChange: (rules: UserRules) => void;
}) {
  const isAllowed = tab === 'allowed';
  const videoIds = isAllowed ? rules.allowedVideoIds : rules.blockedVideoIds;
  const channelIds = isAllowed ? rules.allowedChannelIds : rules.blockedChannelIds;
  const handles = isAllowed ? rules.fallbackAllowedHandles : rules.fallbackBlockedHandles;

  const removeVideo = (videoId: string) => {
    // Rebuild via opposite mutation so conflicts resolve consistently.
    onChange(
      isAllowed
        ? { ...rules, allowedVideoIds: rules.allowedVideoIds.filter((v) => v !== videoId) }
        : { ...rules, blockedVideoIds: rules.blockedVideoIds.filter((v) => v !== videoId) },
    );
  };
  const removeChannel = (channelId: string) => {
    const meta = { ...rules.channelRulesMeta };
    delete meta[channelId];
    onChange(
      isAllowed
        ? {
            ...rules,
            allowedChannelIds: rules.allowedChannelIds.filter((c) => c !== channelId),
            channelRulesMeta: meta,
          }
        : {
            ...rules,
            blockedChannelIds: rules.blockedChannelIds.filter((c) => c !== channelId),
            channelRulesMeta: meta,
          },
    );
  };
  const removeHandle = (handle: string) => {
    const meta = { ...rules.channelRulesMeta };
    delete meta[handle];
    onChange(
      isAllowed
        ? {
            ...rules,
            fallbackAllowedHandles: rules.fallbackAllowedHandles.filter((h) => h !== handle),
            channelRulesMeta: meta,
          }
        : {
            ...rules,
            fallbackBlockedHandles: rules.fallbackBlockedHandles.filter((h) => h !== handle),
            channelRulesMeta: meta,
          },
    );
  };

  return (
    <Section title={isAllowed ? 'Explicitly allowed' : 'Explicitly blocked'}>
      {videoIds.length === 0 && channelIds.length === 0 && handles.length === 0 && (
        <p className="text-sm opacity-70">
          {isAllowed ? 'Nothing allowed yet.' : 'No blocked channels.'}
        </p>
      )}
      {videoIds.length > 0 && (
        <>
          <h3 className="mt-2 text-xs font-semibold uppercase opacity-60">Videos</h3>
          <ul className="text-sm">
            {videoIds.map((id) => (
              <li
                key={id}
                className="flex items-center justify-between py-1 border-b border-black/5 dark:border-white/5"
              >
                <code className="text-xs">{id}</code>
                <Button onClick={() => removeVideo(id)}>Remove</Button>
              </li>
            ))}
          </ul>
        </>
      )}
      {channelIds.length > 0 && (
        <>
          <h3 className="mt-2 text-xs font-semibold uppercase opacity-60">Channels</h3>
          <ul className="text-sm">
            {channelIds.map((id) => {
              const meta = rules.channelRulesMeta?.[id];
              return (
                <li
                  key={id}
                  className="flex items-center justify-between py-1.5 border-b border-black/5 dark:border-white/5"
                >
                  <div className="flex flex-col">
                    <code className="text-xs font-semibold">{id}</code>
                    {meta && (
                      <span className="text-[11px] opacity-60">
                        {meta.source === 'context-menu' && 'Right-click menu'}
                        {meta.source === 'channel-page' && 'Channel page'}
                        {meta.source === 'review' && 'Review queue'}
                        {meta.source === 'manual' && 'Manual setting'}
                        {meta.reason ? ` • ${meta.reason}` : ''}
                        {meta.addedAt ? ` • ${new Date(meta.addedAt).toLocaleDateString()}` : ''}
                      </span>
                    )}
                  </div>
                  <Button onClick={() => removeChannel(id)}>Undo / Remove</Button>
                </li>
              );
            })}
          </ul>
        </>
      )}
      {handles.length > 0 && (
        <>
          <h3 className="mt-2 text-xs font-semibold uppercase opacity-60">Handles (fallback)</h3>
          <ul className="text-sm">
            {handles.map((h) => {
              const meta = rules.channelRulesMeta?.[h];
              return (
                <li
                  key={h}
                  className="flex items-center justify-between py-1.5 border-b border-black/5 dark:border-white/5"
                >
                  <div className="flex flex-col">
                    <code className="text-xs font-semibold">@{h}</code>
                    {meta && (
                      <span className="text-[11px] opacity-60">
                        {meta.source === 'context-menu' && 'Right-click menu'}
                        {meta.source === 'channel-page' && 'Channel page'}
                        {meta.source === 'review' && 'Review queue'}
                        {meta.source === 'manual' && 'Manual setting'}
                        {meta.reason ? ` • ${meta.reason}` : ''}
                        {meta.addedAt ? ` • ${new Date(meta.addedAt).toLocaleDateString()}` : ''}
                      </span>
                    )}
                  </div>
                  <Button onClick={() => removeHandle(h)}>Undo / Remove</Button>
                </li>
              );
            })}
          </ul>
        </>
      )}
      {!isAllowed && (
        <PhraseEditor
          phrases={rules.blockedPhrases}
          phraseRules={rules.blockedPhraseRules}
          onAdd={(phrase, wholeWord) =>
            onChange(
              applyRuleMutation(rules, {
                kind: 'block-phrase',
                phrase,
                ...(wholeWord ? { wholeWord: true } : {}),
              }),
            )
          }
          onRemove={(phrase) =>
            onChange(applyRuleMutation(rules, { kind: 'unblock-phrase', phrase }))
          }
        />
      )}
    </Section>
  );
}

/** V5-08: Opt-in automatic channel blocks and suggestions section. */
function AutoChannelSection({ onChanged }: { onChanged?: () => void }) {
  const [state, setState] = useState<AutoChannelState | null>(null);
  const [loading, setLoading] = useState(true);
  const [now] = useState(() => Date.now());

  const refresh = useCallback(() => {
    const store = new AutoChannelStore(new BrowserKVStore());
    store
      .load()
      .then((s) => {
        setState(s);
        setLoading(false);
      })
      .catch(() => {
        setLoading(false);
      });
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const handleRevoke = async (channelId: string) => {
    const store = new AutoChannelStore(new BrowserKVStore());
    await store.revoke(channelId);
    refresh();
    onChanged?.();
  };

  const handlePromote = async (channelId: string) => {
    const store = new AutoChannelStore(new BrowserKVStore());
    await store.promoteSuggestion(channelId);
    refresh();
    onChanged?.();
  };

  if (loading || !state) return null;

  const entries = Object.values(state.entries);
  const activeEntries = entries.filter((e) => e.status === 'active' && e.expiresAt > now);
  const suggestedEntries = entries.filter((e) => e.status === 'suggested');

  return (
    <Section title="Automatic Channel Blocks (Opt-in)">
      <p className="mb-3 text-xs opacity-70">
        Separately labeled, expiring blocks triggered by multiple distinct videos with strong
        video-production AI evidence across visits. Explicit user blocks never expire.
      </p>

      {activeEntries.length === 0 && suggestedEntries.length === 0 && (
        <p className="text-sm opacity-70">No automatic channel blocks or suggestions recorded.</p>
      )}

      {activeEntries.length > 0 && (
        <>
          <h3 className="mt-2 text-xs font-semibold uppercase text-amber-500">
            Active Auto-Blocks
          </h3>
          <ul className="mt-1 space-y-2 text-sm">
            {activeEntries.map((e) => {
              const daysLeft = Math.max(0, Math.ceil((e.expiresAt - now) / (24 * 60 * 60 * 1000)));
              return (
                <li
                  key={e.channelId}
                  className="flex items-center justify-between rounded bg-black/5 p-2 dark:bg-white/5"
                >
                  <div className="flex flex-col">
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-semibold">{e.displayName || e.channelId}</span>
                      <span className="rounded bg-amber-500/20 px-1.5 py-0.5 text-[10px] font-medium text-amber-500">
                        Auto-blocked
                      </span>
                      {e.handle && (
                        <span className="text-[11px] opacity-60">
                          @{e.handle.replace(/^@/, '')}
                        </span>
                      )}
                    </div>
                    <span className="mt-0.5 text-[11px] opacity-60">
                      {e.reason || `${e.qualifyingVideoIds.length} qualifying videos`} • Expires in{' '}
                      {daysLeft} days
                    </span>
                    <span className="text-[10px] opacity-40">
                      Triggering IDs: {e.qualifyingVideoIds.join(', ')}
                    </span>
                  </div>
                  <Button onClick={() => void handleRevoke(e.channelId)}>Undo / Revoke</Button>
                </li>
              );
            })}
          </ul>
        </>
      )}

      {suggestedEntries.length > 0 && (
        <>
          <h3 className="mt-4 text-xs font-semibold uppercase text-blue-400">Suggestions</h3>
          <ul className="mt-1 space-y-2 text-sm">
            {suggestedEntries.map((e) => (
              <li
                key={e.channelId}
                className="flex items-center justify-between rounded bg-black/5 p-2 dark:bg-white/5"
              >
                <div className="flex flex-col">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-semibold">{e.displayName || e.channelId}</span>
                    <span className="rounded bg-blue-500/20 px-1.5 py-0.5 text-[10px] font-medium text-blue-400">
                      Suggested
                    </span>
                    {e.handle && (
                      <span className="text-[11px] opacity-60">@{e.handle.replace(/^@/, '')}</span>
                    )}
                  </div>
                  <span className="mt-0.5 text-[11px] opacity-60">
                    {e.qualifyingVideoIds.length} qualifying AI videos detected across visits
                  </span>
                </div>
                <div className="flex gap-2">
                  <Button variant="primary" onClick={() => void handlePromote(e.channelId)}>
                    Block Channel
                  </Button>
                  <Button onClick={() => void handleRevoke(e.channelId)}>Dismiss</Button>
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
    </Section>
  );
}

/** Valid page sizes (HIS-02); anything else falls back to 25. */
const PAGE_SIZES = [10, 25, 50, 100];

/** Local-midnight epoch helpers (HIS-20): constructed in LOCAL time so DST
 * boundaries include/exclude the intended calendar days. */
function dayStart(dateText: string): number | undefined {
  if (dateText === '') return undefined;
  const [y, m, d] = dateText.split('-').map(Number);
  if (y === undefined || m === undefined || d === undefined) return undefined;
  return new Date(y, m - 1, d).getTime();
}

function dayEnd(dateText: string): number | undefined {
  if (dateText === '') return undefined;
  const [y, m, d] = dateText.split('-').map(Number);
  if (y === undefined || m === undefined || d === undefined) return undefined;
  return new Date(y, m - 1, d + 1).getTime() - 1;
}

function ReviewSection({
  records,
  onChanged,
  backend,
}: {
  records: ReviewRecord[];
  onChanged: () => void;
  backend: Backend;
}) {
  // ---- query state (R19/R20) ----
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<'all' | 'pending' | 'restored' | 'corrected' | 'allowed'>(
    'all',
  );
  const [surface, setSurface] = useState<string>('all');
  const [sort, setSort] = useState<NonNullable<HistoryQuery['sort']>>('lastSeen-desc');
  const [fromText, setFromText] = useState('');
  const [toText, setToText] = useState('');

  // ---- selection / bulk (R23) ----
  const [selection, setSelection] = useState<Set<string>>(new Set());
  const [confirmBulk, setConfirmBulk] = useState(false);
  const [bulkNotice, setBulkNotice] = useState<string | null>(null);
  const [undoAvailable, setUndoAvailable] = useState(false);
  const undoRef = useRef<ReviewSummary[] | null>(null);

  // Selection is scoped to the CURRENT query window: it resets whenever the
  // window changes so no unseen row can be bulk-targeted (HIS-14). Derived at
  // render time — no effect, no cascading render.
  const selectionKey = `${page}|${pageSize}|${search}|${status}|${surface}|${sort}|${fromText}|${toText}`;
  const [ownedSelectionKey, setOwnedSelectionKey] = useState(selectionKey);
  if (ownedSelectionKey !== selectionKey) {
    setOwnedSelectionKey(selectionKey);
    selection.clear();
    if (confirmBulk) setConfirmBulk(false);
  }

  const queryKey = selectionKey;
  // The result carries the query key that produced it; a query is in flight
  // exactly while no stored result matches the CURRENT key (no setState inside
  // the effect, no refs read during render).
  const [resultState, setResultState] = useState<{ key: string; data: HistoryQueryResult } | null>(
    null,
  );
  const result = resultState !== null && resultState.key === queryKey ? resultState.data : null;
  const [error, setError] = useState<string | null>(null);
  // Stale-response drop guard — used inside async callbacks only (HIS-05).
  const querySeq = useRef(0);

  // ---- detail expansion (R24) ----
  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  const [events, setEvents] = useState<ReviewEvent[]>([]);

  const [confirmClear, setConfirmClear] = useState(false);

  // Debounce the search box (HIS-05) but keep an honest loading state.
  // Skip no-op commits: effects run on mount, and blindly calling setPage(1)
  // here would revert a page change made within the debounce window.
  const lastCommittedSearchRef = useRef('');
  useEffect(() => {
    const timer = setTimeout(() => {
      const next = searchInput.trim();
      if (next === lastCommittedSearchRef.current) return;
      lastCommittedSearchRef.current = next;
      setSearch(next);
      setPage(1);
    }, 250);
    return () => clearTimeout(timer);
  }, [searchInput]);

  useEffect(() => {
    const seq = ++querySeq.current;
    void backend
      .queryHistory({
        page,
        pageSize,
        search: search.length > 0 ? search : undefined,
        status,
        surface: surface === 'all' ? undefined : (surface as HistoryQuery['surface']),
        from: dayStart(fromText),
        to: dayEnd(toText),
        sort,
      })
      .then((r) => {
        // HIS-05: only the NEWEST query may update the UI.
        if (seq === querySeq.current) {
          setResultState({ key: queryKey, data: r });
          setError(null);
        }
      })
      .catch((e: unknown) => {
        if (seq === querySeq.current) {
          setError(e instanceof Error ? e.message : String(e));
        }
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- queryKey covers the inputs
  }, [queryKey, backend]);

  const refresh = (): void => {
    onChanged();
    const seq = ++querySeq.current;
    void backend
      .queryHistory({
        page,
        pageSize,
        search: search.length > 0 ? search : undefined,
        status,
        surface: surface === 'all' ? undefined : (surface as HistoryQuery['surface']),
        from: dayStart(fromText),
        to: dayEnd(toText),
        sort,
      })
      .then((r) => {
        if (seq === querySeq.current) setResultState({ key: queryKey, data: r });
      })
      .catch(() => undefined);
  };

  const applyRule = async (mutation: Parameters<typeof applyRuleMutation>[1]): Promise<void> => {
    const store = new RuleStore(new BrowserKVStore());
    await store.apply(mutation);
  };

  /** One review action on a durable summary (R22). */
  const act = async (
    summary: ReviewSummary,
    action: 'restore' | 'allow-video' | 'allow-channel' | 'not-ai' | 'not-slop',
  ): Promise<void> => {
    if (action === 'restore') {
      // Durable fact; content reappears on next sight. Persistent allow is a
      // separate explicit action (HIS-12).
      await backend.restoreSummary(summary.key);
    } else if (action === 'allow-video' && summary.videoId !== undefined) {
      await applyRule({ kind: 'allow-video', videoId: summary.videoId });
    } else if (action === 'allow-channel') {
      // Identity safety (HIS-13): channelId when present, else the parsed
      // handle — NEVER the display name.
      if (summary.channelId !== undefined) {
        await applyRule({ kind: 'allow-channel', channelId: summary.channelId });
      } else if (summary.handle !== undefined) {
        await applyRule({ kind: 'allow-channel-by-handle', handle: summary.handle });
      } else {
        return; // button is disabled; defensive no-op
      }
    } else if (action === 'not-ai' && summary.videoId !== undefined) {
      await backend.setCorrection(summary.videoId, 'notAi', true);
    } else if (action === 'not-slop' && summary.videoId !== undefined) {
      await backend.setCorrection(summary.videoId, 'notSlop', true);
    }
    refresh();
  };

  const toggleExpanded = async (key: string): Promise<void> => {
    if (expandedKey === key) {
      setExpandedKey(null);
      return;
    }
    setExpandedKey(key);
    setEvents([]);
    try {
      setEvents(await backend.getHistoryEvents(key, 20));
    } catch {
      setEvents([]);
    }
  };

  const bulkDelete = async (): Promise<void> => {
    const keys = [...selection];
    // Capture verbatim rows BEFORE deleting for bounded undo (HIS-16).
    const payload = await backend.getSummaries(keys);
    const { deleted, missing } = await backend.deleteSummaries(keys);
    undoRef.current = payload;
    setUndoAvailable(payload.length > 0);
    setConfirmBulk(false);
    setBulkNotice(
      missing.length === 0
        ? `Deleted ${deleted.length} record(s).`
        : `Deleted ${deleted.length}, ${missing.length} already gone.`,
    );
    setSelection(new Set());
    refresh();
  };

  const undoBulkDelete = async (): Promise<void> => {
    const payload = undoRef.current;
    if (payload === null) return;
    // Preserve newer edits: re-insert only rows that still don't exist.
    const existing = new Set(
      (await backend.getSummaries(payload.map((s) => s.key))).map((s) => s.key),
    );
    const restore = payload.filter((s) => !existing.has(s.key));
    await backend.putSummaries(restore);
    undoRef.current = null;
    setUndoAvailable(false);
    setBulkNotice(
      restore.length === payload.length
        ? `Restored ${restore.length} record(s).`
        : `Restored ${restore.length}; ${payload.length - restore.length} had newer data and were kept.`,
    );
    refresh();
  };

  const clearHistory = async () => {
    await backend.clearHistory();
    setConfirmClear(false);
    refresh();
  };

  const loading = result === null && error === null;
  const totalPages = result === null ? 1 : Math.max(1, Math.ceil(result.total / result.pageSize));
  const effectivePage = result?.page ?? page;
  const items = result?.items ?? [];
  const hasFilters =
    search.length > 0 || status !== 'all' || surface !== 'all' || fromText !== '' || toText !== '';

  return (
    <>
      <Section title="Review history">
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <input
            type="search"
            value={searchInput}
            onChange={(e) => setSearchInput(e.currentTarget.value)}
            placeholder="Search title, channel, video…"
            aria-label="Search history"
            className="rounded border border-black/20 px-2 py-1 text-sm"
          />
          <select
            value={status}
            onChange={(e) => {
              setStatus(e.currentTarget.value as typeof status);
              setPage(1);
            }}
            aria-label="Filter by status"
            className="rounded border border-black/20 px-2 py-1 text-sm"
          >
            <option value="all">All statuses</option>
            <option value="pending">Pending</option>
            <option value="restored">Restored</option>
            <option value="corrected">Corrected</option>
            <option value="allowed">Allowed</option>
          </select>
          <select
            value={surface}
            onChange={(e) => {
              setSurface(e.currentTarget.value);
              setPage(1);
            }}
            aria-label="Filter by surface"
            className="rounded border border-black/20 px-2 py-1 text-sm"
          >
            <option value="all">All surfaces</option>
            <option value="home">Home</option>
            <option value="search">Search</option>
            <option value="subscriptions">Subscriptions</option>
            <option value="watch-sidebar">Watch sidebar</option>
            <option value="shorts-shelf">Shorts shelf</option>
            <option value="channel">Channel</option>
          </select>
          <select
            value={sort}
            onChange={(e) => {
              setSort(e.currentTarget.value as typeof sort);
              setPage(1);
            }}
            aria-label="Sort order"
            className="rounded border border-black/20 px-2 py-1 text-sm"
          >
            <option value="lastSeen-desc">Newest first</option>
            <option value="lastSeen-asc">Oldest first</option>
            <option value="title-asc">Title A–Z</option>
            <option value="count-desc">Most hidden</option>
          </select>
          <input
            type="date"
            value={fromText}
            onChange={(e) => {
              setFromText(e.currentTarget.value);
              setPage(1);
            }}
            aria-label="From date"
            className="rounded border border-black/20 px-2 py-1 text-sm"
          />
          <input
            type="date"
            value={toText}
            onChange={(e) => {
              setToText(e.currentTarget.value);
              setPage(1);
            }}
            aria-label="To date"
            className="rounded border border-black/20 px-2 py-1 text-sm"
          />
          <select
            value={pageSize}
            onChange={(e) => {
              const parsed = Number(e.currentTarget.value);
              setPageSize(PAGE_SIZES.includes(parsed) ? parsed : 25);
              setPage(1);
            }}
            aria-label="Rows per page"
            className="rounded border border-black/20 px-2 py-1 text-sm"
          >
            {PAGE_SIZES.map((size) => (
              <option key={size} value={size}>
                {size} / page
              </option>
            ))}
          </select>
          <Button onClick={refresh}>Refresh</Button>
        </div>

        {loading && <p className="text-sm opacity-70">Loading history…</p>}

        {!loading && error !== null && (
          <div role="alert" className="rounded bg-red-50 p-3 text-sm">
            <p className="font-medium">Could not load history.</p>
            <p className="opacity-70">{error}</p>
            <div className="mt-2">
              <Button onClick={refresh}>Retry</Button>
            </div>
          </div>
        )}

        {!loading && error === null && result !== null && result.total === 0 && (
          <p className="text-sm opacity-70">
            {hasFilters
              ? 'No records match these filters. Reset filters to see everything.'
              : 'Nothing hidden yet. Videos hidden automatically will appear here for review.'}
          </p>
        )}

        {!loading && error === null && result !== null && result.total > 0 && (
          <>
            <p className="mb-2 text-xs opacity-70">
              {result.total} record(s) · page {effectivePage} of {totalPages}
              {hasFilters ? ' (filters active)' : ''}
            </p>
            {selection.size > 0 && (
              <div className="mb-2 flex flex-wrap items-center gap-2 rounded bg-black/5 p-2 text-sm dark:bg-white/10">
                <span>{selection.size} selected</span>
                <Button variant="danger" onClick={() => setConfirmBulk(true)}>
                  Delete selected…
                </Button>
                <Button onClick={() => setSelection(new Set())}>Clear selection</Button>
              </div>
            )}
            {bulkNotice !== null && (
              <div className="mb-2 rounded bg-black/5 p-2 text-sm dark:bg-white/10" role="status">
                <span>{bulkNotice}</span>
                {undoAvailable && <Button onClick={() => void undoBulkDelete()}>Undo</Button>}
              </div>
            )}
            <ul className="space-y-3">
              {items.map((summary) => {
                const channelActionable =
                  summary.channelId !== undefined || summary.handle !== undefined;
                return (
                  <li
                    key={summary.key}
                    className="rounded border border-black/10 p-3 text-sm dark:border-white/15"
                  >
                    <div className="flex items-start gap-2">
                      <input
                        type="checkbox"
                        aria-label={`Select ${summary.title || summary.key}`}
                        checked={selection.has(summary.key)}
                        onChange={(e) => {
                          const next = new Set(selection);
                          if (e.currentTarget.checked) next.add(summary.key);
                          else next.delete(summary.key);
                          setSelection(next);
                        }}
                        className="mt-1"
                      />
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <p className="font-medium">{summary.title || '(untitled)'}</p>
                          <span className="rounded bg-black/5 px-1.5 py-0.5 text-[11px] font-medium opacity-80 dark:bg-white/10">
                            {formatDecisionReason(
                              summary.latestDecision.reason,
                              summary.latestDecision.ruleId,
                            )}
                          </span>
                        </div>
                        <p className="opacity-70">
                          {summary.channelName ?? 'Unknown channel'} · {summary.surfaces.join(', ')}{' '}
                          · {summary.resolution} · hidden ×{summary.count} · last seen{' '}
                          {new Date(summary.lastSeen).toLocaleString()}
                        </p>
                        <ul className="mt-1 list-disc pl-5 text-xs opacity-80">
                          {summary.latestDecision.explanation.slice(0, 3).map((line, i) => (
                            <li key={i}>{line}</li>
                          ))}
                        </ul>
                      </div>
                    </div>
                    <div className="mt-2 flex flex-wrap gap-2">
                      <Button onClick={() => void act(summary, 'restore')}>Restore</Button>
                      {summary.videoId !== undefined && (
                        <Button onClick={() => void act(summary, 'allow-video')}>
                          Allow video
                        </Button>
                      )}
                      <span
                        title={
                          channelActionable
                            ? undefined
                            : 'No channel identity was available on this card; a channel rule cannot be created.'
                        }
                      >
                        <Button
                          onClick={() => void act(summary, 'allow-channel')}
                          {...(channelActionable ? {} : { disabled: true })}
                        >
                          Allow channel
                        </Button>
                      </span>
                      {summary.videoId !== undefined && (
                        <>
                          <Button onClick={() => void act(summary, 'not-ai')}>Not AI</Button>
                          <Button onClick={() => void act(summary, 'not-slop')}>Not slop</Button>
                        </>
                      )}
                      <Button onClick={() => void toggleExpanded(summary.key)}>
                        {expandedKey === summary.key ? 'Hide details' : 'Details'}
                      </Button>
                    </div>
                    {expandedKey === summary.key && (
                      <div className="mt-2 rounded bg-black/5 p-2 text-xs dark:bg-white/10">
                        <p className="font-semibold">Decision</p>
                        <p>
                          {summary.latestDecision.action} · {summary.latestDecision.reason}
                        </p>
                        <p className="mt-1 font-semibold">Event log</p>
                        {events.length === 0 ? (
                          <p className="opacity-70">No events recorded.</p>
                        ) : (
                          <ul className="list-disc pl-5">
                            {events.map((event) => (
                              <li key={event.eventId}>
                                {event.kind} · {new Date(event.occurredAt).toLocaleString()} ·{' '}
                                {event.decisionSnapshot.action}
                              </li>
                            ))}
                          </ul>
                        )}
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
            <div className="mt-3 flex items-center gap-2">
              <Button
                onClick={() => setPage(Math.max(1, effectivePage - 1))}
                {...(effectivePage <= 1 ? { disabled: true } : {})}
              >
                ← Previous
              </Button>
              <span className="text-sm opacity-70">
                Page {effectivePage} / {totalPages}
              </span>
              <Button
                onClick={() => setPage(Math.min(totalPages, effectivePage + 1))}
                {...(effectivePage >= totalPages ? { disabled: true } : {})}
              >
                Next →
              </Button>
            </div>
            {confirmBulk && (
              <ConfirmDialog
                label="Confirm bulk delete"
                confirmLabel="Delete"
                danger
                onConfirm={() => void bulkDelete()}
                onCancel={() => setConfirmBulk(false)}
              >
                <p className="text-sm">
                  Delete exactly {selection.size} selected record(s)? Corrections on those videos
                  are kept.
                </p>
              </ConfirmDialog>
            )}
          </>
        )}
      </Section>

      {records.length > 0 && (
        <Section title="Not yet migrated (old history)">
          <p className="mb-2 text-xs opacity-70">
            {records.length} record(s) from a previous version. They are kept until a successful
            migration completes; restoring uses their stored identity.
          </p>
          <ul className="space-y-2">
            {records.slice(0, 10).map((record) => (
              <li
                key={record.id}
                className="rounded border border-black/10 p-2 text-sm dark:border-white/15"
              >
                <p className="font-medium">{record.title || '(untitled)'}</p>
                <p className="opacity-70">
                  {record.channelName ?? 'Unknown channel'} · {record.surface} ·{' '}
                  {new Date(record.createdAt).toLocaleString()}
                </p>
                <div className="mt-1 flex flex-wrap gap-2">
                  <Button onClick={() => void backend.restoreSummary(record.id).then(refresh)}>
                    Restore
                  </Button>
                  {record.videoId !== undefined && (
                    <>
                      <Button
                        onClick={() =>
                          void backend.setCorrection(record.videoId!, 'notAi', true).then(refresh)
                        }
                      >
                        Not AI
                      </Button>
                      <Button
                        onClick={() =>
                          void backend.setCorrection(record.videoId!, 'notSlop', true).then(refresh)
                        }
                      >
                        Not slop
                      </Button>
                    </>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </Section>
      )}

      <Section title="Danger zone">
        {confirmClear ? (
          <ConfirmDialog
            label="Confirm clear history"
            confirmLabel="Clear history"
            danger
            onConfirm={() => void clearHistory()}
            onCancel={() => setConfirmClear(false)}
          >
            <p className="text-sm">
              Clear all review history? Your Not AI / Not slop corrections are kept.
            </p>
          </ConfirmDialog>
        ) : (
          <Button onClick={() => setConfirmClear(true)}>Clear history…</Button>
        )}
      </Section>
    </>
  );
}

function DataSection({
  settings,
  rules,
  review,
  stats,
  onImported,
  setNotice,
  backend,
}: {
  settings: UserSettings;
  rules: UserRules;
  review: ReviewRecord[];
  stats: LocalStats;
  onImported: () => void;
  setNotice: (notice: string | null) => void;
  backend: Backend;
}) {
  const [prepared, setPrepared] = useState<ImportOutcome | null>(null);
  const [quarantine, setQuarantine] = useState<QuarantineItem[]>([]);

  useEffect(() => {
    let cancelled = false;
    void backend
      .getQuarantine()
      .then((items) => {
        if (!cancelled) setQuarantine(items);
      })
      .catch(() => {
        if (!cancelled) setQuarantine([]);
      });
    return () => {
      cancelled = true;
    };
  }, [backend]);

  const doExport = () => {
    const payload = buildExport({ settings, rules, review, stats: stats ?? defaultStats() });
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = 'blocktheslop-export.json';
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const onFile = async (file: File) => {
    const text = await file.text();
    try {
      const parsed = parseImport(text);
      // The PREPARED outcome (04 §10) is held in state — never reparsed as an
      // export file, never re-derived at commit time.
      setPrepared(parsed);
      setNotice(null);
    } catch (error) {
      if (error instanceof ImportRejectedError) {
        setNotice(`Import rejected: ${error.message}`);
      } else {
        setNotice('Import failed.');
      }
    }
  };

  const commitImport = async () => {
    if (prepared === null) return;
    const parsed = prepared;
    // Settings/rules/stats via storage; durable review history via the
    // background-owned IDB path (content of this page must not touch IDB).
    await browser.storage.local.set({
      'local:settings': parsed.settings,
      'local:rules': parsed.rules,
      'local:stats': parsed.stats,
      'local:schemaVersion': SETTINGS_SCHEMA_VERSION,
    });
    if (parsed.review.length > 0) {
      const summaries = parsed.review.map((r) => legacyRecordToSummary(r));
      await backend.putSummaries(summaries);
    }
    if (parsed.privacyFlagsSanitized) {
      setNotice('Import applied. Remote/feedback flags were disabled for safety.');
    } else {
      setNotice('Import applied.');
    }
    setPrepared(null);
    onImported();
  };

  return (
    <>
      <Section title="Export">
        <Button variant="primary" onClick={doExport}>
          Export settings and rules
        </Button>
      </Section>
      <Section title="Import">
        <p className="mb-2 text-xs opacity-70">
          Files are validated strictly; imports never execute data.
        </p>
        <input
          type="file"
          accept="application/json,.json"
          aria-label="Import file"
          onChange={(e) => {
            const file = e.currentTarget.files?.[0];
            if (file !== undefined) void onFile(file);
          }}
          className="block text-sm"
        />
        {prepared !== null && (
          <ConfirmDialog
            label="Confirm import"
            confirmLabel="Overwrite and import"
            danger
            onConfirm={() => void commitImport()}
            onCancel={() => setPrepared(null)}
          >
            <p className="text-sm">
              Importing will overwrite current settings, rules, and statistics
              {prepared.review.length > 0
                ? `, and merge ${prepared.review.length} review record(s) into history`
                : ''}
              . Continue?
            </p>
            {prepared.warnings.length > 0 && (
              <ul className="mt-1 list-disc pl-5 text-xs opacity-80">
                {prepared.warnings.map((w) => (
                  <li key={w}>{w}</li>
                ))}
              </ul>
            )}
          </ConfirmDialog>
        )}
      </Section>
      <Section title="Diagnostics">
        <p className="text-sm opacity-70">
          {quarantine.length === 0
            ? 'No quarantined records. Migration and import rejected nothing.'
            : `${quarantine.length} quarantined record(s) from migration/import (bounded, never executed).`}
        </p>
        {quarantine.length > 0 && (
          <ul className="mt-2 space-y-1 text-xs opacity-80">
            {quarantine.slice(0, 10).map((item) => (
              <li key={item.id}>
                {item.source} · {item.reason} · {new Date(item.occurredAt).toLocaleString()}
              </li>
            ))}
          </ul>
        )}
      </Section>
      <Section title="Data controls">
        <p className="mb-2 text-xs opacity-70">
          Each data class clears separately (DATA-08). Rules and settings are never touched here.
        </p>
        <DataClearButton
          label="Clear classification cache…"
          confirm="Clear the classification cache? Videos are re-evaluated locally on next sight."
          action={() => backend.clearCache()}
          done="Cache cleared."
        />
        <DataClearButton
          label="Clear local statistics…"
          confirm="Reset the local statistics counters to zero?"
          action={() => backend.resetStats()}
          done="Statistics reset."
        />
        <DataClearButton
          label="Clear all Not-AI / Not-slop corrections…"
          confirm="
            Delete ALL corrections? Hidden videos may reappear — you would need to correct them
            again. This cannot be undone."
          action={() => backend.clearCorrections()}
          done="Corrections cleared."
          danger
        />
      </Section>
      <Section title="Danger zone">
        <ResetButton />
      </Section>
    </>
  );
}

/** One DATA-08 control: explicit label → confirmation → background action → visible result. */
function DataClearButton({
  label,
  confirm,
  action,
  done,
  danger = false,
}: {
  label: string;
  confirm: string;
  action: () => Promise<void>;
  done: string;
  danger?: boolean;
}) {
  const [confirming, setConfirming] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (!confirming) {
    return (
      <div className="mb-1">
        <Button variant={danger ? 'danger' : 'secondary'} onClick={() => setConfirming(true)}>
          {label}
        </Button>
        {notice !== null && (
          <p role="status" className="text-xs opacity-70">
            {notice}
          </p>
        )}
      </div>
    );
  }
  return (
    <ConfirmDialog
      label={confirm}
      confirmLabel={danger ? 'Yes, delete' : 'Confirm'}
      danger={danger}
      confirmDisabled={busy}
      onConfirm={() => {
        setBusy(true);
        void action()
          .then(() => {
            setNotice(done);
            setConfirming(false);
          })
          .catch((e: unknown) => setNotice(e instanceof Error ? e.message : String(e)))
          .finally(() => setBusy(false));
      }}
      onCancel={() => setConfirming(false)}
    >
      <p className="text-sm">{confirm}</p>
    </ConfirmDialog>
  );
}

function ResetButton() {
  const [confirming, setConfirming] = useState(false);
  if (!confirming) {
    return (
      <Button variant="danger" onClick={() => setConfirming(true)}>
        Reset all settings…
      </Button>
    );
  }
  return (
    <ConfirmDialog
      label="Confirm reset"
      confirmLabel="Reset settings"
      danger
      onConfirm={() => {
        void browser.storage.local.set({ 'local:settings': defaultSettings() });
        setConfirming(false);
      }}
      onCancel={() => setConfirming(false)}
    >
      <p className="text-sm">Reset all settings to defaults? Your allow/block rules are kept.</p>
    </ConfirmDialog>
  );
}
