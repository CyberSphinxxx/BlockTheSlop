import { describe, expect, it } from 'vitest';
import {
  buildExport,
  IMPORT_LIMITS,
  ImportRejectedError,
  parseImport,
} from '@/import-export/schema';
import { defaultSettings } from '@/domain/settings';
import { defaultRules } from '@/domain/rules';
import { defaultStats } from '@/domain/stats';

const base = {
  settings: defaultSettings(),
  rules: defaultRules(),
  review: [],
  stats: defaultStats(),
};

describe('import/export', () => {
  it('round-trips a full export', () => {
    const payload = buildExport(base);
    const parsed = parseImport(JSON.stringify(payload));
    expect(parsed.settings.mode).toBe('balanced');
    expect(parsed.warnings).toHaveLength(0);
  });

  it('includes version markers', () => {
    const payload = buildExport(base);
    expect(payload.schemaVersion).toBe(1);
    expect(payload.appVersion).toBeTruthy();
    expect(Number.isNaN(Date.parse(payload.exportedAt))).toBe(false);
  });

  it('rejects invalid JSON', () => {
    expect(() => parseImport('{not json')).toThrow(ImportRejectedError);
  });

  it('rejects wrong schema version', () => {
    const payload = JSON.stringify({ ...buildExport(base), schemaVersion: 99 });
    expect(() => parseImport(payload)).toThrow(ImportRejectedError);
  });

  it('rejects invalid settings section', () => {
    expect(() =>
      parseImport('{"schemaVersion":1,"exportedAt":"2026-01-01","settings":42}'),
    ).toThrow(ImportRejectedError);
  });

  it('rejects invalid rules section', () => {
    const payload = buildExport(base);
    const bad = JSON.stringify({ ...payload, rules: 'all-your-base' });
    expect(() => parseImport(bad)).toThrow(ImportRejectedError);
  });

  it('warns and drops invalid review records instead of rejecting', () => {
    const payload = buildExport(base);
    const withReview = JSON.stringify({ ...payload, review: [{ id: 'x', garbage: true }] });
    const parsed = parseImport(withReview);
    expect(parsed.review).toHaveLength(0);
    expect(parsed.warnings.length).toBeGreaterThan(0);
  });

  it('rejects oversized imports', () => {
    const big = 'x'.repeat(IMPORT_LIMITS.maxJsonChars + 1);
    expect(() => parseImport(big)).toThrow(ImportRejectedError);
  });

  it('does not execute imported data as code', () => {
    const payload = buildExport(base);
    const evil = JSON.stringify({
      ...payload,
      settings: { ...base.settings, mode: 'safe' },
      evilCode: 'process.exit(1)',
    });
    const parsed = parseImport(evil);
    expect(parsed.settings.mode).toBe('safe');
    expect(JSON.stringify(parsed)).not.toContain('evilCode');
  });

  it('normalizes duplicate rule ids', () => {
    const payload = buildExport({
      ...base,
      rules: { ...defaultRules(), allowedVideoIds: ['a', 'a', 'a'] },
    });
    const parsed = parseImport(JSON.stringify(payload));
    expect(parsed.rules.allowedVideoIds).toEqual(['a']);
  });
});
