import { describe, expect, it } from 'vitest';
import { reviewRecordId, validateReviewRecords, REVIEW_MAX_RECORDS } from '@/domain/review';

function validRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'rv-abc-1',
    videoId: 'abc',
    title: 'Some video',
    surface: 'home',
    decision: { action: 'hide', reason: 'automatic', explanation: ['Likely AI-generated'] },
    createdAt: 1_700_000_000_000,
    ...overrides,
  };
}

describe('review records', () => {
  it('accepts valid records', () => {
    const out = validateReviewRecords([validRecord()]);
    expect(out).toHaveLength(1);
    expect(out?.[0]?.title).toBe('Some video');
    expect(out?.[0]?.decision.action).toBe('hide');
  });

  it('rejects invalid actions', () => {
    const out = validateReviewRecords([
      validRecord({ decision: { action: 'delete', reason: 'automatic' } }),
    ]);
    expect(out).toHaveLength(0);
  });

  it('truncates oversized strings', () => {
    const out = validateReviewRecords([validRecord({ title: 'x'.repeat(10_000) })]);
    expect(out?.[0]?.title.length).toBeLessThanOrEqual(512);
  });

  it('caps the number of records and dedupes ids', () => {
    const records = Array.from({ length: REVIEW_MAX_RECORDS + 50 }, (_, i) =>
      validRecord({ id: `id-${i}`, createdAt: i }),
    );
    const out = validateReviewRecords(records);
    expect(out?.length).toBe(REVIEW_MAX_RECORDS);
    const ids = new Set(out?.map((r) => r.id));
    expect(ids.size).toBe(out?.length);
  });

  it('preserves corrections and restored flags', () => {
    const out = validateReviewRecords([
      validRecord({ correction: ['not-ai'], restoredAt: 1_700_000_001_000 }),
    ]);
    expect(out?.[0]?.correction).toEqual(['not-ai']);
    expect(out?.[0]?.restoredAt).toBe(1_700_000_001_000);
  });

  it('builds deterministic ids', () => {
    expect(reviewRecordId('abc', 1234)).toBe(reviewRecordId('abc', 1234));
    expect(reviewRecordId('abc', 1234)).not.toBe(reviewRecordId('def', 1234));
    expect(reviewRecordId(undefined, 1234)).toContain('unknown');
  });

  it('returns null for non-array input', () => {
    expect(validateReviewRecords({})).toBeNull();
  });
});
