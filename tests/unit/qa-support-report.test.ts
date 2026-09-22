import { describe, expect, it } from 'vitest';
import { buildSupportReport } from '@/diagnostics/support-report';
import { defaultSettings } from '@/domain/settings';
import { defaultStats } from '@/domain/stats';

const base = {
  settings: defaultSettings(),
  stats: defaultStats(),
  historyCount: 12,
  correctionsCount: 3,
  quarantine: [
    {
      id: 'q1',
      reason: 'legacy record failed validation',
      source: 'migration' as const,
      preview: '(redacted)',
      occurredAt: 1_700_000_000_000,
    },
  ],
  idbSchemaVersion: 1,
};

describe('QA-06 redacted support report', () => {
  it('default report has no titles, IDs, URLs, or endpoints', () => {
    const report = buildSupportReport(base) as Record<string, unknown>;
    const text = JSON.stringify(report);
    // Nothing identifier-like may appear anywhere.
    expect(text).not.toMatch(/UC[a-zA-Z0-9_-]{20,}/); // channel ids
    expect(text).not.toMatch(/https?:\/\//); // endpoints/urls
    expect(text).toMatch(/"redacted":true/);
    // Counters are fine; contents are not.
    expect(report['counters']).toMatchObject({ historyRecords: 12, corrections: 3 });
  });

  it('remote provider endpoint is never included even when enabled', () => {
    const report = buildSupportReport({
      ...base,
      settings: {
        ...defaultSettings(),
        remoteProvider: { enabled: true, endpoint: 'https://secret.example/rep', timeoutMs: 5000 },
      },
    });
    expect(JSON.stringify(report)).not.toContain('secret.example');
  });

  it('explicit opt-in includes only bounded quarantine ids, never content', () => {
    const report = buildSupportReport({ ...base, includeIdentifiers: true }) as Record<
      string,
      unknown
    >;
    expect(report['redacted']).toBe(false);
    expect(report['quarantineIds']).toEqual(['q1']);
    expect(JSON.stringify(report)).not.toContain('legacy record failed validation');
  });
});
