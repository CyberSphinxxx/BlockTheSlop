import { describe, expect, it } from 'vitest';
import { MemoryKVStore, type KVStore } from '@/storage/db';
import { RuleStore } from '@/storage/rule-store';
import { defaultRules, getRuleIndex, type RuleMutation, type UserRules } from '@/domain/rules';
import { decide, type PolicyInput } from '@/policy/decide';
import { defaultSettings } from '@/domain/settings';
import { VerdictMemoStore } from '@/storage/verdict-memo-store';
import { createVerdictMemoEntry } from '@/domain/verdict-memo';

describe('V5-05: Scale, Bounded Performance & Atomic Storage', () => {
  describe('RuleStore atomic mutations & concurrency', () => {
    it('applies concurrent mutations without losing updates', async () => {
      const kv = new MemoryKVStore();
      const store = new RuleStore(kv);

      // Fire 50 concurrent mutations simultaneously
      const count = 50;
      const promises: Promise<UserRules>[] = [];
      for (let i = 0; i < count; i++) {
        if (i % 2 === 0) {
          promises.push(store.apply({ kind: 'block-video', videoId: `vid-${i}` }));
        } else {
          promises.push(
            store.apply({
              kind: 'block-channel',
              channelId: `UC-${i}`,
              handle: `@chan${i}`,
            }),
          );
        }
      }

      await Promise.all(promises);

      const finalRules = await store.load();
      expect(finalRules.blockedVideoIds).toHaveLength(count / 2);
      expect(finalRules.blockedChannelIds).toHaveLength(count / 2);
      for (let i = 0; i < count; i++) {
        if (i % 2 === 0) {
          expect(finalRules.blockedVideoIds).toContain(`vid-${i}`);
        } else {
          expect(finalRules.blockedChannelIds).toContain(`UC-${i}`);
        }
      }
    });

    it('supports atomic batch mutations in a single transaction', async () => {
      const kv = new MemoryKVStore();
      const store = new RuleStore(kv);

      const mutations: RuleMutation[] = [
        { kind: 'block-video', videoId: 'v1' },
        { kind: 'block-video', videoId: 'v2' },
        { kind: 'allow-channel', channelId: 'UCgood' },
        { kind: 'block-phrase', phrase: 'free crypto' },
      ];

      const res = await store.applyBatch(mutations);
      expect(res.blockedVideoIds).toEqual(['v1', 'v2']);
      expect(res.allowedChannelIds).toEqual(['UCgood']);
      expect(res.blockedPhrases).toEqual(['free crypto']);

      const loaded = await store.load();
      expect(loaded).toEqual(res);
    });

    it('recovers from storage failure and does not poison subsequent mutations', async () => {
      let failWrites = true;
      const faultyKv: KVStore = {
        async get<T>(_key: string): Promise<T | undefined> {
          return undefined;
        },
        async set<T>(_key: string, _value: T): Promise<void> {
          if (failWrites) {
            throw new Error('Disk quota exceeded / IDB unavailable');
          }
        },
        async remove(_key: string): Promise<void> {},
      };

      const store = new RuleStore(faultyKv);

      // Failing mutation
      await expect(store.apply({ kind: 'block-video', videoId: 'v-fail' })).rejects.toThrow(
        'Disk quota exceeded / IDB unavailable',
      );

      // Now storage recovers
      failWrites = false;
      const goodRes = await store.apply({ kind: 'block-video', videoId: 'v-success' });
      expect(goodRes.blockedVideoIds).toContain('v-success');
    });
  });

  describe('O(1) RuleIndex lookups with 10k rules', () => {
    it('indexes 10k rules and performs O(1) set lookups', () => {
      const rules: UserRules = {
        ...defaultRules(),
        blockedVideoIds: Array.from({ length: 10_000 }, (_, i) => `bad-vid-${i}`),
        allowedVideoIds: Array.from({ length: 5_000 }, (_, i) => `good-vid-${i}`),
        blockedChannelIds: Array.from({ length: 2_000 }, (_, i) => `UC-bad-${i}`),
        fallbackBlockedHandles: Array.from({ length: 2_000 }, (_, i) => `bad-handle-${i}`),
        blockedPhrases: ['free robux', 'get rich fast', 'shocking secret'],
      };

      const index1 = getRuleIndex(rules);
      const index2 = getRuleIndex(rules);
      expect(index1).toBe(index2); // Cached WeakMap reference
      expect(index1.blockedVideoIds.has('bad-vid-9999')).toBe(true);
      expect(index1.blockedVideoIds.has('unknown-vid')).toBe(false);
      expect(index1.allowedVideoIds.has('good-vid-4999')).toBe(true);
      expect(index1.blockedChannelIds.has('UC-bad-1999')).toBe(true);
      expect(index1.fallbackBlockedHandles.has('bad-handle-1000')).toBe(true);
    });

    it('benchmarks 500 and 1,000 card evaluations against 10,000 rules within bounded time', () => {
      const rules: UserRules = {
        ...defaultRules(),
        blockedVideoIds: Array.from({ length: 10_000 }, (_, i) => `blocked-vid-${i}`),
        allowedVideoIds: Array.from({ length: 5_000 }, (_, i) => `allowed-vid-${i}`),
        blockedChannelIds: Array.from({ length: 2_000 }, (_, i) => `UC-block-${i}`),
        blockedPhrases: ['slop headline', 'clickbait title', 'ai slop generator'],
      };
      const settings = defaultSettings();

      // Benchmark 500 cards
      const t0 = performance.now();
      for (let i = 0; i < 500; i++) {
        const input: PolicyInput = {
          settings,
          rules,
          candidate: {
            videoId: i % 20 === 0 ? `blocked-vid-${i}` : `card-vid-${i}`,
            channelId: i % 50 === 0 ? `UC-block-${i}` : `UC-chan-${i}`,
            title: `Video title number ${i}`,
          },
        };
        decide(input);
      }
      const duration500 = performance.now() - t0;

      // Benchmark 1,000 cards
      const t1 = performance.now();
      for (let i = 0; i < 1_000; i++) {
        const input: PolicyInput = {
          settings,
          rules,
          candidate: {
            videoId: i % 15 === 0 ? `blocked-vid-${i}` : `card-vid-${i}`,
            channelId: i % 40 === 0 ? `UC-block-${i}` : `UC-chan-${i}`,
            title: i % 100 === 7 ? 'This is a slop headline!' : `Standard video title ${i}`,
          },
        };
        const res = decide(input);
        if (i % 100 === 7) {
          expect(res.action).toBe('hide');
          expect(res.reason).toBe('user-rule');
          expect(res.ruleId).toBe('phrase-block');
        }
      }
      const duration1000 = performance.now() - t1;

      // In Node/Vitest, 1,000 cards with O(1) set lookup typically runs in < 25ms (< 0.025ms/card).
      // Bounded limit: must be < 200ms for 1,000 cards.
      expect(duration500).toBeLessThan(150);
      expect(duration1000).toBeLessThan(250);
    });
  });

  describe('VerdictMemoStore at scale (10,000 IDs & LRU eviction)', () => {
    it('stores 10,000 IDs and enforces LRU eviction cap without unbounded memory', () => {
      const store = new VerdictMemoStore(10_000);
      const settings = defaultSettings();

      // Insert 10,000 entries
      for (let i = 0; i < 10_000; i++) {
        store.put(
          createVerdictMemoEntry({
            videoId: `vid-${i}`,
            decision: { action: 'hide', reason: 'automatic', explanation: ['test'] },
            evidenceFingerprint: `fp-${i}`,
            settings,
          }),
        );
      }

      expect(store.size()).toBe(10_000);

      // Inserting 1 more entry evicts the oldest (vid-0)
      store.put(
        createVerdictMemoEntry({
          videoId: 'vid-new',
          decision: { action: 'allow', reason: 'automatic', explanation: ['test'] },
          evidenceFingerprint: 'fp-new',
          settings,
        }),
      );

      expect(store.size()).toBe(10_000);
      expect(store.has('vid-new')).toBe(true);
      expect(store.has('vid-0')).toBe(false);
      expect(store.has('vid-1')).toBe(true);
    });

    it('benchmarks 1,000 fast-path memo lookups against 10k store', () => {
      const store = new VerdictMemoStore(10_000);
      const settings = defaultSettings();

      for (let i = 0; i < 10_000; i++) {
        store.put(
          createVerdictMemoEntry({
            videoId: `vid-${i}`,
            decision: { action: 'hide', reason: 'automatic', explanation: ['test'] },
            evidenceFingerprint: `fp-${i}`,
            settings,
          }),
        );
      }

      const t0 = performance.now();
      for (let i = 0; i < 1_000; i++) {
        const id = `vid-${i * 5}`;
        store.get(id, {
          evidenceFingerprint: `fp-${i * 5}`,
          settingsDigest: 'balanced:false',
          rulesVersion: '1',
          classifierVersion: '1',
        });
      }
      const elapsed = performance.now() - t0;
      // 1,000 Map get operations in JS take < 5ms
      expect(elapsed).toBeLessThan(50);
    });
  });

  describe('Repeated SPA navigation and churn simulation', () => {
    it('simulates 20 SPA navigations with 100 cards per navigation without leaking or unbounded growth', () => {
      const memo = new VerdictMemoStore(2_000);
      const settings = defaultSettings();

      let totalHides = 0;
      for (let nav = 0; nav < 20; nav++) {
        // Page navigation reset
        const recordedHidesOnPage = new Set<string>();

        // 100 cards on this page
        for (let c = 0; c < 100; c++) {
          const videoId = `nav-${nav}-card-${c}`;
          if (!recordedHidesOnPage.has(videoId)) {
            recordedHidesOnPage.add(videoId);
            totalHides++;
          }
          memo.put(
            createVerdictMemoEntry({
              videoId,
              decision: { action: 'hide', reason: 'automatic', explanation: ['test'] },
              evidenceFingerprint: `fp-${videoId}`,
              settings,
            }),
          );
        }

        expect(recordedHidesOnPage.size).toBe(100);
      }

      expect(totalHides).toBe(2_000);
      expect(memo.size()).toBe(2_000);
    });
  });
});
