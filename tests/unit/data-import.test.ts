import { describe, expect, it } from 'vitest';
import {
  IMPORT_LIMITS,
  ImportRejectedError,
  buildExport,
  countDepth,
  parseImport,
} from '@/import-export/schema';
import { defaultSettings } from '@/domain/settings';
import { defaultRules } from '@/domain/rules';
import { defaultStats } from '@/domain/stats';

function makeExportText(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    ...buildExport({
      settings: defaultSettings(),
      rules: defaultRules(),
      review: [],
      stats: defaultStats(),
    }),
    ...overrides,
  });
}

describe('countDepth', () => {
  it('measures deepest nesting, ignoring brackets in strings', () => {
    expect(countDepth('{"a":[1,{"b":2}]}')).toBe(3);
    expect(countDepth('{"a":"[[["}')).toBe(1);
    expect(countDepth('{"a":"\\"[[["}')).toBe(1); // escaped quote inside string
    expect(countDepth('[]')).toBe(1);
    expect(countDepth('{}')).toBe(0 + 1 - 1 + 1); // single empty object → 1
  });
});

describe('DATA-11 hostile/invalid imports', () => {
  it('rejects oversized, deep, non-JSON, array, and unsupported-version files', () => {
    expect(() => parseImport('x'.repeat(IMPORT_LIMITS.maxJsonChars + 1))).toThrow(
      ImportRejectedError,
    );
    const deep = '{"a":'.repeat(40) + '1' + '}'.repeat(40);
    expect(() => parseImport(deep)).toThrow(ImportRejectedError);
    expect(() => parseImport('not json')).toThrow(ImportRejectedError);
    expect(() => parseImport('[1,2,3]')).toThrow(ImportRejectedError);
    expect(() => parseImport(makeExportText({ schemaVersion: 999 }))).toThrow(ImportRejectedError);
  });

  it('never executes data: script-like fields are inert strings', () => {
    const hostile = makeExportText({
      rules: { ...defaultRules(), blockedPhrases: ['<img src=x onerror=alert(1)>'] },
    });
    const parsed = parseImport(hostile);
    expect(parsed.rules.blockedPhrases).toEqual(['<img src=x onerror=alert(1)>']);
  });

  it('rejects prototype-like keys without crashing or polluting', () => {
    const polluted =
      '{"schemaVersion":1,"exportedAt":"2026-01-01","__proto__":{"x":1},"settings":{},"rules":{}}';
    expect(() => parseImport(polluted)).toThrow(ImportRejectedError);
    expect(({} as Record<string, unknown>)['x']).toBeUndefined();
  });
});

describe('DATA-10/12 round trip and prepared-import semantics', () => {
  it('export → parse → prepared outcome → deterministic contentHash', () => {
    const text = makeExportText();
    const parsed = parseImport(text);
    expect(parsed.contentHash.length).toBeGreaterThan(0);
    expect(parseImport(text).contentHash).toBe(parsed.contentHash);
    expect(() =>
      parseImport(makeExportText({ exportedAt: '2030-01-01T00:00:00.000Z' })),
    ).not.toThrow();
  });

  it('invalid review section warns instead of mutating by default', () => {
    const parsed = parseImport(makeExportText({ review: { bogus: true } }));
    expect(parsed.review).toEqual([]);
    expect(parsed.warnings.some((w) => w.toLowerCase().includes('review'))).toBe(true);
  });
});

describe('DATA-13 privacy flags in imports', () => {
  it('remote provider and YouTube feedback arrive disabled with a warning', () => {
    const text = makeExportText({
      settings: {
        ...defaultSettings(),
        remoteProvider: { enabled: true, endpoint: 'https://example.com/rep', timeoutMs: 5000 },
        youtubeFeedback: { enabled: true },
      },
    });
    const parsed = parseImport(text);
    expect(parsed.privacyFlagsSanitized).toBe(true);
    expect(parsed.settings.remoteProvider.enabled).toBe(false);
    expect(parsed.settings.youtubeFeedback.enabled).toBe(false);
    expect(parsed.warnings.some((w) => w.includes('disabled'))).toBe(true);
  });

  it('already-disabled flags are untouched and unsanitized', () => {
    const parsed = parseImport(makeExportText());
    expect(parsed.privacyFlagsSanitized).toBe(false);
    expect(parsed.settings.remoteProvider.enabled).toBe(false);
    expect(parsed.settings.youtubeFeedback.enabled).toBe(false);
  });
});
