import type { Classification } from '@/domain/classification';
import type { FilterAction, FilterDecision } from '@/domain/decision';
import type { EvidenceCategory } from '@/domain/evidence';
import { AI_CATEGORIES, SLOP_CATEGORIES } from '@/domain/evidence';
import type { UserSettings } from '@/domain/settings';
import { getRuleIndex, normalizeFallbackHandle, type UserRules } from '@/domain/rules';
import { explainClassification } from '@/detection/explain';
import { normalizeHandle } from '@/domain/video';

const AI_CATEGORY_SET: ReadonlySet<string> = new Set<string>(AI_CATEGORIES);
const SLOP_CATEGORY_SET: ReadonlySet<string> = new Set<string>(SLOP_CATEGORIES);

/**
 * Decision precedence (PRODUCT_SPEC.md §6) — the single source of truth:
 *
 * 1. extension disabled                 → allow untouched
 * 2. explicit video allow               → allow
 * 3. explicit video block               → hide
 * 4. explicit channel allow             → allow unless video separately blocked (3 wins)
 * 5. explicit channel block             → hide
 * 6. personal correction (Not AI/slop)  → allow + personal evidence
 * 7. category policy + automatic scores → warn/hide per thresholds
 * 8. remote hints                       → feed detection (already in classification)
 * 9. default                            → allow
 */
export const DECISION_PRECEDENCE_DOC = `
1. disabled -> allow
2. video allow -> allow
3. video block -> hide
4. channel allow -> allow (unless video blocked)
5. channel block -> hide
6. personal correction -> allow
7. category policy + automatic scores
8. remote hints (via classification)
9. default allow
`.trim();

/**
 * Mode thresholds. Configuration constants, never duplicated magic numbers
 * (PRODUCT_SPEC.md §7). Keys are per-mode warn/hide cutoffs on the
 * classification's dominant likelihood score.
 */
export interface ModeThresholds {
  warnBelow: number;
  hideAt: number;
  /** Confidence classes eligible for hiding in this mode. */
  hideConfidence: readonly Classification['confidence'][];
  /** Confidence classes eligible for warning in this mode. */
  warnConfidence: readonly Classification['confidence'][];
}

export const MODE_THRESHOLDS: Record<UserSettings['mode'], ModeThresholds> = {
  safe: {
    // Hide only very high-confidence content; prefer false negatives.
    hideAt: 0.85,
    warnBelow: 0.95,
    hideConfidence: ['very-high'],
    warnConfidence: ['high', 'very-high'],
  },
  balanced: {
    hideAt: 0.7,
    warnBelow: 0.85,
    hideConfidence: ['high', 'very-high'],
    warnConfidence: ['medium', 'high', 'very-high'],
  },
  strict: {
    // Hide moderate/high; warn lower. Increased false-positive risk is
    // surfaced in the options UI.
    hideAt: 0.45,
    warnBelow: 0.7,
    hideConfidence: ['medium', 'high', 'very-high'],
    warnConfidence: ['low', 'medium', 'high', 'very-high'],
  },
  aggressive: {
    // V4-03: explicit opt-in recall preset. Hides on lower scores and admits
    // 'low' confidence — this DOES accept false positives (measured on the
    // frozen eval set, recorded in .agents/block-the-slop-v4/). Metadata
    // absence still never hides (no signal → no score), and thumbnail-only,
    // unknown-visible and correction-history semantics are unchanged.
    hideAt: 0.35,
    warnBelow: 0.55,
    hideConfidence: ['low', 'medium', 'high', 'very-high'],
    warnConfidence: ['low', 'medium', 'high', 'very-high'],
  },
};

export interface PolicyInput {
  settings: UserSettings;
  rules: UserRules;
  candidate: {
    videoId?: string | undefined;
    channelId?: string | undefined;
    handle?: string | undefined;
    /** Card title — the only text a literal phrase rule may match. */
    title?: string | undefined;
  };
  classification?: Classification | undefined;
  /** Active automatic channel blocks (V5-08). */
  activeAutoChannels?: ReadonlySet<string> | undefined;
  /** User marked this exact video as Not AI / Not slop in the review queue. */
  correctedNotAi?: boolean | undefined;
  correctedNotSlop?: boolean | undefined;
}

