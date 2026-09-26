import type { UserRules } from '@/domain/rules';
import {
  IMPORT_LIMITS,
  type ImportPreviewReport,
  type MappedImport,
} from './competitor-import-types';

/**
 * V7-11 — competitor import PREVIEW for local files only.
 *
 * Sources (primary, accessed 2026-09-26):
 * - BlockTube (github.com/amitbl/blocktube, GPLv3): options store lists
 *   blockedChannels / blockedVideos / blockedKeywords / *_Regex variants.
 *   We map ONLY ids/keywords/names; the license note below is shown to the
 *   user. No competitor code was copied — this file only READS files the
 *   user exported from those tools.
 * - FilterTube (github.com/varshneydevansh/FilterTube): keyword filters
 *   with partial/whole-word modes; channels by name/@handle/UCID. FilterTube
 *   itself ships a "BlockTube migration JSON" flow, cross-confirming the
 *   BlockTube shape.
 *
 * Contract (kit: "Never silently enable remote lists"; may be PARTIAL if
 * safe format mapping cannot be proven):
 * - PREVIEW ONLY: `previewCompetitorImport` never mutates rules. Applying is
 *   a separate explicit transaction with a snapshot revert.
 * - Channel NAMES are not verified identities → unresolved, never mapped.
 * - Regex rules are unsupported (BlockTheSlop is literal-only by design).
 * - Corrupt/unknown/oversized files are REJECTED with a typed error, not
 *   partially applied.
 */

export class CompetitorImportRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CompetitorImportRejectedError';
  }
}

export { IMPORT_LIMITS } from './competitor-import-types';
export type { ImportPreviewReport, MappedImport } from './competitor-import-types';

/** BlockTube channel/video id shape: 24 chars starting with UC / 11-char video ids. */
const UC_ID = /^UC[A-Za-z0-9_-]{22}$/;
const UC_ID_ANY_CASE = /^uc[A-Za-z0-9_-]{22}$/i;
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
/** Handles: leading @, then letters/digits/dots/underscores/hyphens, 3..31 chars total. */
const HANDLE = /^@[A-Za-z0-9._-]{2,30}$/;

type ChannelEntryKind =
  { kind: 'uc'; id: string } | { kind: 'handle'; handle: string } | { kind: 'name'; name: string };

/**
 * Classify one raw channel entry. UC-prefixed ids are normalized to the
 * canonical uppercase prefix (careless exports lowercase them); the dedupe
 * key is case-insensitive, the FIRST spelling is kept.
 */
function normalizeChannelEntry(entry: string): ChannelEntryKind {
  if (UC_ID.test(entry)) return { kind: 'uc', id: entry };
  if (UC_ID_ANY_CASE.test(entry)) return { kind: 'uc', id: `UC${entry.slice(2)}` };
  if (HANDLE.test(entry)) return { kind: 'handle', handle: entry };
  return { kind: 'name', name: entry };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function cleanStringList(raw: unknown, limit: number): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const item of raw.slice(0, limit)) {
    if (typeof item !== 'string') continue;
    const trimmed = item.trim();
    if (trimmed !== '') out.push(trimmed);
  }
  return out;
}

type Format = 'blocktube' | 'filtertube';

/** Best-effort sniff when the user did not pick a format explicitly. */
function sniffFormat(raw: Record<string, unknown>): Format {
  const filters = raw['filters'];
  if (isRecord(filters)) {
    const f = filters as Record<string, unknown>;
    if (Array.isArray(f['keywords']) || Array.isArray(f['channels'])) return 'filtertube';
  }
  return 'blocktube';
}

const BLOCKTUBE_KEYS: readonly string[] = [
  'blockedChannels',
  'blockedVideos',
  'blockedKeywords',
  'blockedChannelsRegex',
  'blockedVideosRegex',
  'blockedKeywordsRegex',
];

/** The file must actually LOOK like the chosen format before mapping. */
function assertFormatSignature(raw: Record<string, unknown>, format: Format): void {
  if (format === 'blocktube') {
    for (const key of BLOCKTUBE_KEYS) {
      if (raw[key] !== undefined) return;
    }
    throw new CompetitorImportRejectedError(
      'File does not look like a BlockTube export (no known filter keys).',
    );
  }
  if (!isRecord(raw['filters'])) {
    throw new CompetitorImportRejectedError(
      'File does not look like a FilterTube export (no filters object).',
    );
  }
}

