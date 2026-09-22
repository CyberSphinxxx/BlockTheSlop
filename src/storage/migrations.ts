import { SETTINGS_SCHEMA_VERSION } from '@/domain/settings';
import type { KVStore } from './db';
import { STORAGE_KEYS } from './keys';

/**
 * Deterministic, tested migrations for the whole storage area.
 *
 * Each step takes the raw stored values at version N and produces the shape
 * expected at version N+1. Migrations must never lose user data; unknown or
 * corrupt fields fall back to defaults through validation on next load.
 */
export const LATEST_SCHEMA_VERSION = SETTINGS_SCHEMA_VERSION;

export interface MigrationResult {
  applied: number[];
  finalVersion: number;
}

type MigrationStep = (data: Record<string, unknown>) => Record<string, unknown>;

/** v1 → v2: remoteProvider gained a required `timeoutMs`. */
const step1to2: MigrationStep = (data) => {
  const settings = data[STORAGE_KEYS.settings];
  if (typeof settings === 'object' && settings !== null && !Array.isArray(settings)) {
    const provider = (settings as Record<string, unknown>)['remoteProvider'];
    if (
      typeof provider === 'object' &&
      provider !== null &&
      (provider as Record<string, unknown>)['timeoutMs'] === undefined
    ) {
      data[STORAGE_KEYS.settings] = {
        ...(settings as Record<string, unknown>),
        remoteProvider: { ...(provider as Record<string, unknown>), timeoutMs: 5000 },
      };
    }
  }
  return data;
};

const STEPS: readonly { from: number; run: MigrationStep }[] = [{ from: 1, run: step1to2 }];

/** Run all pending migrations. Safe to call on every startup. */
export async function runMigrations(kv: KVStore): Promise<MigrationResult> {
  const stored = await kv.get<number>(STORAGE_KEYS.schemaVersion);
  const from =
    typeof stored === 'number' && Number.isInteger(stored) && stored >= 1
      ? stored
      : SETTINGS_SCHEMA_VERSION;
  if (from >= LATEST_SCHEMA_VERSION) {
    return { applied: [], finalVersion: LATEST_SCHEMA_VERSION };
  }
  const data: Record<string, unknown> = {};
  for (const key of Object.values(STORAGE_KEYS)) {
    const value = await kv.get<unknown>(key);
    if (value !== undefined) data[key] = value;
  }
  const applied: number[] = [];
  let version = from;
  for (const step of STEPS) {
    if (step.from === version) {
      Object.assign(data, step.run(data));
      version = step.from + 1;
      applied.push(version);
    }
  }
  for (const [key, value] of Object.entries(data)) {
    await kv.set(key, value);
  }
  await kv.set(STORAGE_KEYS.schemaVersion, LATEST_SCHEMA_VERSION);
  return { applied, finalVersion: LATEST_SCHEMA_VERSION };
}
