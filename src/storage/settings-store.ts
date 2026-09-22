import {
  defaultSettings,
  migrateSettings,
  SETTINGS_SCHEMA_VERSION,
  validateSettings,
  type UserSettings,
} from '@/domain/settings';
import type { KVStore } from './db';
import { STORAGE_KEYS } from './keys';

export interface SettingsSnapshot {
  settings: UserSettings;
  schemaVersion: number;
}

/** Owns persistence of user settings; validates and migrates on load. */
export class SettingsStore {
  constructor(private readonly kv: KVStore) {}

  async load(): Promise<SettingsSnapshot> {
    const [storedVersion, storedSettings] = await Promise.all([
      this.kv.get<number>(STORAGE_KEYS.schemaVersion),
      this.kv.get<unknown>(STORAGE_KEYS.settings),
    ]);

    const version = typeof storedVersion === 'number' ? storedVersion : SETTINGS_SCHEMA_VERSION;
    if (storedSettings === undefined) {
      const settings = defaultSettings();
      await this.save(settings, SETTINGS_SCHEMA_VERSION);
      return { settings, schemaVersion: SETTINGS_SCHEMA_VERSION };
    }

    const migrated = migrateSettings(storedSettings, version);
    if (migrated === null) {
      // Corrupt settings: fall back to defaults rather than breaking filtering.
      const settings = defaultSettings();
      await this.save(settings, SETTINGS_SCHEMA_VERSION);
      return { settings, schemaVersion: SETTINGS_SCHEMA_VERSION };
    }

    if (version !== SETTINGS_SCHEMA_VERSION) {
      await this.save(migrated, SETTINGS_SCHEMA_VERSION);
    }
    return { settings: migrated, schemaVersion: SETTINGS_SCHEMA_VERSION };
  }

  async save(
    settings: UserSettings,
    schemaVersion: number = SETTINGS_SCHEMA_VERSION,
  ): Promise<void> {
    const validated = validateSettings(settings);
    if (validated === null) {
      throw new Error('Refusing to persist invalid settings');
    }
    await this.kv.set(STORAGE_KEYS.settings, validated);
    await this.kv.set(STORAGE_KEYS.schemaVersion, schemaVersion);
  }

  async update(mutate: (settings: UserSettings) => UserSettings): Promise<UserSettings> {
    const { settings } = await this.load();
    const next = mutate(structuredClone(settings));
    await this.save(next);
    return next;
  }

  /** Watch for external settings changes (e.g. popup updates while YouTube is open). */
  watch(callback: (settings: UserSettings) => void): () => void {
    const listener = (changes: Record<string, { newValue?: unknown }>, area: string): void => {
      if (area !== 'local') return;
      if (!(STORAGE_KEYS.settings in changes)) return;
      const migrated = migrateSettings(
        changes[STORAGE_KEYS.settings]?.newValue,
        SETTINGS_SCHEMA_VERSION,
      );
      if (migrated !== null) callback(migrated);
    };
    browser.storage.onChanged.addListener(listener);
    return () => {
      browser.storage.onChanged.removeListener(listener);
    };
  }
}
