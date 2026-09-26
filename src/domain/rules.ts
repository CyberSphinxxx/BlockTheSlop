/**
 * User rules — explicit allow/block decisions that always beat automation.
 *
 * Channel identity is stored by canonical `UC...` ID when known. Handles and
 * display names are kept as *fallback* keys so a rename does not silently
 * lose the rule; precedence is documented in `policy/precedence.ts`.
 */
export interface ChannelRuleMeta {
  channelId?: string | undefined;
  handle?: string | undefined;
  displayName?: string | undefined;
  addedAt: number;
  source: 'context-menu' | 'channel-page' | 'review' | 'manual';
  reason?: string | undefined;
}

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

  /**
   * V7-09: phrase rules with an explicit match mode (substring or
   * whole-word). Kept SEPARATE from the legacy `blockedPhrases` list so old
   * imports/exports stay byte-compatible; unblock-phrase removes from both.
   * The phrase is literal text — regex metacharacters are never interpreted.
   */
  blockedPhraseRules: PhraseRule[];

  /** V5-06: Metadata for channel rules (source, date, reason) */
  channelRulesMeta?: Record<string, ChannelRuleMeta> | undefined;
}

export const USER_RULES_SCHEMA_VERSION = 1 as const;

/** V7-09: a literal phrase rule with match mode (no regex, ever). */
export interface PhraseRule {
  phrase: string;
  wholeWord: boolean;
}