function classifyChannels(entries: readonly string[]): {
  channelIds: string[];
  handles: string[];
  unresolved: string[];
} {
  // Case-insensitive dedupe (UC ids differ only by case in careless exports);
  // the FIRST spelling encountered is kept.
  const channelIds = new Map<string, string>();
  const handles = new Map<string, string>();
  const unresolved: string[] = [];
  for (const entry of entries) {
    const normalized = normalizeChannelEntry(entry);
    if (normalized.kind === 'uc') {
      const key = normalized.id.toLowerCase();
      if (!channelIds.has(key)) channelIds.set(key, normalized.id);
    } else if (normalized.kind === 'handle') {
      const key = normalized.handle.toLowerCase();
      if (!handles.has(key)) handles.set(key, normalized.handle);
    } else {
      // A bare display name is not a verified identity: two channels can
      // share it and it can change at any time. Never map it to a rule.
      unresolved.push(normalized.name);
    }
  }
  return {
    channelIds: [...channelIds.values()],
    handles: [...handles.values()],
    unresolved,
  };
}

/** Literal keyword → phrase rule. Whole-word only when the source said so. */
function mapPhrases(entries: readonly { text: string; wholeWord: boolean }[]): {
  phrases: { phrase: string; wholeWord: boolean }[];
  duplicates: number;
} {
  const seen = new Set<string>();
  const phrases: { phrase: string; wholeWord: boolean }[] = [];
  let duplicates = 0;
  for (const { text, wholeWord } of entries) {
    const key = `${text.toLowerCase()}::${wholeWord ? 'w' : 's'}`;
    if (seen.has(key)) {
      duplicates += 1;
      continue;
    }
    seen.add(key);
    phrases.push({ phrase: text, wholeWord });
  }
  return { phrases, duplicates };
}

/**
 * Build the preview report. ALWAYS safe to call on hostile text: every
 * branch either maps a bounded string list or throws the typed rejection
 * error. Nothing here executes, fetches, or mutates any rule object.
 */
export function previewCompetitorImport(
  fileText: string,
  formatHint: 'auto' | Format,
  fileName: string,
): ImportPreviewReport {
  if (fileText.length > IMPORT_LIMITS.maxFileChars) {
    throw new CompetitorImportRejectedError(
      `File too large (limit ${IMPORT_LIMITS.maxFileChars} characters).`,
    );
  }
  let raw: unknown;
  try {
    raw = JSON.parse(fileText);
  } catch {
    throw new CompetitorImportRejectedError('File is not valid JSON.');
  }
  if (!isRecord(raw)) {
    throw new CompetitorImportRejectedError('File must be a JSON object.');
  }

  const format = formatHint === 'auto' ? sniffFormat(raw) : formatHint;
  assertFormatSignature(raw, format);

  if (format === 'blocktube') {
    const channelEntries = cleanStringList(raw['blockedChannels'], IMPORT_LIMITS.maxChannelEntries);
    const videoEntries = cleanStringList(raw['blockedVideos'], IMPORT_LIMITS.maxVideoEntries);
    const keywordEntries = cleanStringList(raw['blockedKeywords'], IMPORT_LIMITS.maxPhraseEntries);
    const hasRegex =
      cleanStringList(raw['blockedKeywordsRegex'], 1).length > 0 ||
      cleanStringList(raw['blockedChannelsRegex'], 1).length > 0 ||
      cleanStringList(raw['blockedVideosRegex'], 1).length > 0;

    const channels = classifyChannels(channelEntries);
    const seenVideos = new Set<string>();
    let dupVideos = 0;
    const videoIds: string[] = [];
    for (const id of videoEntries) {
      if (!VIDEO_ID.test(id)) continue;
      if (seenVideos.has(id)) {
        dupVideos += 1;
        continue;
      }
      seenVideos.add(id);
      videoIds.push(id);
    }
    const phraseMap = mapPhrases(keywordEntries.map((text) => ({ text, wholeWord: false })));

    const mapped: MappedImport = {
      channelIds: channels.channelIds,
      handles: channels.handles,
      videoIds,
      phrases: phraseMap.phrases,
    };
    const isEmpty =
      mapped.channelIds.length === 0 &&
      mapped.handles.length === 0 &&
      mapped.videoIds.length === 0 &&
      mapped.phrases.length === 0;

    return {
      format,
      fileName,
      mapped,
      duplicates: {
        channelIds: countDuplicateIds(channelEntries),
        videoIds: dupVideos,
        phrases: phraseMap.duplicates,
      },
      unresolvedChannels: channels.unresolved,
      unsupported: hasRegex ? ['regex (BlockTube regex rules are not imported)'] : [],
      licenseNote:
        'BlockTube is GPLv3. This import reads a file you exported locally; no competitor code is used or copied.',
      isEmpty,
      applied: false,
    };
  }

  // ── FilterTube ──────────────────────────────────────────────────────────
  const filtersRaw = raw['filters'];
  if (!isRecord(filtersRaw)) {
    throw new CompetitorImportRejectedError('FilterTube file has no filters object.');
  }
  const keywordsRaw = Array.isArray(filtersRaw['keywords']) ? filtersRaw['keywords'] : [];
  const channelsRaw = Array.isArray(filtersRaw['channels']) ? filtersRaw['channels'] : [];

  const keywordEntries: { text: string; wholeWord: boolean }[] = [];
  for (const item of keywordsRaw.slice(0, IMPORT_LIMITS.maxPhraseEntries)) {
    if (typeof item === 'string') {
      const text = item.trim();
      if (text !== '') keywordEntries.push({ text, wholeWord: false });
      continue;
    }
    if (isRecord(item) && typeof item['text'] === 'string') {
      const text = item['text'].trim();
      if (text === '') continue;
      keywordEntries.push({ text, wholeWord: item['wholeWord'] === true });
    }
  }

  const channelEntries: string[] = [];
  for (const item of channelsRaw.slice(0, IMPORT_LIMITS.maxChannelEntries)) {
    if (typeof item === 'string') {
      const value = item.trim();
      if (value !== '') channelEntries.push(value);
      continue;
    }
    if (isRecord(item)) {
      const value =
        typeof item['value'] === 'string'
          ? item['value']
          : typeof item['name'] === 'string'
            ? item['name']
            : undefined;
      if (value !== undefined) {
        const trimmed = value.trim();
        if (trimmed !== '') channelEntries.push(trimmed);
      }
    }
  }

  const channels = classifyChannels(channelEntries);
  const phraseMap = mapPhrases(keywordEntries);
  const mapped: MappedImport = {
    channelIds: channels.channelIds,
    handles: channels.handles,
    videoIds: [],
    phrases: phraseMap.phrases,
  };
  const isEmpty =
    mapped.channelIds.length === 0 && mapped.handles.length === 0 && mapped.phrases.length === 0;

  return {
    format,
    fileName,
    mapped,
    duplicates: {
      channelIds: countDuplicateIds(channelEntries),
      videoIds: 0,
      phrases: phraseMap.duplicates,
    },
    unresolvedChannels: channels.unresolved,
    unsupported: [
      // FilterTube features with no safe BlockTheSlop equivalent (duration /
      // upload-date / ALL-CAPS heuristics and comment filters target
      // different evidence than card filtering; silently converting them
      // would change semantics).
      'content-based filters (duration/upload-date/caps) — not imported',
      'comment filters — not imported',
    ],
    licenseNote:
      'FilterTube source is public; this import reads a file you exported locally and copies no code.',
    isEmpty,
    applied: false,
  };
}

