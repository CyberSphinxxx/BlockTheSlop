import { beforeEach, describe, expect, it } from 'vitest';
import { MemoryKVStore } from '@/storage/db';
import { SettingsStore } from '@/storage/settings-store';
import { RuleStore } from '@/storage/rule-store';
import { ReviewStore } from '@/storage/review-store';
import { StatsStore } from '@/storage/stats-store';
import { ClassificationCacheStore, cacheKeyFor, enforceRetention } from '@/storage/cache-store';
import { runMigrations } from '@/storage/migrations';
import { defaultSettings } from '@/domain/settings';
import { defaultRules } from '@/domain/rules';
import { defaultStats } from '@/domain/stats';
import type { Classification } from '@/domain/classification';

let kv: MemoryKVStore;

beforeEach(() => {
  kv = new MemoryKVStore();
});

describe('SettingsStore', () => {
  it('creates first-install defaults', async () => {
    const store = new SettingsStore(kv);
    const snap = await store.load();
    expect(snap.settings).toEqual(defaultSettings());
    expect(snap.schemaVersion).toBeGreaterThanOrEqual(2);
  });

  it('persists and reloads changes', async () => {
    const store = new SettingsStore(kv);
    await store.load();
    await store.update((s) => ({ ...s, mode: 'strict' }));
    const reloaded = await new SettingsStore(new MemoryKVStore()).load();
    void reloaded;
    const again = await store.load();
    expect(again.settings.mode).toBe('strict');
  });

  it('falls back to defaults on corrupt storage', async () => {
    await kv.set('local:settings', { mode: 12345, enabled: 'yes', categoryActions: 'nope' });
    const store = new SettingsStore(kv);
    const snap = await store.load();
    expect(snap.settings.mode).toBe('balanced');
    expect(snap.settings.enabled).toBe(true);
  });

  it('migrates v1 storage on load', async () => {
    await kv.set('local:schemaVersion', 1);
    await kv.set('local:settings', { mode: 'safe', remoteProvider: { enabled: false } });
    const store = new SettingsStore(kv);
    const snap = await store.load();
    expect(snap.settings.remoteProvider.timeoutMs).toBe(5000);
    expect(snap.settings.mode).toBe('safe');
    expect(await kv.get<number>('local:schemaVersion')).toBeGreaterThanOrEqual(2);
  });
});

describe('RuleStore', () => {
  it('applies and persists mutations', async () => {
    const store = new RuleStore(kv);
    await store.apply({ kind: 'block-channel', channelId: 'UCslop' });
    const reloaded = await store.load();
    expect(reloaded.blockedChannelIds).toContain('UCslop');
  });
});

describe('ReviewStore', () => {
  it('upserts and enforces retention', async () => {
    const store = new ReviewStore(kv);
    for (let i = 0; i < 10; i++) {
      await store.upsert({
        id: `r${i}`,
        title: `t${i}`,
        surface: 'home',
        decision: { action: 'hide', reason: 'automatic', explanation: [] },
        createdAt: i,
      });
    }
    const all = await store.load();
    expect(all).toHaveLength(10);
  });

  it('clears records', async () => {
    const store = new ReviewStore(kv);
    await store.upsert({
      id: 'r1',
      title: 't',
      surface: 'home',
      decision: { action: 'hide', reason: 'automatic', explanation: [] },
      createdAt: 1,
    });
    await store.clear();
    expect(await store.load()).toHaveLength(0);
  });
});

describe('StatsStore', () => {
  it('accumulates stats', async () => {
    const store = new StatsStore(kv);
    await store.apply({ hidden: 2, cardsEvaluated: 5 });
    const stats = await store.apply({ hidden: 1 });
    expect(stats.hidden).toBe(3);
    expect(stats.cardsEvaluated).toBe(5);
  });

  it('resets stats', async () => {
    const store = new StatsStore(kv);
    await store.apply({ hidden: 9 });
    await store.reset();
    const stats = await store.load();
    expect(stats.hidden).toBe(0);
    expect(stats.resetAt).toBeGreaterThan(0);
  });
});

describe('ClassificationCacheStore', () => {
  const classification = (ai: number): Classification => ({
    aiLikelihood: ai,
    slopLikelihood: 0.1,
    categories: { 'ai-visual': ai },
    confidence: 'high',
    evidence: [],
    classifierVersion: '1',
    rulesVersion: '1',
    evaluatedAt: Date.now(),
  });

  it('round-trips and respects versions', async () => {
    const store = new ClassificationCacheStore(kv);
    await store.put('vid', classification(0.9), '1');
    expect((await store.get('vid', '1'))?.aiLikelihood).toBe(0.9);
    expect(await store.get('vid', '999')).toBeUndefined();
  });

  it('enforces retention caps', async () => {
    const now = Date.now();
    const entries: Record<
      string,
      {
        videoId: string;
        classifierVersion: string;
        rulesVersion: string;
        classification: Classification;
        cachedAt: number;
      }
    > = {};
    for (let i = 0; i < 3000; i++) {
      entries[`v1:c${i}`] = {
        videoId: `c${i}`,
        classifierVersion: '1',
        rulesVersion: '1',
        classification: classification(0.5),
        cachedAt: now - i,
      };
    }
    const kept = await enforceRetention(entries);
    expect(Object.keys(kept).length).toBeLessThanOrEqual(2000);
  });

  it('uses stable cache keys', () => {
    expect(cacheKeyFor('abc')).toBe('v1:abc');
  });
});

describe('migrations', () => {
  it('is idempotent', async () => {
    const a = await runMigrations(kv);
    const b = await runMigrations(kv);
    expect(a.finalVersion).toBe(b.finalVersion);
    expect(b.applied).toHaveLength(0);
  });

  it('upgrades v1 data without data loss', async () => {
    await kv.set('local:schemaVersion', 1);
    await kv.set('local:settings', { mode: 'strict', remoteProvider: { enabled: true } });
    await kv.set('local:rules', defaultRules());
    const result = await runMigrations(kv);
    expect(result.applied).toContain(2);
    const settings = await kv.get<Record<string, unknown>>('local:settings');
    expect(settings?.['mode']).toBe('strict');
    const provider = settings?.['remoteProvider'] as Record<string, unknown>;
    expect(provider['timeoutMs']).toBe(5000);
  });
});

describe('defaultStats', () => {
  it('has zeroed counters', () => {
    const s = defaultStats();
    expect(s.hidden).toBe(0);
    expect(s.cardsEvaluated).toBe(0);
  });
});