/** Resolve the effective action for a category ('inherit' → undefined). */
function categoryAction(
  settings: UserSettings,
  category: EvidenceCategory,
): FilterAction | undefined {
  const action = settings.categoryActions[category];
  return action === 'inherit' ? undefined : action;
}

function ruleHit(
  rules: UserRules,
  candidate: PolicyInput['candidate'],
): {
  videoAllowed: boolean;
  videoBlocked: boolean;
  channelAllowed: boolean;
  channelBlocked: boolean;
  viaHandle: boolean;
} {
  const index = getRuleIndex(rules);
  const handle = normalizeHandle(candidate.handle);
  const normalizedFallback = handle !== undefined ? normalizeFallbackHandle(handle) : undefined;
  const videoAllowed =
    candidate.videoId !== undefined && index.allowedVideoIds.has(candidate.videoId);
  const videoBlocked =
    candidate.videoId !== undefined && index.blockedVideoIds.has(candidate.videoId);
  const channelAllowed =
    (candidate.channelId !== undefined && index.allowedChannelIds.has(candidate.channelId)) ||
    (normalizedFallback !== undefined && index.fallbackAllowedHandles.has(normalizedFallback));
  const channelBlocked =
    (candidate.channelId !== undefined && index.blockedChannelIds.has(candidate.channelId)) ||
    (normalizedFallback !== undefined && index.fallbackBlockedHandles.has(normalizedFallback));
  const viaHandle =
    candidate.channelId === undefined &&
    normalizedFallback !== undefined &&
    (index.fallbackAllowedHandles.has(normalizedFallback) ||
      index.fallbackBlockedHandles.has(normalizedFallback));
  return { videoAllowed, videoBlocked, channelAllowed, channelBlocked, viaHandle };
}

