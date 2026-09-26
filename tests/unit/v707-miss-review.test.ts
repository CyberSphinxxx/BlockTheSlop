import { beforeEach, describe, expect, it } from 'vitest';
import {
  MISS_REASONS,
  MAX_MISS_REVIEW_ENTRIES,
  classifyMiss,
  pruneMissEntries,
  serializeMissEntries,
  upsertMissEntry,
  type MissReviewEntry,
} from '@/domain/miss-review';
import { MissReviewStore } from '@/storage/miss-review-store';
import { MemoryKVStore } from '@/storage/db';
import { defaultSettings, type UserSettings } from '@/domain/settings';
import type { Classification } from '@/domain/classification';
import type { FilterDecision } from '@/domain/decision';
import type { NormalizedVideoCandidate, Surface } from '@/domain/video';

/**
 * V7-07: bounded local miss-review queue.
 *
 * A manual "this is AI" mark is a DIAGNOSTIC, never training data: it must
 * not change detection, promote channels, or touch the network. The queue
 * records WHY the automatic filter did not hide the video, dedupes repeated
 * sightings of the same video, stays bounded, and exports only on explicit
 * user action.
 */

function classification(partial: Partial<Classification>): Classification {
  return {
    aiLikelihood: 0.1,
    slopLikelihood: 0.05,
    confidence: 'low',
    categories: {},
    evidence: [],
    locale: 'en',
    rulesVersion: 'test-rules',
    classifierVersion: 'test-classifier',
    ...partial,
  } as Classification;
}

function settings(overrides: Partial<UserSettings> = {}): UserSettings {
  return { ...defaultSettings(), ...overrides };
}

function candidate(surface: Surface = 'home', videoId?: string): NormalizedVideoCandidate {
  return {
    ...(videoId !== undefined ? { videoId } : {}),
    title: 'A calm documentary about bread',
    channel: { channelId: 'UCMiss000000000000000000' },
    surface,
    cardKind: 'video',
    badges: [],
    ariaLabels: [],
    metadataText: [],
    isShort: false,
    observedAt: 1_700_000_000_000,
  };
}

function decision(
  action: FilterDecision['action'],
  reason: FilterDecision['reason'] = 'automatic',
): FilterDecision {
  return { action, reason, explanation: [] };
}

describe('V7-07: classifyMiss', () => {
  it('unresolved identity when no video id could be parsed', () => {
    const why = classifyMiss({
      candidate: candidate('home', undefined),
      decision: decision('allow'),
      classification: undefined,
      settings: settings(),
      surface: 'home',
    });
    expect(why).toBe('unresolved-identity');
  });

  it('unsupported-surface when the surface is disabled', () => {
    const s = settings();
    s.surfaces = { ...s.surfaces, home: false };
    const why = classifyMiss({
      candidate: candidate('home', 'vid01'),
      decision: decision('allow'),
      classification: undefined,
      settings: s,
      surface: 'home',
    });
    expect(why).toBe('unsupported-surface');
  });

  it('explicit-allow when a user allow rule or correction decided', () => {
    const why = classifyMiss({
      candidate: candidate('home', 'vid02'),
      decision: decision('allow', 'user-rule'),
      classification: classification({ aiLikelihood: 0.9, confidence: 'very-high' }),
      settings: settings(),
      surface: 'home',
    });
    expect(why).toBe('explicit-allow');
  });

  it('no-evidence when nothing was classified', () => {
    const why = classifyMiss({
      candidate: candidate('home', 'vid03'),
      decision: decision('allow'),
      classification: undefined,
      settings: settings(),
      surface: 'home',
    });
    expect(why).toBe('no-evidence');
  });

  it('below-threshold when classification exists but the policy allowed', () => {
    const why = classifyMiss({
      candidate: candidate('home', 'vid04'),
      decision: decision('allow'),
      classification: classification({ aiLikelihood: 0.4, confidence: 'medium' }),
      settings: settings(),
      surface: 'home',
    });
    expect(why).toBe('below-threshold');
  });

  it('category-warn when the outcome was a warning', () => {
    const why = classifyMiss({
      candidate: candidate('home', 'vid05'),
      decision: decision('warn'),
      classification: classification({ aiLikelihood: 0.75, confidence: 'high' }),
      settings: settings(),
      surface: 'home',
    });
    expect(why).toBe('category-warn');
  });
});

