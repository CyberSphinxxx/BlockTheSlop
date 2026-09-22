import { describe, expect, it } from 'vitest';
import {
  defaultSettings,
  migrateSettings,
  SETTINGS_SCHEMA_VERSION,
  validateSettings,
} from '@/domain/settings';

describe('settings', () => {
  it('has privacy-safe defaults', () => {
    const s = defaultSettings();
    expect(s.enabled).toBe(true);
    expect(s.mode).toBe('balanced');
    expect(s.youtubeFeedback.enabled).toBe(false);
    expect(s.remoteProvider.enabled).toBe(false);
    expect(s.remoteProvider.endpoint).toBeUndefined();
    expect(s.showExplanations).toBe(true);
    expect(s.collectLocalStats).toBe(true);
  });

  it('defaults category actions to inherit except thumbnail/discussion', () => {
    const s = defaultSettings();
    expect(s.categoryActions['ai-visual']).toBe('inherit');
    expect(s.categoryActions['ai-thumbnail']).toBe('warn');
    expect(s.categoryActions['ai-discussion']).toBe('allow');
  });

  it('validates enum values and rejects invalid ones', () => {
    const valid = validateSettings({ enabled: true, mode: 'strict' });
    expect(valid?.mode).toBe('strict');

    const invalidMode = validateSettings({ enabled: true, mode: 'yolo' });
    expect(invalidMode?.mode).toBe('balanced');

    const invalidAction = validateSettings({
      categoryActions: { 'ai-visual': 'nuke-from-orbit' },
    });
    expect(invalidAction?.categoryActions['ai-visual']).toBe('inherit');
  });

  it('rejects non-https remote endpoints', () => {
    const s = validateSettings({
      remoteProvider: { enabled: true, endpoint: 'http://evil.example' },
    });
    expect(s?.remoteProvider.enabled).toBe(false);
    expect(s?.remoteProvider.endpoint).toBeUndefined();

    const ok = validateSettings({
      remoteProvider: { enabled: true, endpoint: 'https://api.example.com/reputation' },
    });
    expect(ok?.remoteProvider.enabled).toBe(true);
    expect(ok?.remoteProvider.endpoint).toContain('https://');
  });

  it('clamps provider timeout to sane bounds', () => {
    const s = validateSettings({ remoteProvider: { enabled: true, timeoutMs: 5 } });
    expect(s?.remoteProvider.timeoutMs).toBe(5000);
    const s2 = validateSettings({ remoteProvider: { enabled: true, timeoutMs: 999_999 } });
    expect(s2?.remoteProvider.timeoutMs).toBe(5000);
    const s3 = validateSettings({ remoteProvider: { timeoutMs: 1200 } });
    expect(s3?.remoteProvider.timeoutMs).toBe(1200);
  });

  it('returns null for non-object input', () => {
    expect(validateSettings(null)).toBeNull();
    expect(validateSettings('nope')).toBeNull();
    expect(validateSettings([1, 2])).toBeNull();
  });

  it('migrates v1 settings by injecting provider timeout', () => {
    const migrated = migrateSettings(
      { enabled: true, mode: 'safe', remoteProvider: { enabled: false } },
      1,
    );
    expect(migrated?.remoteProvider.timeoutMs).toBe(5000);
    expect(migrated?.mode).toBe('safe');
  });

  it('exposes current schema version', () => {
    expect(SETTINGS_SCHEMA_VERSION).toBeGreaterThanOrEqual(2);
  });

  it('survives unknown fields', () => {
    const s = validateSettings({ evilExecutableCode: 'alert(1)', mode: 'safe' });
    expect(s?.mode).toBe('safe');
    expect(JSON.stringify(s)).not.toContain('evilExecutableCode');
  });
});
