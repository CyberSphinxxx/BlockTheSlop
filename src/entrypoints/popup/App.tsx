import { useCallback, useEffect, useState } from 'react';
import type { EvidenceCategory } from '@/domain/evidence';
import { EVIDENCE_CATEGORIES } from '@/domain/evidence';
import type { FilterMode, UserSettings } from '@/domain/settings';
import type { LocalStats } from '@/domain/stats';
import { validateSettings } from '@/domain/settings';
import { Button, SegmentedControl, Toggle } from '@/ui/components/primitives';
import type { Backend } from '@/ui/messaging';

/** Quick category controls shown in the popup. */
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

const NEXT_ACTION: Record<'allow' | 'warn' | 'hide', 'allow' | 'warn' | 'hide'> = {
  allow: 'warn',
  warn: 'hide',
  hide: 'allow',
};

export function PopupApp({ backend }: { backend: Backend }) {
  const [settings, setSettings] = useState<UserSettings | null>(null);
  const [stats, setStats] = useState<LocalStats | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [s, st] = await Promise.all([backend.getSettings(), backend.getStats()]);
      setSettings(s);
      setStats(st);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [backend]);

  useEffect(() => {
    // Deferred so state updates never happen synchronously in the effect.
    void Promise.resolve().then(refresh);
  }, [refresh]);

  const save = useCallback(
    async (next: UserSettings) => {
      const validated = validateSettings(next);
      if (validated === null) return;
      setSettings(validated);
      // CFG-03: send only changed fields so a concurrent options edit
      // survives (neither surface owns the whole settings blob).
      const patch: Partial<UserSettings> = {};
      if (settings !== null) {
        for (const key of Object.keys(validated) as (keyof UserSettings)[]) {
          if (JSON.stringify(validated[key]) !== JSON.stringify(settings[key])) {
            (patch as Record<string, unknown>)[key] = validated[key];
          }
        }
      } else {
        Object.assign(patch, validated);
      }
      await backend.saveSettings(patch);
    },
    [backend, settings],
  );

  if (error !== null) {
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

  const today =
    stats ??
    ({
      cardsEvaluated: 0,
      hidden: 0,
      warned: 0,
      restored: 0,
      manualBlocks: 0,
      falsePositiveCorrections: 0,
      rulesTriggered: 0,
      processingBatches: 0,
      totalProcessingMs: 0,
      maxProcessingMs: 0,
      resetAt: 0,
    } satisfies LocalStats);

  return (
    <div className="w-[340px] max-w-full p-4">
      <header className="mb-3 flex items-center justify-between gap-2">
        <h1 className="text-base font-bold">BlockTheSlop</h1>
        <Toggle
          id="bts-enabled"
          label={settings.enabled ? 'On' : 'Off'}
          checked={settings.enabled}
          onChange={(enabled) => void save({ ...settings, enabled })}
        />
      </header>

      <SegmentedControl<FilterMode>
        legend="Filtering mode"
        name="mode"
        value={settings.mode}
        onChange={(mode) => void save({ ...settings, mode })}
        options={[
          { value: 'safe', label: 'Safe', hint: 'Hide only very high-confidence content' },
          { value: 'balanced', label: 'Balanced', hint: 'Recommended' },
          {
            value: 'strict',
            label: 'Strict',
            hint: 'Hide moderate-confidence content; more false positives',
          },
        ]}
      />

      <section className="mt-3" aria-label="Statistics">
        <h2 className="text-xs font-semibold uppercase tracking-wide opacity-70">Today</h2>
        <p className="text-sm">
          <span className="font-semibold">{today.hidden}</span> hidden ·{' '}
          <span className="font-semibold">{today.warned}</span> warned
        </p>
      </section>

      <section className="mt-3" aria-label="Quick category controls">
        <h2 className="mb-1 text-xs font-semibold uppercase tracking-wide opacity-70">
          Quick controls
        </h2>
        {QUICK_CATEGORIES.map((category) => {
          const action = settings.categoryActions[category];
          const effective = action === 'inherit' ? 'allow' : action;
          return (
            <div key={category} className="flex items-center justify-between py-1">
              <span className="text-sm">{CATEGORY_LABELS[category]}</span>
              <Button
                onClick={() =>
                  void save({
                    ...settings,
                    categoryActions: {
                      ...settings.categoryActions,
                      [category]: NEXT_ACTION[effective],
                    },
                  })
                }
                aria-label={`${CATEGORY_LABELS[category]}: currently ${action}. Click to change.`}
              >
                {action === 'inherit'
                  ? 'Default'
                  : action.charAt(0).toUpperCase() + action.slice(1)}
              </Button>
            </div>
          );
        })}
      </section>

      <nav className="mt-4 flex gap-2" aria-label="Open pages">
        <Button
          variant="primary"
          onClick={() => void browser.tabs.create({ url: browser.runtime.getURL('/options.html') })}
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
          needed.
        </p>
      </details>
    </div>
  );
}
