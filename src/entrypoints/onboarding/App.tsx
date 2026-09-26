import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Backend } from '@/ui/messaging';
import { applyThemeToDocument } from '@/ui/theme';
import { Button, SegmentedControl, Toggle } from '@/ui/components/primitives';
import {
  DISCOVERY_SOURCES,
  ONBOARDING_CATEGORY_CARDS,
  SENSITIVITIES,
  buildOnboardingSettingsPatch,
  defaultOnboardingDraft,
  validateOnboardingDraft,
  type DiscoverySource,
  type OnboardingDraft,
  type OnboardingTreatment,
  type Sensitivity,
} from '@/domain/onboarding';
import { validateSettings } from '@/domain/settings';

/**
 * Onboarding flow (V6-03…V6-07).
 *
 * Honest-by-construction rules honored here:
 * - Nothing is persisted until the single Apply transaction; a failed save
 *   shows an error with Retry and NEVER shows Ready.
 * - Skip finishes safely: it records completion WITHOUT writing any setting.
 * - Back/navigation/refresh never saves partial choices.
 * - "Videos about AI" is a separate, opt-in card.
 * - No Blur/Dim choice exists anywhere (the feature does not exist; showing
 *   it would be a placebo control).
 * - The discovery answer is local-only and optional; skipping never blocks.
 * - Copy never promises frame/audio/transcript analysis or blocking of every
 *   AI video.
 */

const DISCOVERY_LABELS: Record<DiscoverySource, string> = {
  facebook: 'Facebook',
  tiktok: 'TikTok',
  friend: 'Friend or family',
  reddit: 'Reddit',
  'chrome-web-store': 'Chrome Web Store',
  other: 'Other',
  'prefer-not-to-say': 'Prefer not to say',
};

const SENSITIVITY_HINTS: Record<Sensitivity, { label: string; hint: string }> = {
  low: {
    label: 'Low',
    hint: 'Hide only very obvious AI slop. Fewest mistakes, more slips through.',
  },
  balanced: {
    label: 'Balanced',
    hint: 'Recommended. Good coverage with rare false positives.',
  },
  high: {
    label: 'High',
    hint: 'Aggressively filters suspicious content. More harmless videos get hidden.',
  },
};

const TREATMENT_HINTS: Record<OnboardingTreatment, { label: string; hint: string }> = {
  hide: {
    label: 'Hide (recommended)',
    hint: 'Matched videos collapse on the page. You can review and restore anything hidden.',
  },
  warn: {
    label: 'Warn',
    hint: 'Videos stay visible with a clear warning label instead of being hidden.',
  },
};

type StepId =
  'welcome' | 'discovery' | 'content' | 'treatment' | 'sensitivity' | 'review' | 'ready';

const STEP_ORDER: readonly StepId[] = [
  'welcome',
  'discovery',
  'content',
  'treatment',
  'sensitivity',
  'review',
  'ready',
];

const STORAGE_DRAFT_KEY = 'bts:onboarding:draft';

