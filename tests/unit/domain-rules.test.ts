import { describe, expect, it } from 'vitest';
import { applyRuleMutation, defaultRules, validateRules } from '@/domain/rules';

describe('user rules', () => {
  it('validates and deduplicates lists', () => {
    const rules = validateRules({
      allowedVideoIds: ['abc', 'abc', 42, ''],
      blockedChannelIds: ['UC123'],
      fallbackBlockedHandles: ['@SlopLord', 'sloplord'],
    });
    expect(rules?.allowedVideoIds).toEqual(['abc']);
    expect(rules?.blockedChannelIds).toEqual(['UC123']);
    expect(rules?.fallbackBlockedHandles).toEqual(['sloplord']);
  });

  it('caps list length', () => {
    const huge = Array.from({ length: 20_000 }, (_, i) => `v${i}`);
    const rules = validateRules({ allowedVideoIds: huge });
    expect(rules?.allowedVideoIds.length).toBeLessThanOrEqual(10_000);
  });

  it('allow-video removes conflicting block', () => {
    const base = { ...defaultRules(), blockedVideoIds: ['v1'] };
    const next = applyRuleMutation(base, { kind: 'allow-video', videoId: 'v1' });
    expect(next.allowedVideoIds).toContain('v1');
    expect(next.blockedVideoIds).not.toContain('v1');
  });

  it('block-channel stores handle fallback and clears allow', () => {
    const base = {
      ...defaultRules(),
      allowedChannelIds: ['UCabc'],
      fallbackAllowedHandles: ['creator'],
    };
    const next = applyRuleMutation(base, {
      kind: 'block-channel',
      channelId: 'UCabc',
      handle: '@Creator',
    });
    expect(next.blockedChannelIds).toContain('UCabc');
    expect(next.allowedChannelIds).not.toContain('UCabc');
    expect(next.fallbackBlockedHandles).toContain('creator');
    expect(next.fallbackAllowedHandles).not.toContain('creator');
  });

  it('normalizes handle case and strips @ for fallback rules', () => {
    const base = defaultRules();
    const next = applyRuleMutation(base, { kind: 'block-channel-by-handle', handle: '@SLOP' });
    expect(next.fallbackBlockedHandles).toEqual(['slop']);
  });

  it('rejects non-object input', () => {
    expect(validateRules('x')).toBeNull();
    expect(validateRules([])).toBeNull();
  });
});
