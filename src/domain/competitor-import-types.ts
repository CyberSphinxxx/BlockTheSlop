/** V7-11: bounded input limits for competitor file imports. */
export const IMPORT_LIMITS = {
  /** ~2 MB text bound — generous for rule lists, hostile-file safe. */
  maxFileChars: 2_000_000,
  /** Rule-list ceilings mirror the internal rule caps (MAX_LIST_LENGTH). */
  maxChannelEntries: 10_000,
  maxVideoEntries: 10_000,
  maxPhraseEntries: 10_000,
} as const;

/** What a competitor file maps onto, after dedupe and identity checks. */
export interface MappedImport {
  /** Verified UC-prefixed channel ids. */
  channelIds: string[];
  /** @handle-shaped identities (fallback identity tier). */
  handles: string[];
  /** 11-char video ids. */
  videoIds: string[];
  /** Literal phrase rules; wholeWord only when the source declared it. */
  phrases: { phrase: string; wholeWord: boolean }[];
}

export interface ImportPreviewReport {
  format: 'blocktube' | 'filtertube';
  fileName: string;
  mapped: MappedImport;
  duplicates: {
    channelIds: number;
    videoIds: number;
    phrases: number;
  };
  /**
   * Channel entries that are bare display names — NOT verified identities.
   * They are never mapped; the user can resolve them manually if desired.
   */
  unresolvedChannels: string[];
  /** Source features with no safe equivalent here (regex, comment filters…). */
  unsupported: string[];
  /** License/provenance note shown in the UI. */
  licenseNote: string;
  /** True when nothing usable was found (honest empty state). */
  isEmpty: boolean;
  /** Always false on a preview; the UI flips it on successful apply. */
  applied: boolean;
}
