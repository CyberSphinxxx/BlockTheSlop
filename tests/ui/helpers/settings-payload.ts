import { expect } from 'vitest';
import type { UserSettings } from '@/domain/settings';

/** Extract the FIRST settings patch handed to a saveSettings mock. */
export function expectSettingsPayload(
  saveSettings: { mock: { calls: unknown[][] } } | ((...args: never[]) => unknown),
): Partial<UserSettings> {
  const mock = (saveSettings as { mock?: { calls: unknown[][] } }).mock;
  if (mock === undefined) throw new Error('saveSettings is not a mock');
  expect(mock.calls.length).toBeGreaterThan(0);
  const call = mock.calls[0]?.[0] as Partial<UserSettings> | undefined;
  expect(call).toBeDefined();
  return call as Partial<UserSettings>;
}
