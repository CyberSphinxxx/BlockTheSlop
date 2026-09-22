/**
 * User rules — explicit allow/block decisions that always beat automation.
 *
 * Channel identity is stored by canonical `UC...` ID when known. Handles and
 * display names are kept as *fallback* keys so a rename does not silently
 * lose the rule; precedence is documented in `policy/precedence.ts`.
 */
export interface UserRules {
  allowedVideoIds: string[];
  blockedVideoIds: string[];

  allowedChannelIds: string[];
  blockedChannelIds: string[];

  fallbackAllowedHandles: string[];
  fallbackBlockedHandles: string[];

  /**
   * Literal title/phrase block rules (CFG-05). Case-insensitive substring
   * match against the card title; capped for performance; no regex so user
   * input can never execute or blow up the matcher.
   */
  blockedPhrases: string[];
}

export const USER_RULES_SCHEMA_VERSION = 1 as const;

const MAX_LIST_LENGTH = 10_000;
const MAX_ID_LENGTH = 256;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function cleanIdList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of raw.slice(0, MAX_LIST_LENGTH)) {
    if (typeof item !== 'string') continue;
    const value = item.trim().slice(0, MAX_ID_LENGTH);
    if (value.length === 0 || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

/** Normalize a user-supplied handle for fallback matching (strip `@`, lowercase). */
export function normalizeFallbackHandle(raw: string): string {
  return raw.trim().replace(/^@+/, '').toLowerCase();
}

/** Dedupe after normalization so `@Foo` and `foo` collapse to one entry. */
function dedupeNormalized(values: string[]): string[] {
  return [...new Set(values)];
}

/** Structural validation for rules loaded from storage or import. */
export function validateRules(raw: unknown): UserRules | null {
  if (!isRecord(raw)) return null;
  return {
    allowedVideoIds: cleanIdList(raw['allowedVideoIds']),
    blockedVideoIds: cleanIdList(raw['blockedVideoIds']),
    allowedChannelIds: cleanIdList(raw['allowedChannelIds']),
    blockedChannelIds: cleanIdList(raw['blockedChannelIds']),
    fallbackAllowedHandles: dedupeNormalized(
      cleanIdList(raw['fallbackAllowedHandles']).map(normalizeFallbackHandle),
    ),
    fallbackBlockedHandles: dedupeNormalized(
      cleanIdList(raw['fallbackBlockedHandles']).map(normalizeFallbackHandle),
    ),
    blockedPhrases: cleanIdList(raw['blockedPhrases']),
  };
}

export function defaultRules(): UserRules {
  return {
    allowedVideoIds: [],
    blockedVideoIds: [],
    allowedChannelIds: [],
    blockedChannelIds: [],
    fallbackAllowedHandles: [],
    fallbackBlockedHandles: [],
    blockedPhrases: [],
  };
}

/** Remove a value from a list, returning a new array (immutable update). */
function withoutValue(list: string[], value: string): string[] {
  return list.filter((v) => v !== value);
}

export type RuleMutation =
  | { kind: 'allow-video'; videoId: string }
  | { kind: 'block-video'; videoId: string }
  | { kind: 'allow-channel'; channelId: string; handle?: string | undefined }
  | { kind: 'block-channel'; channelId: string; handle?: string | undefined }
  | { kind: 'allow-channel-by-handle'; handle: string }
  | { kind: 'block-channel-by-handle'; handle: string }
  | { kind: 'block-phrase'; phrase: string }
  | { kind: 'unblock-phrase'; phrase: string };

/** Normalize a mutation-supplied handle, dropping empty results. */
function fallbackHandle(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const value = normalizeFallbackHandle(raw);
  return value.length > 0 ? value : undefined;
}

/** Apply a mutation, resolving conflicts (allow removes block entries and vice versa). */
export function applyRuleMutation(rules: UserRules, mutation: RuleMutation): UserRules {
  switch (mutation.kind) {
    case 'allow-video':
      return {
        ...rules,
        allowedVideoIds: [
          ...withoutValue(rules.allowedVideoIds, mutation.videoId),
          mutation.videoId,
        ],
        blockedVideoIds: withoutValue(rules.blockedVideoIds, mutation.videoId),
      };
    case 'block-video':
      return {
        ...rules,
        blockedVideoIds: [
          ...withoutValue(rules.blockedVideoIds, mutation.videoId),
          mutation.videoId,
        ],
        allowedVideoIds: withoutValue(rules.allowedVideoIds, mutation.videoId),
      };
    case 'allow-channel': {
      const handle = fallbackHandle(mutation.handle);
      return {
        ...rules,
        allowedChannelIds: [
          ...withoutValue(rules.allowedChannelIds, mutation.channelId),
          mutation.channelId,
        ],
        blockedChannelIds: withoutValue(rules.blockedChannelIds, mutation.channelId),
        fallbackAllowedHandles: handle
          ? [...withoutValue(rules.fallbackAllowedHandles, handle), handle]
          : rules.fallbackAllowedHandles,
        fallbackBlockedHandles: handle
          ? withoutValue(rules.fallbackBlockedHandles, handle)
          : rules.fallbackBlockedHandles,
      };
    }
    case 'block-channel': {
      const handle = fallbackHandle(mutation.handle);
      return {
        ...rules,
        blockedChannelIds: [
          ...withoutValue(rules.blockedChannelIds, mutation.channelId),
          mutation.channelId,
        ],
        allowedChannelIds: withoutValue(rules.allowedChannelIds, mutation.channelId),
        fallbackBlockedHandles: handle
          ? [...withoutValue(rules.fallbackBlockedHandles, handle), handle]
          : rules.fallbackBlockedHandles,
        fallbackAllowedHandles: handle
          ? withoutValue(rules.fallbackAllowedHandles, handle)
          : rules.fallbackAllowedHandles,
      };
    }
    case 'allow-channel-by-handle': {
      const handle = fallbackHandle(mutation.handle);
      if (handle === undefined) return rules;
      return {
        ...rules,
        fallbackAllowedHandles: [...withoutValue(rules.fallbackAllowedHandles, handle), handle],
        fallbackBlockedHandles: withoutValue(rules.fallbackBlockedHandles, handle),
      };
    }
    case 'block-channel-by-handle': {
      const handle = fallbackHandle(mutation.handle);
      if (handle === undefined) return rules;
      return {
        ...rules,
        fallbackBlockedHandles: [...withoutValue(rules.fallbackBlockedHandles, handle), handle],
        fallbackAllowedHandles: withoutValue(rules.fallbackAllowedHandles, handle),
      };
    }
    case 'block-phrase': {
      const phrase = mutation.phrase.trim().slice(0, MAX_ID_LENGTH);
      if (phrase.length === 0) return rules;
      return {
        ...rules,
        blockedPhrases: [...withoutValue(rules.blockedPhrases, phrase), phrase],
      };
    }
    case 'unblock-phrase':
      return {
        ...rules,
        blockedPhrases: withoutValue(rules.blockedPhrases, mutation.phrase.trim()),
      };
  }
}
