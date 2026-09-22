import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import {
  HISTORY_RETENTION_MAX_DAYS,
  HISTORY_RETENTION_MIN_DAYS,
  SETTINGS_SCHEMA_VERSION,
  defaultSettings,
  migrateSettings,
  validateSettings,
} from '@/domain/settings';
import {
  applyRuleMutation,
  defaultRules,
  normalizeFallbackHandle,
  validateRules,
} from '@/domain/rules';
import { decide } from '@/policy/decide';
import { HistoryRepository } from '@/storage/history-repository';
import { CorrectionStore } from '@/storage/correction-store';
import { openExtensionDb } from '@/storage/idb-schema';
import type { FilterDecision } from '@/domain/decision';

// ---- CFG-01: validation + migration of every v5 field ----

describe('CFG-01 settings schema v5', () => {
  it('defaults: history on with 30d retention, comfortable, system, fil pack on', () => {
    const s = defaultSettings();
    expect(s.history).toEqual({ enabled: true, retentionDays: 30 });
    expect(s.density).toBe('comfortable');
    expect(s.theme).toBe('system');
    expect(s.rulePacks).toEqual({ fil: true });
    expect(SETTINGS_SCHEMA_VERSION).toBe(5);
  });

  it('persists and round-trips every new field through validation', () => {
    const s = defaultSettings();
    const modified = validateSettings({
      ...s,
      history: { enabled: false, retentionDays: 90 },
      density: 'compact',
      theme: 'dark',
      rulePacks: { fil: false },
    });
    expect(modified).not.toBeNull();
    expect(modified?.history).toEqual({ enabled: false, retentionDays: 90 });
    expect(modified?.density).toBe('compact');
    expect(modified?.theme).toBe('dark');
    expect(modified?.rulePacks).toEqual({ fil: false });
  });

  it('clamps corrupt retention values into the documented bounds', () => {
    const s = validateSettings({
      ...defaultSettings(),
      history: { enabled: true, retentionDays: 0 },
    });
    expect(s?.history.retentionDays).toBeGreaterThanOrEqual(HISTORY_RETENTION_MIN_DAYS);
    const s2 = validateSettings({
      ...defaultSettings(),
      history: { enabled: true, retentionDays: 100_000 },
    });
    expect(s2?.history.retentionDays).toBeLessThanOrEqual(HISTORY_RETENTION_MAX_DAYS);
    const s3 = validateSettings({
      ...defaultSettings(),
      history: { enabled: true, retentionDays: 'many' },
    });
    expect(s3?.history.retentionDays).toBe(30);
  });

  it('migrates v4 settings losing nothing', () => {
    const v4 = {
      ...defaultSettings(),
      history: undefined,
      density: undefined,
      theme: undefined,
      rulePacks: undefined,
    };
    const migrated = migrateSettings(v4, 4);
    expect(migrated).not.toBeNull();
    expect(migrated?.history.enabled).toBe(true);
    expect(migrated?.density).toBe('comfortable');
    expect(migrated?.theme).toBe('system');
    expect(migrated?.mode).toBe(defaultSettings().mode);
    expect(migrated?.categoryActions).toEqual(defaultSettings().categoryActions);
  });
});

const hideDecision: FilterDecision = {
  action: 'hide',
  reason: 'automatic',
  explanation: ['x'],
};

// ---- CFG-05: literal phrase rules ----