describe('V7-07: entry upsert dedupes and stays bounded', () => {
  it('one video seen 100 times is ONE entry with count 100 and fresh lastSeenAt', () => {
    let entries: MissReviewEntry[] = [];
    for (let i = 0; i < 100; i++) {
      entries = upsertMissEntry(entries, {
        videoId: 'samevid',
        title: 'Same video',
        surface: 'home',
        reason: 'below-threshold',
        seenAt: 1_700_000_000_000 + i,
      });
    }
    expect(entries).toHaveLength(1);
    expect(entries[0]!.sightingCount).toBe(100);
    expect(entries[0]!.firstSeenAt).toBe(1_700_000_000_000);
    expect(entries[0]!.lastSeenAt).toBe(1_700_000_000_000 + 99);
  });

  it(`bounded at ${MAX_MISS_REVIEW_ENTRIES} distinct videos, evicting the least-recently seen`, () => {
    let entries: MissReviewEntry[] = [];
    for (let i = 0; i < MAX_MISS_REVIEW_ENTRIES + 25; i++) {
      entries = upsertMissEntry(entries, {
        videoId: `vid${String(i).padStart(4, '0')}`,
        title: `Video ${i}`,
        surface: 'home',
        reason: 'no-evidence',
        seenAt: i,
      });
    }
    expect(entries).toHaveLength(MAX_MISS_REVIEW_ENTRIES);
    // Oldest-seen evicted: vid0000 must be gone, the newest kept.
    expect(entries.some((e) => e.videoId === 'vid0000')).toBe(false);
    expect(
      entries.some(
        (e) => e.videoId === `vid${String(MAX_MISS_REVIEW_ENTRIES + 24).padStart(4, '0')}`,
      ),
    ).toBe(true);
  });

  it('pruneMissEntries drops entries older than the cutoff', () => {
    const entries: MissReviewEntry[] = [
      {
        id: 'a',
        videoId: 'keep',
        title: 'keep',
        surface: 'home',
        reason: 'no-evidence',
        firstSeenAt: 900,
        lastSeenAt: 1_000,
        sightingCount: 1,
      },
      {
        id: 'b',
        videoId: 'drop',
        title: 'drop',
        surface: 'home',
        reason: 'no-evidence',
        firstSeenAt: 100,
        lastSeenAt: 200,
        sightingCount: 5,
      },
    ];
    const pruned = pruneMissEntries(entries, 1_000, 500);
    expect(pruned.map((e) => e.videoId)).toEqual(['keep']);
  });
});

describe('V7-07: MissReviewStore (durable, deduped, private)', () => {
  let kv: MemoryKVStore;
  let store: MissReviewStore;

  beforeEach(() => {
    kv = new MemoryKVStore();
    store = new MissReviewStore(kv);
  });

  it('records, dedupes across surfaces, and lists newest-first', async () => {
    await store.record({
      videoId: 'vidX',
      title: 'X',
      surface: 'home',
      reason: 'below-threshold',
      seenAt: 10,
    });
    await store.record({
      videoId: 'vidX',
      title: 'X',
      surface: 'search',
      reason: 'below-threshold',
      seenAt: 20,
    });
    const list = await store.list();
    expect(list).toHaveLength(1);
    expect(list[0]!.sightingCount).toBe(2);
    expect(list[0]!.surfaces).toContain('home');
    expect(list[0]!.surfaces).toContain('search');
    expect(list[0]!.lastSeenAt).toBe(20);
  });

  it('concurrent records of different videos are all kept (no lost update)', async () => {
    await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        store.record({
          videoId: `conc${i}`,
          title: `C${i}`,
          surface: 'home',
          reason: 'no-evidence',
          seenAt: i,
        }),
      ),
    );
    const list = await store.list();
    expect(list).toHaveLength(12);
  });

  it('clear() empties the queue; export returns a plain-JSON snapshot', async () => {
    await store.record({
      videoId: 'v1',
      title: 't',
      surface: 'home',
      reason: 'no-evidence',
      seenAt: 1,
    });
    const exported = await store.exportForUser();
    expect(typeof JSON.stringify(exported)).toBe('string');
    JSON.parse(JSON.stringify(exported));
    await store.clear();
    expect(await store.list()).toHaveLength(0);
  });

  it('corrupt stored payloads repair to an empty queue, never crash', async () => {
    await kv.set('local:missReview', 'garbage' as unknown);
    const broken = new MissReviewStore(kv);
    expect(await broken.list()).toEqual([]);
  });
});

describe('V7-07: serialization and reason registry', () => {
  it('serialized entries survive a JSON round-trip (wire-safe, no Sets)', () => {
    const entries: MissReviewEntry[] = [
      {
        id: 'e1',
        videoId: 'v1',
        title: 't',
        surface: 'home',
        reason: 'no-evidence',
        surfaces: ['home', 'search'],
        firstSeenAt: 1,
        lastSeenAt: 2,
        sightingCount: 3,
      },
    ];
    const round = JSON.parse(JSON.stringify(serializeMissEntries(entries))) as MissReviewEntry[];
    expect(round).toEqual(entries);
  });

  it('the reason registry covers the documented why-codes', () => {
    expect([...MISS_REASONS].sort()).toEqual(
      [
        'no-evidence',
        'below-threshold',
        'category-warn',
        'explicit-allow',
        'unsupported-surface',
        'unresolved-identity',
        'error',
      ].sort(),
    );
  });
});
