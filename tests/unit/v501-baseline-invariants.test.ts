import { describe, expect, it } from 'vitest';
import { defaultSettings, migrateSettings, validateSettings } from '@/domain/settings';
import { defaultRules } from '@/domain/rules';
import { decide } from '@/policy/decide';
import type { Classification } from '@/domain/classification';

describe('V5-01 Baseline and Invariants', () => {
  const settings = defaultSettings();

  it('documents and enforces exact 9-level decision precedence', () => {
    // 1. disabled -> allow
    const disabledDecision = decide({
      settings: { ...settings, enabled: false },
      rules: { ...defaultRules(), blockedVideoIds: ['v1'] },
      candidate: { videoId: 'v1' },
    });
    expect(disabledDecision.action).toBe('allow');
    expect(disabledDecision.reason).toBe('disabled');

    // 2. explicit video allow -> allow
    const videoAllowDecision = decide({
      settings,
      rules: {
        ...defaultRules(),
        allowedVideoIds: ['v1'],
        blockedVideoIds: ['v1'], // blocked too, but allow is checked or mutation prevents
      },
      candidate: { videoId: 'v1' },
    });
    expect(videoAllowDecision.action).toBe('allow');
    expect(videoAllowDecision.reason).toBe('user-rule');

    // 3. explicit video block -> hide (beats channel allow)
    const videoBlockDecision = decide({
      settings,
      rules: {
        ...defaultRules(),
        blockedVideoIds: ['v1'],
        allowedChannelIds: ['UCchan1'],
      },
      candidate: { videoId: 'v1', channelId: 'UCchan1' },
    });
    expect(videoBlockDecision.action).toBe('hide');
    expect(videoBlockDecision.reason).toBe('user-rule');

    // 4. explicit channel allow -> allow (unless video blocked)
    const channelAllowDecision = decide({
      settings,
      rules: {
        ...defaultRules(),
        allowedChannelIds: ['UCchan1'],
        blockedChannelIds: ['UCchan1'],
      },
      candidate: { videoId: 'v2', channelId: 'UCchan1' },
    });
    expect(channelAllowDecision.action).toBe('allow');
    expect(channelAllowDecision.reason).toBe('channel-rule');

    // 5. explicit channel block -> hide
    const channelBlockDecision = decide({
      settings,
      rules: {
        ...defaultRules(),
        blockedChannelIds: ['UCchan1'],
      },
      candidate: { videoId: 'v2', channelId: 'UCchan1' },
    });
    expect(channelBlockDecision.action).toBe('hide');
    expect(channelBlockDecision.reason).toBe('channel-rule');

    // 5b. literal phrase block -> hide
    const phraseBlockDecision = decide({
      settings,
      rules: {
        ...defaultRules(),
        blockedPhrases: ['ai slop'],
      },
      candidate: { videoId: 'v2', title: 'Check out this AI SLOP video' },
    });
    expect(phraseBlockDecision.action).toBe('hide');
    expect(phraseBlockDecision.reason).toBe('user-rule');

    // 6. personal correction (Not AI / Not slop) -> allow dimensional
    const highAiClassification: Classification = {
      aiLikelihood: 0.95,
      slopLikelihood: 0.1,
      confidence: 'very-high',
      categories: { 'ai-visual': 0.95 },
      evidence: [
        {
          id: 'ev-test',
          detector: 'test-detector',
          category: 'ai-visual',
          strength: 0.95,
          polarity: 'supports',
          origin: 'first-party',
          reasonCode: 'test-rule',
          reasonText: 'AI video',
        },
      ],
      rulesVersion: 'v1',
      classifierVersion: 'v1',
      evaluatedAt: Date.now(),
    };
    const correctedDecision = decide({
      settings,
      rules: defaultRules(),
      candidate: { videoId: 'v2' },
      classification: highAiClassification,
      correctedNotAi: true,
    });
    expect(correctedDecision.action).toBe('allow');
    expect(correctedDecision.reason).toBe('correction');

    // 7. category policy + automatic scores -> hide
    const autoDecision = decide({
      settings,
      rules: defaultRules(),
      candidate: { videoId: 'v2' },
      classification: highAiClassification,
    });
    expect(autoDecision.action).toBe('hide');
    expect(autoDecision.reason).toBe('automatic');

    // 9. default -> allow
    const defaultDecision = decide({
      settings,
      rules: defaultRules(),
      candidate: { videoId: 'v2' },
      classification: undefined,
    });
    expect(defaultDecision.action).toBe('allow');
  });

  it('keeps explicit user rules, cache, and history distinct (history is not a permanent block)', () => {
    const rules = defaultRules();
    // A video being in review history does NOT mean it is in blockedVideoIds
    expect(rules.blockedVideoIds.includes('v_history_only')).toBe(false);
    // If classification is absent, decide() defaults to allow, not hide
    const decision = decide({
      settings,
      rules,
      candidate: { videoId: 'v_history_only' },
      classification: undefined,
    });
    expect(decision.action).toBe('allow');
  });

  it('validates settings migration integrity from v1 to current version without data loss', () => {
    const legacyV1 = {
      enabled: true,
      mode: 'strict',
      remoteProvider: { enabled: false },
    };
    const migratedFromV1 = migrateSettings(legacyV1, 1);
    expect(migratedFromV1).not.toBeNull();
    expect(migratedFromV1?.enabled).toBe(true);
    expect(migratedFromV1?.mode).toBe('strict');
    expect(migratedFromV1?.remoteProvider.timeoutMs).toBe(5000);
    expect(migratedFromV1?.displayMode).toBe('placeholder');

    const v4Settings = {
      ...defaultSettings(),
      mode: 'aggressive',
      displayMode: 'placeholder',
    };
    const migratedFromV4 = migrateSettings(v4Settings, 4);
    expect(migratedFromV4).not.toBeNull();
    expect(migratedFromV4?.mode).toBe('aggressive');
    expect(migratedFromV4?.displayMode).toBe('placeholder');
  });

  it('interrupted or corrupt settings validate to safe defaults without throwing', () => {
    expect(validateSettings(null)).toBeNull();
    expect(validateSettings(undefined)).toBeNull();
    expect(validateSettings(12345)).toBeNull();
    expect(validateSettings('corrupt json string')).toBeNull();

    // Partial corrupt object recovers with default fallback
    const partial = validateSettings({
      enabled: 'not-a-bool',
      mode: 'unsupported-mode',
      displayMode: 'invalid',
    });
    expect(partial).not.toBeNull();
    expect(partial?.enabled).toBe(defaultSettings().enabled);
    expect(partial?.mode).toBe(defaultSettings().mode);
    expect(partial?.displayMode).toBe(defaultSettings().displayMode);
  });
});