/** Decide the action for a card. Pure function — no DOM, no storage access. */
export function decide(input: PolicyInput): FilterDecision {
  const { settings, rules, candidate, classification } = input;

  // 1. Disabled → allow untouched.
  if (!settings.enabled) {
    return { action: 'allow', reason: 'disabled', explanation: ['Filtering is disabled.'] };
  }

  const hits = ruleHit(rules, candidate);

  // 2. Explicit video allow.
  if (hits.videoAllowed) {
    return {
      action: 'allow',
      reason: 'user-rule',
      ruleId: `video-allow:${candidate.videoId ?? ''}`,
      explanation: ['Allowed by your rule.'],
    };
  }

  // 3. Explicit video block (beats channel allow per documented precedence).
  if (hits.videoBlocked) {
    return {
      action: 'hide',
      reason: 'user-rule',
      ruleId: `video-block:${candidate.videoId ?? ''}`,
      explanation: ['Hidden by your rule.'],
    };
  }

  // 4. Explicit channel allow.
  if (hits.channelAllowed) {
    return {
      action: 'allow',
      reason: 'channel-rule',
      ruleId: `channel-allow:${candidate.channelId ?? candidate.handle ?? ''}`,
      explanation: ['This channel is on your allow list.'],
    };
  }

  // 5. Explicit channel block.
  if (hits.channelBlocked) {
    return {
      action: 'hide',
      reason: 'channel-rule',
      ruleId: `channel-block:${candidate.channelId ?? candidate.handle ?? ''}`,
      explanation: ['Hidden because this channel is on your block list.'],
    };
  }

  // 5b. Literal phrase rules (CFG-05 + V7-09): case-insensitive match on the
  // title only — never search-box text, sibling cards, or URLs. Two modes:
  // legacy substring (`blockedPhrases`) and whole-word (`blockedPhraseRules`,
  // Unicode-aware boundaries). The phrase is LITERAL text — regex
  // metacharacters are escaped, never interpreted. Personal corrections do
  // NOT override phrase rules: a deliberate, persistent user expression
  // about this title text.
  const title = candidate.title ?? '';
  const index = getRuleIndex(rules);
  if (title.length > 0) {
    const lowerTitle = title.toLowerCase();
    const matched = index.blockedPhrasesLower.find(
      (phrase) => phrase.length > 0 && lowerTitle.includes(phrase),
    );
    if (matched !== undefined) {
      return {
        action: 'hide',
        reason: 'user-rule',
        ruleId: 'phrase-block',
        explanation: [`Hidden by your rule: titles containing “${matched}”.`],
      };
    }
    // V7-09: whole-word rules. Single-token rules are a tokenized Set lookup
    // (O(words in title), independent of rule count — 10k rules stay fast);
    // multi-word rules use once-compiled escaped-literal matchers.
    if (index.blockedSingleWords.size > 0 || index.blockedMultiWordMatchers.length > 0) {
      const tokens = title
        .toLowerCase()
        .split(/[^^\p{L}\p{N}_]+/u)
        .filter(Boolean);
      const single = tokens.find((token) => index.blockedSingleWords.has(token));
      if (single !== undefined) {
        return {
          action: 'hide',
          reason: 'user-rule',
          ruleId: 'phrase-block',
          explanation: [`Hidden by your rule: titles containing the whole word “${single}”.`],
        };
      }
      const multi = index.blockedMultiWordMatchers.find((matcher) => matcher.test(title));
      if (multi !== undefined) {
        return {
          action: 'hide',
          reason: 'user-rule',
          ruleId: 'phrase-block',
          explanation: [
            `Hidden by your rule: titles containing the whole phrase “${multi.phrase}”.`,
          ],
        };
      }
    }
  }

  // 5c. Opt-in Automatic Channel Block (V5-08):
  // Operates only when autoChannel is enabled and channel is in activeAutoChannels.
  // Precedence: explicit video/channel allow rules beat this (already checked in 2 & 4).
  // Personal Not-AI correction on this video overrides this automatic AI channel block.
  if (
    settings.autoChannel?.enabled &&
    input.activeAutoChannels !== undefined &&
    candidate.channelId !== undefined &&
    input.activeAutoChannels.has(candidate.channelId) &&
    input.correctedNotAi !== true
  ) {
    return {
      action: 'hide',
      reason: 'channel-rule',
      ruleId: `auto-channel:${candidate.channelId}`,
      explanation: [
        'Hidden because this channel was automatically blocked for repeated AI-generated videos (opt-in).',
      ],
    };
  }

  // 6. Personal corrections — DIMENSIONAL (DET-26/27, audit A14): Not-AI
  // suppresses only the AI dimension; Not-slop only the slop dimension. A
  // correction on one dimension never whitewashes independent evidence on
  // the other.
  if (input.correctedNotAi === true || input.correctedNotSlop === true) {
    if (classification === undefined) {
      return {
        action: 'allow',
        reason: 'correction',
        explanation: ['You marked this content as a false positive.'],
      };
    }
    const decision = automaticDecision(settings, classification, {
      correctedNotAi: input.correctedNotAi,
      correctedNotSlop: input.correctedNotSlop,
    });
    // When the correction decides the outcome (allow), it is the reason; when
    // independent evidence on the OTHER dimension still hides, the decision
    // stays automatic and the correction line appears in the explanation.
    if (decision.action === 'allow') {
      return { ...decision, reason: 'correction' };
    }
    return decision;
  }

  // 9 (early). No classification → default allow.
  if (classification === undefined) {
    return { action: 'allow', reason: 'automatic', explanation: [] };
  }

  return automaticDecision(settings, classification);
}

/**
 * Automatic decision from classification + mode + category policy (step 7).
 *
 * Category precedence (DET-25): the most restrictive action among ALL
 * categories with a non-inherit override wins — `allow < warn < hide` — and
 * the mode thresholds gate that outcome. This makes 'Allow music' + 'Hide
 * visuals' behave independently: a music allowance never exempts matched
 * visual evidence, and vice versa.
 */
