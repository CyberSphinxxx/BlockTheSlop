import { beforeEach, describe, expect, it } from 'vitest';
import { HideActivityNotice } from '@/presentation/activity';
import {
  ACTIVITY_POSITIONS,
  activityPositionClass,
  defaultActivityIndicator,
  resolveIndicatorPosition,
} from '@/presentation/indicator-position';

describe('indicator position domain (V6-10)', () => {
  it('offers Off plus four corners, defaulting to bottom-right', () => {
    expect([...ACTIVITY_POSITIONS]).toEqual([
      'off',
      'top-left',
      'top-right',
      'bottom-left',
      'bottom-right',
    ]);
    expect(defaultActivityIndicator().position).toBe('bottom-right');
  });

  it('resolves corrupt values to the default (never throws, never hides the chip silently)', () => {
    expect(resolveIndicatorPosition('top-left')).toBe('top-left');
    expect(resolveIndicatorPosition(undefined)).toBe('bottom-right');
    expect(resolveIndicatorPosition('center')).toBe('bottom-right');
    // 'off' is a REAL user choice and resolves to itself.
    expect(resolveIndicatorPosition('off')).toBe('off');
  });

  it('maps positions to CSS classes; off maps to null (no chip at all)', () => {
    expect(activityPositionClass('bottom-right')).toBe('bts-activity-pos-bottom-right');
    expect(activityPositionClass('top-left')).toBe('bts-activity-pos-top-left');
    expect(activityPositionClass('off')).toBeNull();
  });
});

describe('chip position behavior (V6-10)', () => {
  let notice: HideActivityNotice;

  beforeEach(() => {
    document.body.innerHTML = '';
    notice = new HideActivityNotice();
  });

  it('chip lands bottom-right by default and respects each position', () => {
    document.body.innerHTML = '<div data-bts-state="hidden" data-bts-video-id="v1"></div>';
    notice.setLabelOverrideForTests(() => 'bottom-right');
    notice.update();
    const chip = document.querySelector('.bts-activity-notice');
    expect(chip).not.toBeNull();
    expect(chip?.classList.contains('bts-activity-pos-bottom-right')).toBe(true);

    notice.setLabelOverrideForTests(() => 'top-left');
    notice.update();
    expect(
      document
        .querySelector('.bts-activity-notice')
        ?.classList.contains('bts-activity-pos-top-left'),
    ).toBe(true);
  });

  it('Off removes the existing chip and never injects UI', () => {
    document.body.innerHTML = '<div data-bts-state="hidden" data-bts-video-id="v1"></div>';
    notice.setLabelOverrideForTests(() => 'bottom-right');
    notice.update();
    expect(document.querySelector('.bts-activity-notice')).not.toBeNull();

    notice.setLabelOverrideForTests(() => 'off');
    notice.update();
    expect(document.querySelector('.bts-activity-notice')).toBeNull();

    notice.setLabelOverrideForTests(() => 'top-right');
    notice.update();
    expect(document.querySelector('.bts-activity-notice')).not.toBeNull();
  });
});