function countDuplicateIds(entries: readonly string[]): number {
  const seen = new Set<string>();
  let duplicates = 0;
  for (const entry of entries) {
    const normalized = normalizeChannelEntry(entry);
    if (normalized.kind === 'name') continue;
    const key =
      normalized.kind === 'uc'
        ? `uc:${normalized.id.toLowerCase()}`
        : `h:${normalized.handle.toLowerCase()}`;
    if (seen.has(key)) duplicates += 1;
    else seen.add(key);
  }
  return duplicates;
}

/**
 * Merge the PREVIEWED mapping onto existing rules — explicit user action.
 * Pure: returns new rules; nothing is persisted here. Idempotent (re-import
 * cannot duplicate a rule).
 */
export function applyCompetitorImport(report: ImportPreviewReport, current: UserRules): UserRules {
  const channelIdSet = new Set(current.blockedChannelIds);
  for (const id of report.mapped.channelIds) channelIdSet.add(id);
  const handleSet = new Set(current.fallbackBlockedHandles);
  for (const handle of report.mapped.handles) handleSet.add(handle);
  const videoSet = new Set(current.blockedVideoIds);
  for (const id of report.mapped.videoIds) videoSet.add(id);
  const phraseKey = (p: { phrase: string; wholeWord: boolean }) =>
    `${p.phrase.toLowerCase()}::${p.wholeWord ? 'w' : 's'}`;
  const phraseSet = new Set(current.blockedPhraseRules.map(phraseKey));
  const phrases = [...current.blockedPhraseRules];
  for (const p of report.mapped.phrases) {
    if (!phraseSet.has(phraseKey(p))) {
      phraseSet.add(phraseKey(p));
      phrases.push({ phrase: p.phrase, wholeWord: p.wholeWord });
    }
  }
  return {
    ...current,
    blockedChannelIds: [...channelIdSet],
    fallbackBlockedHandles: [...handleSet],
    blockedVideoIds: [...videoSet],
    blockedPhraseRules: phrases,
  };
}

/**
 * Rollback helper: restores the exact snapshot taken before apply. Kept
 * symmetric with apply so the UI transaction is: preview → apply (persist) →
 * on any later failure, revert to `snapshot` and persist again.
 */
export function revertCompetitorImport(_merged: UserRules, snapshot: UserRules): UserRules {
  return {
    ...snapshot,
    blockedChannelIds: [...snapshot.blockedChannelIds],
    fallbackBlockedHandles: [...snapshot.fallbackBlockedHandles],
    blockedVideoIds: [...snapshot.blockedVideoIds],
    blockedPhraseRules: snapshot.blockedPhraseRules.map((p) => ({ ...p })),
  };
}
