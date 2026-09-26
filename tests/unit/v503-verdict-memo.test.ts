import { describe, expect, it, beforeEach } from 'vitest';
import {
  type VerdictMemoEntry,
  computeSettingsDigest,
  createVerdictMemoEntry,
  isVerdictMemoValid,
  VERDICT_MEMO_TTL_MS,
} from '@/domain/verdict-memo';
import { VerdictMemoStore } from '@/storage/verdict-memo-store';
import { defaultSettings, type UserSettings } from '@/domain/settings';
import { defaultRules, type UserRules } from '@/domain/rules';
import { decide } from '@/policy/decide';
import { CLASSIFIER_VERSION, RULES_VERSION } from '@/domain/versions';
import { classificationFingerprint, type FingerprintInput } from '@/storage/fingerprint';
import type { FilterDecision } from '@/domain/decision';
import type { Classification } from '@/domain/classification';

describe('V5-03: Three-Tier Remembered-Video Model & Verdict Memo', () => {
  let settings: UserSettings;
  let rules: UserRules;

  beforeEach(() => {
    settings = defaultSettings();
    rules = defaultRules();
  });

  const baseInput: FingerprintInput = {
    videoId: 'v_repeat1',
    title: 'Repeat AI Video',
    description: 'Generated with Midjourney and Runway',
    badges: ['AI-generated'],
    ariaLabels: [],
    metadataText: ['100K views'],
    officialDisclosurePresent: true,
    isShort: false,
    locale: 'en',
  };

  const hideDecision: FilterDecision = {
    action: 'hide',
    reason: 'automatic',
    explanation: ['Creator declared synthetic media'],
    classifierVersion: CLASSIFIER_VERSION,
    rulesVersion: RULES_VERSION,
  };

  it('Tier separation: explicit rules (Tier 1) win over memo (Tier 2) and review history (Tier 3)', () => {
    const memoStore = new VerdictMemoStore();
    const fp = classificationFingerprint(baseInput);

    // Populate Tier 2 memo with a hide verdict
    const entry = createVerdictMemoEntry({
      videoId: 'v_repeat1',
      decision: hideDecision,
      evidenceFingerprint: fp,
      settings,
    });
    memoStore.put(entry);

    // If user adds an explicit allow rule (Tier 1):
    const allowedRules: UserRules = {
      ...rules,
      allowedVideoIds: ['v_repeat1'],
    };

    // Decision precedence: explicit rule evaluated at Tier 1 returns allow
    const decision = decide({
      settings,
      rules: allowedRules,
      candidate: { videoId: 'v_repeat1', title: 'Repeat AI Video' },
    });
    expect(decision.action).toBe('allow');
    expect(decision.reason).toBe('user-rule');

    // Invalidate memo for rule updates:
    memoStore.invalidateForRules(allowedRules);
    expect(
      memoStore.get('v_repeat1', {
        evidenceFingerprint: fp,
        settingsDigest: computeSettingsDigest(settings),
      }),
    ).toBeUndefined();
  });

  it('Tier separation: review history (Tier 3) is not a permanent block rule', () => {
    // A video recorded in history with resolution: 'pending' does not automatically block
    // without an explicit rule or a valid current-policy verdict.
    const cleanRules = defaultRules();
    const neutralClassification: Classification = {
      aiLikelihood: 0.1,
      slopLikelihood: 0.1,
      categories: {},
      confidence: 'low',
      evidence: [],
      classifierVersion: CLASSIFIER_VERSION,
      rulesVersion: RULES_VERSION,
      evaluatedAt: Date.now(),
    };

    const decision = decide({
      settings,
      rules: cleanRules,
      candidate: { videoId: 'v_history_only', title: 'Human Video' },
      classification: neutralClassification,
    });
    // Even if this video existed in Review History, decide() returns allow:
    expect(decision.action).toBe('allow');
  });

  it('Fast-path: valid memo hit matches identity, evidence fingerprint, versions, and settings digest', () => {
    const memoStore = new VerdictMemoStore();
    const fp = classificationFingerprint(baseInput);
    const digest = computeSettingsDigest(settings);

    memoStore.put(
      createVerdictMemoEntry({
        videoId: 'v_repeat1',
        decision: hideDecision,
        evidenceFingerprint: fp,
        settings,
      }),
    );

    const hit = memoStore.get('v_repeat1', {
      evidenceFingerprint: fp,
      settingsDigest: digest,
    });

    expect(hit).toBeDefined();
    expect(hit?.action).toBe('hide');
    expect(hit?.reason).toBe('automatic');
  });

  it('Hydration sensitivity: changes in observed evidence change fingerprint and miss memo', () => {
    const memoStore = new VerdictMemoStore();
    const unhydratedInput: FingerprintInput = {
      ...baseInput,
      description: undefined,
      badges: [],
      officialDisclosurePresent: false,
    };
    const unhydratedFp = classificationFingerprint(unhydratedInput);
    const digest = computeSettingsDigest(settings);

    // Initial memo recorded before card was hydrated
    memoStore.put(
      createVerdictMemoEntry({
        videoId: 'v_repeat1',
        decision: { action: 'allow', reason: 'automatic', explanation: [] },
        evidenceFingerprint: unhydratedFp,
        settings,
      }),
    );

    // Once card hydrates with badges/description, fingerprint changes:
    const hydratedFp = classificationFingerprint(baseInput);
    expect(hydratedFp).not.toBe(unhydratedFp);

    // Lookup with hydrated fingerprint must MISS, allowing normal re-evaluation
    const hit = memoStore.get('v_repeat1', {
      evidenceFingerprint: hydratedFp,
      settingsDigest: digest,
    });
    expect(hit).toBeUndefined();
  });

  it('Settings change invalidates memo via settings digest mismatch', () => {
    const memoStore = new VerdictMemoStore();
    const fp = classificationFingerprint(baseInput);
    const originalDigest = computeSettingsDigest(settings);

    memoStore.put(
      createVerdictMemoEntry({
        videoId: 'v_repeat1',
        decision: hideDecision,
        evidenceFingerprint: fp,
        settings,
      }),
    );

    // User changes mode from 'balanced' to 'strict'
    const changedSettings: UserSettings = {
      ...settings,
      mode: 'strict',
    };
    const changedDigest = computeSettingsDigest(changedSettings);
    expect(changedDigest).not.toBe(originalDigest);

    const hit = memoStore.get('v_repeat1', {
      evidenceFingerprint: fp,
      settingsDigest: changedDigest,
    });
    expect(hit).toBeUndefined();
  });

  it('Classifier and rules version updates invalidate memo entries', () => {
    const fp = classificationFingerprint(baseInput);
    const digest = computeSettingsDigest(settings);
    const now = Date.now();

    const entry: VerdictMemoEntry = {
      videoId: 'v_repeat1',
      action: 'hide',
      reason: 'automatic',
      evidenceFingerprint: fp,
      classifierVersion: '0-old',
      rulesVersion: RULES_VERSION,
      settingsDigest: digest,
      createdAt: now,
      expiresAt: now + VERDICT_MEMO_TTL_MS,
    };

    expect(
      isVerdictMemoValid(entry, { evidenceFingerprint: fp, settingsDigest: digest, now }),
    ).toBe(false);

    const entryOldRules: VerdictMemoEntry = {
      ...entry,
      classifierVersion: CLASSIFIER_VERSION,
      rulesVersion: 'old-rules',
    };
    expect(
      isVerdictMemoValid(entryOldRules, { evidenceFingerprint: fp, settingsDigest: digest, now }),
    ).toBe(false);
  });

  it('TTL expiry invalidates and purges memo entries', () => {
    const memoStore = new VerdictMemoStore();
    const fp = classificationFingerprint(baseInput);
    const digest = computeSettingsDigest(settings);
    const t0 = 1000;

    memoStore.put(
      createVerdictMemoEntry({
        videoId: 'v_expired',
        decision: hideDecision,
        evidenceFingerprint: fp,
        settings,
        now: t0,
        ttlMs: 5000,
      }),
    );

    // Before expiry:
    expect(
      memoStore.get('v_expired', {
        evidenceFingerprint: fp,
        settingsDigest: digest,
        now: t0 + 1000,
      }),
    ).toBeDefined();

    // After expiry:
    expect(
      memoStore.get('v_expired', {
        evidenceFingerprint: fp,
        settingsDigest: digest,
        now: t0 + 6000,
      }),
    ).toBeUndefined();
  });

  it('Correction invalidation: older false hides must not survive a Not AI correction', () => {
    const memoStore = new VerdictMemoStore();
    const fp = classificationFingerprint(baseInput);
    const digest = computeSettingsDigest(settings);

    memoStore.put(
      createVerdictMemoEntry({
        videoId: 'v_false_positive',
        decision: hideDecision,
        evidenceFingerprint: fp,
        settings,
      }),
    );

    // Explicit invalidation for correction
    memoStore.invalidateForCorrection('v_false_positive');
    expect(
      memoStore.get('v_false_positive', {
        evidenceFingerprint: fp,
        settingsDigest: digest,
      }),
    ).toBeUndefined();

    // Even if raw entry is checked with active correction signal:
    const lingeringEntry = createVerdictMemoEntry({
      videoId: 'v_false_positive',
      decision: hideDecision,
      evidenceFingerprint: fp,
      settings,
    });
    const validWithCorrection = isVerdictMemoValid(lingeringEntry, {
      evidenceFingerprint: fp,
      settingsDigest: digest,
      corrections: { notAi: true, notSlop: false },
    });
    expect(validWithCorrection).toBe(false);
  });
});
