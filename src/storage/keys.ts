/** All storage keys used by the extension (WXT storage area:key format). */
export const STORAGE_KEYS = {
  settings: 'local:settings',
  rules: 'local:rules',
  reviewRecords: 'local:reviewRecords',
  stats: 'local:stats',
  schemaVersion: 'local:schemaVersion',
  classificationCache: 'local:classificationCache',
  reputationCache: 'local:reputationCache',
  providerHealth: 'local:providerHealth',
} as const;
