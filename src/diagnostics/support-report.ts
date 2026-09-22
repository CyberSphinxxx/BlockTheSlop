/**
 * QA-06: redacted local support report.
 *
 * Default output contains NO titles, video/channel IDs, queries, or URLs —
 * only counts, versions, feature flags, and storage health. An explicit
 * opt-in scope may include named identifiers, honored strictly.
 */

import { APP_VERSION } from '@/domain/versions';
import type { UserSettings } from '@/domain/settings';
import type { LocalStats } from '@/domain/stats';
import type { QuarantineItem } from '@/domain/history';

export interface RedactedReportInput {
  settings: UserSettings;
  stats: LocalStats;
  /** Count of durable summaries (never their contents). */
  historyCount: number;
  /** Count of correction records (never their contents). */
  correctionsCount: number;
  quarantine: QuarantineItem[];
  /** Explicit opt-in: include the named scope of identifiers. */
  includeIdentifiers?: boolean;
  /** Schema version of the durable IDB stores. */
  idbSchemaVersion: number;
}

export function buildSupportReport(input: RedactedReportInput): Record<string, unknown> {
  const { settings } = input;
  const report: Record<string, unknown> = {
    kind: 'blocktheslop-support-report',
    generatedAt: new Date().toISOString(),
    appVersion: APP_VERSION,
    redacted: !input.includeIdentifiers,
    // Capability/feature flags (booleans only — no endpoints, no IDs).
    features: {
      enabled: settings.enabled,
      mode: settings.mode,
      displayMode: settings.displayMode,
      historyEnabled: settings.history.enabled,
      historyRetentionDays: settings.history.retentionDays,
      shortsGuard: settings.shortsGuard.enabled,
      performancePreset: settings.performance.preset,
      rulePackFil: settings.rulePacks.fil,
      remoteProviderEnabled: settings.remoteProvider.enabled,
      youtubeFeedbackEnabled: settings.youtubeFeedback.enabled,
      collectLocalStats: settings.collectLocalStats,
      surfaces: { ...settings.surfaces },
    },
    // Counters only — never per-video rows.
    counters: {
      cardsEvaluated: input.stats.cardsEvaluated,
      hidden: input.stats.hidden,
      warned: input.stats.warned,
      restored: input.stats.restored,
      falsePositiveCorrections: input.stats.falsePositiveCorrections,
      historyRecords: input.historyCount,
      corrections: input.correctionsCount,
      quarantined: input.quarantine.length,
    },
    storage: {
      idbSchemaVersion: input.idbSchemaVersion,
    },
  };
  // Strict opt-in scope: only then may identifiers appear, and only as a
  // bounded list of quarantine record ids (no user content).
  if (input.includeIdentifiers === true) {
    report['quarantineIds'] = input.quarantine.slice(0, 20).map((q) => q.id);
  }
  return report;
}