function automaticDecision(
  settings: UserSettings,
  classification: Classification,
  corrections: {
    correctedNotAi?: boolean | undefined;
    correctedNotSlop?: boolean | undefined;
  } = {},
): FilterDecision {
  const thresholds = MODE_THRESHOLDS[settings.mode];

  // Dimensional corrections zero the corrected dimension BEFORE any scoring,
  // so independent evidence on the other dimension still applies (DET-26/27).
  const correctedCategories = {} as Partial<Record<EvidenceCategory, number>>;
  for (const [category, score] of Object.entries(classification.categories)) {
    if (score === undefined) continue;
    const isAiCat = AI_CATEGORY_SET.has(category as EvidenceCategory);
    const isSlopCat = SLOP_CATEGORY_SET.has(category as EvidenceCategory);
    if (corrections.correctedNotAi === true && isAiCat) continue;
    if (corrections.correctedNotSlop === true && isSlopCat) continue;
    correctedCategories[category as EvidenceCategory] = score;
  }
  const effective: Classification = {
    ...classification,
    aiLikelihood: corrections.correctedNotAi === true ? 0 : classification.aiLikelihood,
    slopLikelihood: corrections.correctedNotSlop === true ? 0 : classification.slopLikelihood,
    categories: correctedCategories,
  };
  const explanation = explainClassification(classification);
  if (corrections.correctedNotAi === true || corrections.correctedNotSlop === true) {
    explanation.unshift('You marked part of this content as a false positive.');
  }

  // Dominant score across both dimensions drives mode thresholds.
  const dominant = Math.max(effective.aiLikelihood, effective.slopLikelihood);

  // Collect every explicit (non-inherit) category action present.
  const overriddenCategories: EvidenceCategory[] = [];
  for (const [category, score] of Object.entries(effective.categories)) {
    if (score === undefined) continue;
    const action = categoryAction(settings, category as EvidenceCategory);
    if (action !== undefined) overriddenCategories.push(category as EvidenceCategory);
  }

  // Most restrictive override wins; ties fall back to the highest-scoring
  // category for explanation purposes.
  const RESTRICTION: Record<'allow' | 'warn' | 'hide', number> = { allow: 0, warn: 1, hide: 2 };
  let categoryOverride: 'allow' | 'warn' | 'hide' | undefined;
  let overrideScore = -1;
  // N03: the strongest score among categories whose user override is 'hide' —
  // a forced hide must be backed by THAT category's own evidence.
  let forcedHideScore = -1;
  for (const category of overriddenCategories) {
    const action = categoryAction(settings, category);
    if (action === undefined) continue;
    const score = effective.categories[category] ?? 0;
    if (
      categoryOverride === undefined ||
      RESTRICTION[action] > RESTRICTION[categoryOverride] ||
      (RESTRICTION[action] === RESTRICTION[categoryOverride] && score > overrideScore)
    ) {
      categoryOverride = action;
      overrideScore = score;
    }
    if (action === 'hide' && score > forcedHideScore) forcedHideScore = score;
  }

  const meetsHideConfidence = thresholds.hideConfidence.includes(classification.confidence);
  const meetsHideScore = dominant >= thresholds.hideAt;
  const meetsWarn =
    thresholds.warnConfidence.includes(classification.confidence) ||
    dominant >= thresholds.warnBelow;
  /** Warning floor: warn never fires far below the hide threshold. */
  const warnScoreFloor = thresholds.hideAt * 0.6;

  // Per-category policy: a hard 'hide' on any present category forces hide
  // when confidence is at least medium (protection against weak evidence);
  // 'allow' downgrades everything to allow ONLY when it is the sole override;
  // 'warn' caps at warn.
  if (categoryOverride === 'allow' && overriddenCategories.length === 1) {
    return { action: 'allow', reason: 'automatic', classification, explanation };
  }

  // V4-02 (fixes the v4-kit baseline defect): the residual is computed
  // SOLELY from uncapped, scope-eligible category evidence. The previous
  // code re-injected the global dimension score (`dominant`) — which is
  // itself derived from the Warn-capped category — so a strong Warn-capped
  // category could hide through the "residual" route. A cap must mean: this
  // category's evidence can never push the decision past warn, no matter
  // how the dimension totals look.
  //
  // Eligibility for the residual (all must hold):
  // - the category's user override is NOT 'warn' (not capped),
  // - the category is not 'ai-thumbnail' (thumbnail-only evidence never
  //   proves the VIDEO — AGENTS.md evidence rules),
  // - the category is not itself a user-forced 'hide' (a forced hide uses
  //   its own floor route below; counting it as "residual backing" would
  //   let a forced category hide on its own weak evidence via the threshold
  //   route instead of its floor).
  let residualDominant = 0;
  let residualHasEligibleEvidence = false;
  for (const [category, score] of Object.entries(effective.categories)) {
    if (score === undefined) continue;
    const action = categoryAction(settings, category as EvidenceCategory);
    if (action === 'warn' || action === 'hide') continue;
    if (category === 'ai-thumbnail') continue;
    residualDominant = Math.max(residualDominant, score);
    residualHasEligibleEvidence = true;
  }

  const residualMeetsHideConfidence = thresholds.hideConfidence.includes(classification.confidence);
  // Blocker-6 companion guard: a category override's action applies ONLY to
  // its own category's evidence. Thumbnail-scoped evidence ('ai-thumbnail',
  // claimScope visual-thumbnail) must never drive a VIDEO hide on its own —
  // a thumbnail result is not a video result (AGENTS.md evidence rules) — so
  // a residual computed ONLY from thumbnail evidence is excluded from the
  // hide routes below. It can still warn.
  let residualIsThumbnailOnly = true;
  for (const [category, score] of Object.entries(effective.categories)) {
    if (score === undefined) continue;
    if (categoryAction(settings, category as EvidenceCategory) === 'warn') continue;
    if (category !== 'ai-thumbnail') residualIsThumbnailOnly = false;
  }
  if (residualDominant === 0) residualIsThumbnailOnly = false;

  // V4-02: route 1 (threshold hide) must also be backed by UNCAPPED,
  // scope-eligible category evidence. The dimension scores can be driven by
  // capped, forced, or thumbnail-only categories; when NO eligible evidence
  // exists the threshold route cannot fire (the residual route below has
  // the same requirement via residualHasEligibleEvidence).
  const hasUncappedBacking = residualHasEligibleEvidence;

  /**
   * Own-evidence floor for a user-forced category hide. A deliberate user
   * rule ("always hide this category") is a POLICY decision, not detector
   * output — it may hide when its own evidence is moderate, gated by the
   * per-mode confidence class that may hide (never 'low'). The floor keeps
   * junk evidence (score ≈ 0) from triggering the forced hide while still
   * honoring the user's explicit intent at medium confidence and above.
   */
  const forcedHideFloor = thresholds.hideAt * 0.7;

  // N03: when a category carries a forced 'hide' override, that category's
  // own evidence must BACK the hide route — an unrelated dimension score
  // (here: the ONLY category present is the forced one with score 0.05, so
  // the 0.95 dimension is unbacked by any non-forced evidence) must not
  // hide through the threshold routes either. Hide evidence must exist
  // INDEPENDENT of the forced category when that category's own score is
  // below the floor; forced categories themselves never count as that
  // independent backing.
  const forcedHideBackedIndependently =
    categoryOverride !== 'hide' ||
    forcedHideScore >= forcedHideFloor ||
    (() => {
      for (const [category, score] of Object.entries(effective.categories)) {
        if (score === undefined) continue;
        const action = categoryAction(settings, category as EvidenceCategory);
        if (
          category !== 'ai-thumbnail' &&
          action !== 'hide' &&
          action !== 'warn' &&
          score >= thresholds.hideAt
        ) {
          return true;
        }
      }
      return false;
    })();

  const canHide =
    (categoryOverride !== 'warn' &&
      meetsHideConfidence &&
      meetsHideScore &&
      hasUncappedBacking &&
      forcedHideBackedIndependently) ||
    // Warn-capped categories still let independent evidence hide (N03/V4-02).
    (residualHasEligibleEvidence &&
      residualDominant >= thresholds.hideAt &&
      residualMeetsHideConfidence &&
      !residualIsThumbnailOnly &&
      forcedHideBackedIndependently) ||
    // N03: a forced category hide requires that category's OWN evidence to
    // meet the mode's floor — the global confidence alone (possibly driven
    // by an unrelated category) must never hide on a user's per-category
    // rule with essentially no supporting score. The forced-hide floor keeps
    // junk evidence (score ≈ 0) from triggering the forced hide while still
    // honoring the user's explicit intent at medium confidence and above.
    (categoryOverride === 'hide' && forcedHideScore >= forcedHideFloor && forcedHideScore > 0);

  if (canHide) {
    return { action: 'hide', reason: 'automatic', classification, explanation };
  }
  if (categoryOverride === 'warn' || (meetsWarn && dominant >= warnScoreFloor)) {
    return { action: 'warn', reason: 'automatic', classification, explanation };
  }
  return { action: 'allow', reason: 'automatic', classification, explanation };
}