const MAX_LIST_LENGTH = 10_000;
const MAX_ID_LENGTH = 256;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** V7-09: structural validation of stored phrase rules (never trust JSON). */
function cleanPhraseRules(raw: unknown): PhraseRule[] {
  if (!Array.isArray(raw)) return [];
  const out: PhraseRule[] = [];
  const seen = new Set<string>();
  for (const item of raw.slice(0, MAX_LIST_LENGTH)) {
    if (!isRecord(item)) continue;
    if (typeof item['phrase'] !== 'string') continue;
    const phrase = item['phrase'].trim().slice(0, MAX_ID_LENGTH);
    if (phrase.length === 0) continue;
    const wholeWord = item['wholeWord'] === true;
    const key = `${wholeWord ? 'w' : 's'}:${phrase.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ phrase, wholeWord });
  }
  return out;
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

function cleanChannelRulesMeta(raw: unknown): Record<string, ChannelRuleMeta> | undefined {
  if (!isRecord(raw)) return undefined;
  const out: Record<string, ChannelRuleMeta> = {};
  for (const [key, item] of Object.entries(raw)) {
    if (!isRecord(item)) continue;
    const addedAt = typeof item['addedAt'] === 'number' ? item['addedAt'] : Date.now();
    const source =
      typeof item['source'] === 'string' &&
      ['context-menu', 'channel-page', 'review', 'manual'].includes(item['source'])
        ? (item['source'] as ChannelRuleMeta['source'])
        : 'manual';
    out[key] = {
      channelId: typeof item['channelId'] === 'string' ? item['channelId'] : undefined,
      handle: typeof item['handle'] === 'string' ? item['handle'] : undefined,
      displayName: typeof item['displayName'] === 'string' ? item['displayName'] : undefined,
      addedAt,
      source,
      reason: typeof item['reason'] === 'string' ? item['reason'] : undefined,
    };
  }
  return out;
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
    blockedPhraseRules: cleanPhraseRules(raw['blockedPhraseRules']),
    channelRulesMeta: cleanChannelRulesMeta(raw['channelRulesMeta']),
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
    blockedPhraseRules: [],
    channelRulesMeta: {},
  };
}

/**
 * O(1) in-memory lookup index for user rules (V5-05).
 * Built lazily and cached per UserRules reference via WeakMap so 1,000-card batches
 * with 10k rules perform O(1) Set lookups instead of scanning linear arrays.
 */
export interface RuleIndex {
  readonly allowedVideoIds: ReadonlySet<string>;
  readonly blockedVideoIds: ReadonlySet<string>;
  readonly allowedChannelIds: ReadonlySet<string>;
  readonly blockedChannelIds: ReadonlySet<string>;
  readonly fallbackAllowedHandles: ReadonlySet<string>;
  readonly fallbackBlockedHandles: ReadonlySet<string>;
  readonly blockedPhrasesLower: readonly string[];
  /** V7-09: phrase rules with explicit match mode (as stored). */
  readonly blockedPhraseRules: readonly PhraseRule[];
  /**
   * V7-09: single-token whole-word rules as a Set — matching is a tokenized
   * lookup per title (O(title words), independent of rule count), which is
   * what keeps 10k rules fast. Unicode word chars only (\p{L}\p{N}_).
   */
  readonly blockedSingleWords: ReadonlySet<string>;
  /**
   * V7-09: multi-word whole-word rules with ONCE-compiled escaped-literal
   * matchers (rare; compiled per rules snapshot, never per card).
   */
  readonly blockedMultiWordMatchers: readonly {
    phrase: string;
    test: (title: string) => boolean;
  }[];
}

const ruleIndexCache = new WeakMap<UserRules, RuleIndex>();

export function getRuleIndex(rules: UserRules): RuleIndex {
  let index = ruleIndexCache.get(rules);
  if (!index) {
    index = {
      allowedVideoIds: new Set(rules.allowedVideoIds),
      blockedVideoIds: new Set(rules.blockedVideoIds),
      allowedChannelIds: new Set(rules.allowedChannelIds),
      blockedChannelIds: new Set(rules.blockedChannelIds),
      fallbackAllowedHandles: new Set(rules.fallbackAllowedHandles),
      fallbackBlockedHandles: new Set(rules.fallbackBlockedHandles),
      blockedPhrasesLower: [
        ...rules.blockedPhrases.map((p) => p.trim().toLowerCase()),
        // wholeWord:false phrase rules behave exactly like legacy substrings.
        ...rules.blockedPhraseRules
          .filter((r) => !r.wholeWord)
          .map((r) => r.phrase.trim().toLowerCase()),
      ].filter((p) => p.length > 0),
      blockedPhraseRules: rules.blockedPhraseRules,
      blockedSingleWords: new Set(
        rules.blockedPhraseRules
          .filter((r) => r.wholeWord && !/[\s]/.test(r.phrase.trim()))
          .map((r) => r.phrase.trim().toLowerCase()),
      ),
      blockedMultiWordMatchers: rules.blockedPhraseRules
        .filter((r) => r.wholeWord && /[\s]/.test(r.phrase.trim()))
        .map((r) => {
          try {
            // The phrase is ESCAPED literal text inside Unicode word
            // boundaries — metacharacters can never widen the pattern.
            const escaped = r.phrase.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const re = new RegExp(`(?<![\\p{L}\\p{N}_])${escaped}(?![\\p{L}\\p{N}_])`, 'u');
            return { phrase: r.phrase, test: (title: string) => re.test(title.toLowerCase()) };
          } catch {
            // Uncompilable (never expected with escaped literal): fail closed.
            return { phrase: r.phrase, test: () => false };
          }
        }),
    };
    ruleIndexCache.set(rules, index);
  }
  return index;
}

/** Remove a value from a list, returning a new array (immutable update). */
function withoutValue(list: string[], value: string): string[] {
  return list.filter((v) => v !== value);
}

export type RuleMutation =
  | { kind: 'allow-video'; videoId: string }
  | { kind: 'block-video'; videoId: string }
  | {
      kind: 'allow-channel';
      channelId: string;
      handle?: string | undefined;
      source?: ChannelRuleMeta['source'] | undefined;
      reason?: string | undefined;
    }
  | {
      kind: 'block-channel';
      channelId: string;
      handle?: string | undefined;
      displayName?: string | undefined;
      source?: ChannelRuleMeta['source'] | undefined;
      reason?: string | undefined;
    }
  | {
      kind: 'allow-channel-by-handle';
      handle: string;
      source?: ChannelRuleMeta['source'] | undefined;
      reason?: string | undefined;
    }
  | {
      kind: 'block-channel-by-handle';
      handle: string;
      displayName?: string | undefined;
      source?: ChannelRuleMeta['source'] | undefined;
      reason?: string | undefined;
    }
  | { kind: 'unblock-video'; videoId: string }
  | { kind: 'unblock-channel'; channelId: string; handle?: string | undefined }
  | { kind: 'unblock-channel-by-handle'; handle: string }
  | { kind: 'block-phrase'; phrase: string; wholeWord?: boolean | undefined }
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
      const meta = { ...rules.channelRulesMeta };
      delete meta[mutation.channelId];
      if (handle) delete meta[handle];
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
        channelRulesMeta: meta,
      };
    }
    case 'block-channel': {
      const handle = fallbackHandle(mutation.handle);
      const meta = { ...rules.channelRulesMeta };
      const info: ChannelRuleMeta = {
        channelId: mutation.channelId,
        handle,
        displayName: mutation.displayName,
        addedAt: Date.now(),
        source: mutation.source ?? 'manual',
        reason: mutation.reason,
      };
      meta[mutation.channelId] = info;
      if (handle) meta[handle] = info;
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
        channelRulesMeta: meta,
      };
    }
    case 'allow-channel-by-handle': {
      const handle = fallbackHandle(mutation.handle);
      if (handle === undefined) return rules;
      const meta = { ...rules.channelRulesMeta };
      delete meta[handle];
      return {
        ...rules,
        fallbackAllowedHandles: [...withoutValue(rules.fallbackAllowedHandles, handle), handle],
        fallbackBlockedHandles: withoutValue(rules.fallbackBlockedHandles, handle),
        channelRulesMeta: meta,
      };
    }
    case 'block-channel-by-handle': {
      const handle = fallbackHandle(mutation.handle);
      if (handle === undefined) return rules;
      const meta = { ...rules.channelRulesMeta };
      meta[handle] = {
        handle,
        displayName: mutation.displayName,
        addedAt: Date.now(),
        source: mutation.source ?? 'manual',
        reason: mutation.reason,
      };
      return {
        ...rules,
        fallbackBlockedHandles: [...withoutValue(rules.fallbackBlockedHandles, handle), handle],
        fallbackAllowedHandles: withoutValue(rules.fallbackAllowedHandles, handle),
        channelRulesMeta: meta,
      };
    }
    case 'unblock-video':
      return {
        ...rules,
        blockedVideoIds: withoutValue(rules.blockedVideoIds, mutation.videoId),
      };
    case 'unblock-channel': {
      const handle = fallbackHandle(mutation.handle);
      const meta = { ...rules.channelRulesMeta };
      delete meta[mutation.channelId];
      if (handle) delete meta[handle];
      return {
        ...rules,
        blockedChannelIds: withoutValue(rules.blockedChannelIds, mutation.channelId),
        fallbackBlockedHandles: handle
          ? withoutValue(rules.fallbackBlockedHandles, handle)
          : rules.fallbackBlockedHandles,
        channelRulesMeta: meta,
      };
    }
    case 'unblock-channel-by-handle': {
      const handle = fallbackHandle(mutation.handle);
      if (handle === undefined) return rules;
      const meta = { ...rules.channelRulesMeta };
      delete meta[handle];
      return {
        ...rules,
        fallbackBlockedHandles: withoutValue(rules.fallbackBlockedHandles, handle),
        channelRulesMeta: meta,
      };
    }
    case 'block-phrase': {
      const phrase = mutation.phrase.trim().slice(0, MAX_ID_LENGTH);
      if (phrase.length === 0) return rules;
      if (mutation.wholeWord === true) {
        // V7-09: whole-word rules live in the typed list; remove any legacy
        // substring twin so the rule has ONE meaning.
        return {
          ...rules,
          blockedPhrases: withoutValue(rules.blockedPhrases, phrase),
          blockedPhraseRules: [
            ...rules.blockedPhraseRules.filter(
              (r) => r.phrase.toLowerCase() !== phrase.toLowerCase(),
            ),
            { phrase, wholeWord: true },
          ],
        };
      }
      return {
        ...rules,
        blockedPhraseRules: rules.blockedPhraseRules.filter(
          (r) => r.phrase.toLowerCase() !== phrase.toLowerCase(),
        ),
        blockedPhrases: [...withoutValue(rules.blockedPhrases, phrase), phrase],
      };
    }
    case 'unblock-phrase':
      return {
        ...rules,
        blockedPhrases: withoutValue(rules.blockedPhrases, mutation.phrase.trim()),
        blockedPhraseRules: rules.blockedPhraseRules.filter(
          (r) => r.phrase.toLowerCase() !== mutation.phrase.trim().toLowerCase(),
        ),
      };
  }
}
