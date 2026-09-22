import type { Classification } from './classification';

/** What the presentation layer should do with a card. */
export type FilterAction = 'allow' | 'warn' | 'hide';

/** Why the policy produced its decision — coarse buckets used by UI/review. */
export type DecisionReason = 'disabled' | 'user-rule' | 'channel-rule' | 'correction' | 'automatic';

export interface FilterDecision {
  action: FilterAction;
  reason: DecisionReason;
  /** Present when the decision was derived from a classification. */
  classification?: Classification | undefined;
  /** Human-readable explanation lines, safe to render as text. */
  explanation: string[];
  /** Machine-readable source, e.g. rule id `video-allow:dQw4`. */
  ruleId?: string | undefined;
  /** Rule-pack version that produced this decision (shown in Why details). */
  rulesVersion?: string | undefined;
  /** Classifier version that produced this decision (shown in Why details). */
  classifierVersion?: string | undefined;
}