describe('CFG-05 phrase rules', () => {
  const settings = defaultSettings();

  it('mutation adds, dedupes, and removes phrases (case-insensitive check at UI, exact here)', () => {
    let rules = applyRuleMutation(defaultRules(), { kind: 'block-phrase', phrase: '  ai slop  ' });
    expect(rules.blockedPhrases).toEqual(['ai slop']);
    rules = applyRuleMutation(rules, { kind: 'block-phrase', phrase: 'compilation' });
    expect(rules.blockedPhrases).toEqual(['ai slop', 'compilation']);
    rules = applyRuleMutation(rules, { kind: 'unblock-phrase', phrase: 'ai slop' });
    expect(rules.blockedPhrases).toEqual(['compilation']);
    // Empty phrase is a no-op, never a poison entry.
    rules = applyRuleMutation(rules, { kind: 'block-phrase', phrase: '   ' });
    expect(rules.blockedPhrases).toEqual(['compilation']);
  });

  it('validation keeps phrase lists bounded and clean', () => {
    const rules = validateRules({
      ...defaultRules(),
      blockedPhrases: ['ok', 42, '', 'ok', 'x'.repeat(600)],
    });
    expect(rules?.blockedPhrases).toEqual(['ok', 'x'.repeat(256)]);
  });

  it('hides by title phrase with reason user-rule', () => {
    const decision = decide({
      settings,
      rules: applyRuleMutation(defaultRules(), { kind: 'block-phrase', phrase: 'ai generated' }),
      candidate: { videoId: 'v1', title: 'The BEST AI Generated Art of 2026' },
      classification: undefined,
    });
    expect(decision.action).toBe('hide');
    expect(decision.reason).toBe('user-rule');
    expect(decision.ruleId).toBe('phrase-block');
    expect(decision.explanation[0]).toContain('ai generated');
  });

  it('matching is case-insensitive and literal (regex metacharacters are inert)', () => {
    const rules = applyRuleMutation(defaultRules(), {
      kind: 'block-phrase',
      phrase: '(a|i).*slop',
    });
    const decision = decide({
      settings,
      rules,
      candidate: { videoId: 'v1', title: 'totally innocent video (a|i).*slop' },
      classification: undefined,
    });
    expect(decision.action).toBe('hide');
    const clean = decide({
      settings,
      rules,
      candidate: { videoId: 'v1', title: 'aislop without the literal pattern' },
      classification: undefined,
    });
    expect(clean.action).toBe('allow');
  });

  it('explicit allow and channel allow still beat phrase rules; corrections do not', () => {
    const phraseRules = applyRuleMutation(defaultRules(), { kind: 'block-phrase', phrase: 'slop' });
    const allow = decide({
      settings,
      rules: {
        ...phraseRules,
        allowedVideoIds: ['v1'],
      },
      candidate: { videoId: 'v1', title: 'slop title' },
      classification: undefined,
    });
    expect(allow.action).toBe('allow');

    const chanAllow = decide({
      settings,
      rules: { ...phraseRules, allowedChannelIds: ['UCSafe'] },
      candidate: { videoId: 'v1', channelId: 'UCSafe', title: 'slop title' },
      classification: undefined,
    });
    expect(chanAllow.action).toBe('allow');

    // Personal correction does NOT override a deliberate phrase rule.
    const corrected = decide({
      settings,
      rules: phraseRules,
      candidate: { videoId: 'v1', title: 'slop title' },
      classification: undefined,
      correctedNotAi: true,
      correctedNotSlop: true,
    });
    expect(corrected.action).toBe('hide');
    expect(corrected.reason).toBe('user-rule');
  });

  it('empty title or no phrases never matches', () => {
    const decision = decide({
      settings,
      rules: applyRuleMutation(defaultRules(), { kind: 'block-phrase', phrase: 'slop' }),
      candidate: { videoId: 'v1' },
      classification: undefined,
    });
    expect(decision.action).toBe('allow');
  });
});

// ---- DATA-07: retention boundaries ----

