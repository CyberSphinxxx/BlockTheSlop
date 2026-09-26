import { afterEach, describe, expect, it } from 'vitest';
import { HideActivityNotice } from '@/presentation/activity';

afterEach(() => {
  document.body.innerHTML = '';
});

describe('personal feedback', () => {
  it('counts distinct hidden videos and clears the notice on restoration', () => {
    document.body.innerHTML = `
      <div data-bts-state="hidden" data-bts-video-id="one"></div>
      <div data-bts-state="hidden" data-bts-video-id="one"></div>
      <div data-bts-state="hidden" data-bts-video-id="two"></div>`;
    const activity = new HideActivityNotice();
    activity.update();
    expect(document.querySelector('.bts-activity-notice')?.textContent).toContain(
      '2 videos hidden',
    );
    document
      .querySelectorAll('[data-bts-state]')
      .forEach((card) => card.removeAttribute('data-bts-state'));
    activity.update();
    expect(document.querySelector('.bts-activity-notice')).toBeNull();
    activity.clear();
  });
});