export function OnboardingApp({ backend }: { backend: Backend }) {
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [alreadyCompleted, setAlreadyCompleted] = useState(false);
  const [step, setStep] = useState<StepId>('welcome');
  const [draft, setDraft] = useState<OnboardingDraft>(defaultOnboardingDraft());
  const [applyState, setApplyState] = useState<'idle' | 'saving' | 'error'>('idle');
  const [skipState, setSkipState] = useState<'idle' | 'saving' | 'error'>('idle');
  const headingRef = useRef<HTMLHeadingElement | null>(null);

  // Restore an in-progress draft after refresh (never a partial settings
  // write — the draft is page-local, settings are written only at Apply).
  // State updates are deferred to a microtask so no setState fires
  // synchronously inside the effect.
  useEffect(() => {
    void Promise.resolve().then(() => {
      try {
        const raw = window.localStorage.getItem(STORAGE_DRAFT_KEY);
        if (raw !== null) {
          const restored = validateOnboardingDraft(JSON.parse(raw));
          if (restored !== null) setDraft(restored);
        }
      } catch {
        // Corrupt draft: ignore, defaults are fine.
      }
      setLoaded(true);
    });
  }, []);

  useEffect(() => {
    if (!loaded) return;
    try {
      window.localStorage.setItem(STORAGE_DRAFT_KEY, JSON.stringify(draft));
    } catch {
      // Non-essential convenience; storage failures never block setup.
    }
  }, [draft, loaded]);

  // Immediate theme propagation (same setting as options/popup), plus the
  // completed-state check: a completed user who reopens the page from Settings
  // sees a read-only page, never the flow again.
  useEffect(() => {
    let cleanup: (() => void) | undefined;
    let cancelled = false;
    void Promise.all([backend.getSettings(), backend.getOnboardingState()]).then(
      ([settings, state]) => {
        if (cancelled) return;
        cleanup = applyThemeToDocument(document, settings.theme);
        setAlreadyCompleted(state.completed);
        setLoaded(true);
      },
      (e: unknown) => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : String(e));
        setLoaded(true);
      },
    );
    return () => {
      cancelled = true;
      cleanup?.();
    };
  }, [backend]);

  useEffect(() => {
    headingRef.current?.focus();
  }, [step]);

  const update = useCallback((patch: Partial<OnboardingDraft>) => {
    setDraft((previous) => ({ ...previous, ...patch }));
  }, []);

  const goNext = useCallback(() => {
    setStep(
      (current) => STEP_ORDER[Math.min(STEP_ORDER.indexOf(current) + 1, STEP_ORDER.length - 1)]!,
    );
  }, []);

  const goBack = useCallback(() => {
    setStep((current) => STEP_ORDER[Math.max(STEP_ORDER.indexOf(current) - 1, 0)]!);
  }, []);

  const openOptions = useCallback(() => {
    void browser.tabs.create({ url: browser.runtime.getURL('/options.html') });
  }, []);

  const openYouTube = useCallback(() => {
    void browser.tabs.create({ url: 'https://www.youtube.com/' });
  }, []);

  const finish = useCallback(
    async (mode: 'apply' | 'skip') => {
      // Audit M2: a finished setup must not leave the draft blob behind
      // (a stale draft would silently reapply old choices on a later reopen).
      const clearDraft = (): void => {
        try {
          window.localStorage.removeItem(STORAGE_DRAFT_KEY);
        } catch {
          // Non-essential convenience.
        }
      };
      if (mode === 'skip') {
        setSkipState('saving');
        try {
          await backend.completeOnboarding(undefined);
          setSkipState('idle');
          setStep('ready');
          clearDraft();
        } catch (e) {
          setSkipState('error');
          setError(e instanceof Error ? e.message : String(e));
        }
        return;
      }
      setApplyState('saving');
      try {
        const current = await backend.getSettings();
        const patch = buildOnboardingSettingsPatch(draft, current);
        const merged = validateSettings({ ...current, ...patch });
        if (merged === null) {
          setApplyState('error');
          setError('The chosen settings could not be validated. Nothing was changed.');
          return;
        }
        // One atomic settings transaction (field-level PATCH, validated).
        await backend.saveSettings(patch);
        await backend.completeOnboarding(draft.discoverySource);
        setApplyState('idle');
        setStep('ready');
        clearDraft();
      } catch (e) {
        // Visible failure: apply state shows the error + Retry; nothing was
        // committed because saveSettings is a single transaction and the
        // completion flag is written only AFTER it succeeded.
        setApplyState('error');
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    [backend, draft],
  );

  const summaryLines = useMemo(() => {
    const checked = ONBOARDING_CATEGORY_CARDS.filter((c) => draft.categories[c.category] === true);
    const lines: string[] = [];
    lines.push(
      checked.length === 0
        ? 'Content to filter: nothing selected (you can change this any time)'
        : `Content to filter: ${checked.map((c) => c.label).join(', ')}`,
    );
    lines.push(`Treatment: ${TREATMENT_HINTS[draft.treatment].label}`);
    lines.push(`Sensitivity: ${SENSITIVITY_HINTS[draft.sensitivity].label}`);
    if (draft.discoverySource !== undefined) {
      lines.push(
        `Found us via: ${DISCOVERY_LABELS[draft.discoverySource]} (stored only on this device)`,
      );
    }
    return lines;
  }, [draft]);

  if (error !== null && step !== 'ready') {
    // Non-fatal errors are shown inline in the step; this gate is only for
    // load-time failures before any step rendered.
    if (loaded && step === 'welcome' && applyState === 'idle' && skipState === 'idle') {
      // fall through to render (error shown inline below)
    }
  }

  if (!loaded) {
    return (
      <div className="mx-auto max-w-2xl p-8 text-sm opacity-70" aria-busy="true">
        Loading…
      </div>
    );
  }

  if (alreadyCompleted) {
    return (
      <div className="mx-auto max-w-2xl p-8" role="status">
        <h1 className="text-2xl font-bold">Setup already completed</h1>
        <p className="mt-3 text-sm">
          Your filtering settings are unchanged. You can revisit choices in Settings.
        </p>
        <div className="mt-6 flex gap-2">
          <Button variant="primary" onClick={openOptions}>
            Open Settings
          </Button>
          <Button onClick={openYouTube}>Open YouTube</Button>
        </div>
      </div>
    );
  }

  const progressIndex = STEP_ORDER.indexOf(step);

  return (
    <div className="mx-auto max-w-2xl px-6 py-8">
      <ol className="mb-6 flex gap-2 text-xs opacity-70" aria-label="Progress">
        {STEP_ORDER.map((s, i) => (
          <li
            key={s}
            aria-current={s === step ? 'step' : undefined}
            className={i <= progressIndex ? 'font-semibold' : ''}
          >
            {i + 1}
          </li>
        ))}
      </ol>

      {error !== null && (
        <div
          role="alert"
          className="mb-4 rounded border border-red-400/40 bg-red-500/10 p-3 text-sm"
        >
          <p className="font-semibold">Something went wrong. Nothing was changed.</p>
          <p className="mt-1 opacity-80">{error}</p>
        </div>
      )}

      <h1 ref={headingRef} tabIndex={-1} className="text-2xl font-bold outline-none">
        {step === 'welcome' && 'Welcome to BlockTheSlop'}
        {step === 'discovery' && 'How did you find us? (optional)'}
        {step === 'content' && 'What do you want filtered on YouTube?'}
        {step === 'treatment' && 'What should happen to matched videos?'}
        {step === 'sensitivity' && 'How aggressively should we filter?'}
        {step === 'review' && 'Review your choices'}
        {step === 'ready' && "You're all set"}
      </h1>

      {step === 'welcome' && (
        <section className="mt-4 space-y-3 text-sm">
          <p>
            BlockTheSlop filters AI-generated and low-quality &ldquo;slop&rdquo; videos on YouTube —
            entirely on your device. No account, no sign-up, nothing uploaded.
          </p>
          <ul className="list-disc space-y-1 pl-5 opacity-80">
            <li>
              Detection works from <strong>visible text only</strong> (titles, descriptions,
              labels). It cannot watch frames, listen to audio, or read transcripts — so it will not
              catch every AI video, and it never claims to.
            </li>
            <li>
              Every automatic hide is <strong>explainable and reversible</strong>: you can review
              and restore anything, any time.
            </li>
            <li>Works only on youtube.com. You can change all of this later in Settings.</li>
          </ul>
          <p className="opacity-70">
            Setup takes about a minute. You can skip it and keep the default balanced settings —
            skipping never changes your settings.
          </p>
          <div className="flex gap-2 pt-2">
            <Button variant="primary" onClick={goNext}>
              Start
            </Button>
            <Button onClick={() => void finish('skip')} disabled={skipState === 'saving'}>
              {skipState === 'saving' ? 'Finishing…' : 'Skip setup'}
            </Button>
          </div>
        </section>
      )}

      {step === 'discovery' && (
        <section className="mt-4 space-y-3 text-sm">
          <p>
            Optional, and stored only on this device. It never leaves your browser and is not
            analytics.
          </p>
          <fieldset className="space-y-1">
            <legend className="sr-only">How did you find BlockTheSlop?</legend>
            {DISCOVERY_SOURCES.map((source) => (
              <label
                key={source}
                className="flex cursor-pointer items-center gap-2 rounded px-2 py-1 hover:bg-black/5 dark:hover:bg-white/10"
              >
                <input
                  type="radio"
                  name="discovery"
                  checked={draft.discoverySource === source}
                  onChange={() => update({ discoverySource: source })}
                />
                <span>{DISCOVERY_LABELS[source]}</span>
              </label>
            ))}
          </fieldset>
          <div className="flex gap-2 pt-2">
            <Button onClick={goBack}>Back</Button>
            <Button variant="primary" onClick={goNext}>
              Continue
            </Button>
          </div>
        </section>
      )}

      {step === 'content' && (
        <section className="mt-4 space-y-3 text-sm">
          <p>
            Choose what to filter. &ldquo;Videos about AI&rdquo; is a separate choice — a human
            talking about AI is not an AI-made video.
          </p>
          <div className="space-y-2">
            {ONBOARDING_CATEGORY_CARDS.map((card) => (
              <Toggle
                key={card.category}
                id={`card-${card.category}`}
                label={card.label}
                description={card.description}
                checked={draft.categories[card.category] === true}
                onChange={(checked) =>
                  update({ categories: { ...draft.categories, [card.category]: checked } })
                }
              />
            ))}
          </div>
          <div className="flex gap-2 pt-2">
            <Button onClick={goBack}>Back</Button>
            <Button variant="primary" onClick={goNext}>
              Continue
            </Button>
          </div>
        </section>
      )}

      {step === 'treatment' && (
        <section className="mt-4 space-y-3 text-sm">
          <SegmentedControl<OnboardingTreatment>
            legend="Treatment"
            name="treatment"
            value={draft.treatment}
            onChange={(treatment) => update({ treatment })}
            options={[
              { value: 'hide', label: TREATMENT_HINTS.hide.label, hint: TREATMENT_HINTS.hide.hint },
              { value: 'warn', label: TREATMENT_HINTS.warn.label, hint: TREATMENT_HINTS.warn.hint },
            ]}
          />
          <p className="opacity-70">{TREATMENT_HINTS[draft.treatment].hint}</p>
          <p className="opacity-70">
            Every hidden item can be reviewed and restored from the popup, the on-page notice, or
            the Review tab.
          </p>
          <div className="flex gap-2 pt-2">
            <Button onClick={goBack}>Back</Button>
            <Button variant="primary" onClick={goNext}>
              Continue
            </Button>
          </div>
        </section>
      )}

      {step === 'sensitivity' && (
        <section className="mt-4 space-y-3 text-sm">
          <SegmentedControl<Sensitivity>
            legend="Sensitivity"
            name="sensitivity"
            value={draft.sensitivity}
            onChange={(sensitivity) => update({ sensitivity })}
            options={SENSITIVITIES.map((s) => ({
              value: s,
              label: SENSITIVITY_HINTS[s].label,
              hint: SENSITIVITY_HINTS[s].hint,
            }))}
          />
          <p className="opacity-70">{SENSITIVITY_HINTS[draft.sensitivity].hint}</p>
          <p className="opacity-70">
            Plain tradeoff: the higher the sensitivity, the more harmless videos get hidden — all
            recoverable. Advanced users can later choose Aggressive in Settings.
          </p>
          <div className="flex gap-2 pt-2">
            <Button onClick={goBack}>Back</Button>
            <Button variant="primary" onClick={goNext}>
              Continue
            </Button>
          </div>
        </section>
      )}

      {step === 'review' && (
        <section className="mt-4 space-y-3 text-sm">
          <ul className="list-disc space-y-1 pl-5">
            {summaryLines.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
          {applyState === 'saving' && (
            <p role="status" aria-busy="true" className="opacity-70">
              Saving your choices…
            </p>
          )}
          {applyState === 'error' && (
            <p role="alert" className="font-semibold">
              Saving failed. Nothing was changed — press Apply to retry.
            </p>
          )}
          <div className="flex gap-2 pt-2">
            <Button onClick={goBack} disabled={applyState === 'saving'}>
              Back
            </Button>
            <Button onClick={() => void finish('skip')} disabled={applyState === 'saving'}>
              Skip — keep my current settings
            </Button>
            <Button
              variant="primary"
              onClick={() => void finish('apply')}
              disabled={applyState === 'saving'}
            >
              {applyState === 'saving' ? 'Applying…' : 'Apply'}
            </Button>
          </div>
        </section>
      )}

      {step === 'ready' && (
        <section className="mt-4 space-y-3 text-sm" role="status">
          <p>
            {applyState === 'idle' && skipState === 'idle' ? draftSavedLabel() : 'Setup finished.'}
          </p>
          <p className="opacity-70">
            You can change any of this later in Settings, including advanced options.
          </p>
          <div className="flex gap-2 pt-2">
            <Button variant="primary" onClick={openYouTube}>
              Open YouTube
            </Button>
            <Button onClick={openOptions}>Review my choices</Button>
          </div>
        </section>
      )}
    </div>
  );
}

function draftSavedLabel(): string {
  return 'Setup finished. Your choices are saved on this device.';
}
