/**
 * V6-10: on-page activity indicator placement.
 *
 * 'off' is a real, honored choice — when selected, NO chip is ever injected
 * into the page. The default when enabled is bottom-right (the position the
 * chip has always occupied), and corners keep clear of YouTube's own player
 * controls via inset offsets sized to clear the progress bar and buttons.
 */

export const ACTIVITY_POSITIONS = [
  'off',
  'top-left',
  'top-right',
  'bottom-left',
  'bottom-right',
] as const;

export type ActivityIndicatorPosition = (typeof ACTIVITY_POSITIONS)[number];

export function defaultActivityIndicator(): { position: ActivityIndicatorPosition } {
  return { position: 'bottom-right' };
}

/** Repair unknown/corrupt values to the default; 'off' is honored as itself. */
export function resolveIndicatorPosition(value: string | undefined): ActivityIndicatorPosition {
  if (value !== undefined && (ACTIVITY_POSITIONS as readonly string[]).includes(value)) {
    return value as ActivityIndicatorPosition;
  }
  return 'bottom-right';
}

/** CSS modifier class for a position; 'off' maps to null (chip removed). */
export function activityPositionClass(position: ActivityIndicatorPosition): string | null {
  if (position === 'off') return null;
  return `bts-activity-pos-${position}`;
}