describe('DATA-07 retention', () => {
  let history: HistoryRepository;
  let db: Awaited<ReturnType<typeof openExtensionDb>>;

  beforeEach(async () => {
    db = await openExtensionDb();
    history = new HistoryRepository(db);
  });

  afterEach(() => {
    db.close();
    // Separate databases per test avoid cross-test index/state bleed.
    Object.defineProperty(globalThis, 'indexedDB', {
      value: new IDBFactory(),
      configurable: true,
      writable: true,
    });
  });

  async function seed(key: string, lastSeen: number): Promise<void> {
    await history.recordHidden({
      key,
      videoId: key.slice(2),
      title: key,
      surface: 'home',
      decision: hideDecision,
      occurredAt: lastSeen,
      operationId: `op-${key}-${lastSeen}`,
    });
  }

  it('age retention drops summaries older than the boundary, keeps newer and future-skewed', async () => {
    const now = 1_800_000_000_000;
    const day = 24 * 60 * 60 * 1000;
    await seed('v:old', now - 40 * day);
    await seed('v:edge', now - 30 * day); // exactly at boundary: kept
    await seed('v:new', now - 1 * day);
    await seed('v:future', now + day); // clock skew: never pruned

    const removed = await history.enforceAgeRetention(30, now);
    // Boundary is EXCLUSIVE (lastSeen < cutoff pruned); 30-day-old edge stays.
    expect(removed).toBe(1);
    expect(await history.getSummary('v:old')).toBeUndefined();
    expect(await history.getSummary('v:edge')).toBeDefined();
    expect(await history.getSummary('v:new')).toBeDefined();
    expect(await history.getSummary('v:future')).toBeDefined();
  });

  it('age retention also removes the victim events (cascade)', async () => {
    const now = Date.now();
    await seed('v:ancient', now - 400 * 24 * 60 * 60 * 1000);
    await history.enforceAgeRetention(365, now);
    const events = await history.eventsFor('v:ancient', 10);
    expect(events).toEqual([]);
  });

  it('cap retention still applies independently of age retention', async () => {
    for (let i = 0; i < 6; i++) {
      await seed(`v:cap${i}`, Date.now() - i * 1000);
    }
    const removed = await history.enforceSummariesRetention(3);
    expect(removed).toBe(3);
    expect(await history.countSummaries()).toBe(3);
  });
});

// ---- DATA-08: separate data-class clears ----

describe('DATA-08 separate data clears', () => {
  let history: HistoryRepository;
  let corrections: CorrectionStore;
  let db: Awaited<ReturnType<typeof openExtensionDb>>;

  beforeEach(async () => {
    db = await openExtensionDb();
    history = new HistoryRepository(db);
    corrections = new CorrectionStore(db);
  });

  afterEach(() => {
    db.close();
    Object.defineProperty(globalThis, 'indexedDB', {
      value: new IDBFactory(),
      configurable: true,
      writable: true,
    });
  });

  it('clearing history keeps corrections; clearing corrections keeps history', async () => {
    await history.recordHidden({
      key: 'v:keep1',
      videoId: 'keep1',
      title: 't',
      surface: 'home',
      decision: hideDecision,
      occurredAt: Date.now(),
      operationId: 'op-h1',
    });
    await corrections.setDimension('keep1', 'notAi', true);

    await history.clearHistory();
    expect(await history.countSummaries()).toBe(0);
    expect((await corrections.get('keep1'))?.notAi).toBe(true);

    await history.recordHidden({
      key: 'v:keep2',
      videoId: 'keep2',
      title: 't',
      surface: 'home',
      decision: hideDecision,
      occurredAt: Date.now(),
      operationId: 'op-h2',
    });
    await corrections.clearAll();
    expect(await history.countSummaries()).toBe(1);
    expect(await corrections.get('keep1')).toBeUndefined();
  });
});

// ---- CFG-06: identity normalization (part of rule editor) ----

describe('CFG-06 identity normalization', () => {
  it('handles are normalized (at-sign stripped, lowercased)', () => {
    expect(normalizeFallbackHandle('@SomeChannel')).toBe('somechannel');
    expect(normalizeFallbackHandle('@@x')).toBe('x');
  });

  it('channel-block-by-handle stores the fallback handle', () => {
    const rules = applyRuleMutation(defaultRules(), {
      kind: 'block-channel-by-handle',
      handle: '@SlopFactory',
    });
    expect(rules.fallbackBlockedHandles).toEqual(['slopfactory']);
  });
});
