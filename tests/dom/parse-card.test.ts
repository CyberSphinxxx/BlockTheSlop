import { describe, expect, it } from 'vitest';
import {
  AI_DISCLOSURE_CARD_HTML,
  AI_DISCUSSION_CARD_HTML,
  HUMAN_CARD_HTML,
  MALFORMED_CARD_HTML,
  MISSING_FIELDS_CARD_HTML,
  SHORTS_SHELF_CARD_HTML,
  UNICODE_CARD_HTML,
  parseFixture,
} from '../fixtures/youtube';
import { parseShortsShelfCard } from '@/youtube/parse/shorts';
import { pageContextFromUrl, videoIdFromUrl, channelIdentityFromHref } from '@/youtube/routes';

describe('card parser', () => {
  it('extracts a complete human card', () => {
    const { candidate } = parseFixture(HUMAN_CARD_HTML);
    expect(candidate.videoId).toBe('human123');
    expect(candidate.title).toBe('How pancakes were invented in 1832');
    expect(candidate.channel.channelId).toBe('UCHumanChannel1234567890ab');
    expect(candidate.channel.displayName).toBe('History Corner');
    expect(candidate.officialDisclosure).toBeUndefined();
    expect(candidate.isShort).toBe(false);
    expect(candidate.surface).toBe('home');
  });

  it('detects official disclosure badges', () => {
    const { candidate } = parseFixture(AI_DISCLOSURE_CARD_HTML);
    expect(candidate.officialDisclosure?.present).toBe(true);
    expect(candidate.officialDisclosure?.text?.toLowerCase()).toContain('altered or synthetic');
    expect(candidate.channel.handle).toBe('pastreimagined');
    expect(candidate.channel.channelId).toBeUndefined();
  });

  it('parses AI discussion cards without disclosure', () => {
    const { candidate } = parseFixture(AI_DISCLOSURE_CARD_HTML);
    void candidate;
    const discussion = parseFixture(AI_DISCUSSION_CARD_HTML, 'search');
    expect(discussion.candidate.officialDisclosure).toBeUndefined();
    expect(discussion.candidate.title).toContain('AI slop');
    expect(discussion.candidate.surface).toBe('search');
  });

  it('handles cards with missing fields safely', () => {
    const { candidate } = parseFixture(MISSING_FIELDS_CARD_HTML);
    expect(candidate.videoId).toBe('partial9');
    expect(candidate.title).toBe('');
    expect(candidate.channel.channelId).toBeUndefined();
  });

  it('never throws on malformed markup', () => {
    expect(() => parseFixture(MALFORMED_CARD_HTML)).not.toThrow();
  });

  it('supports Unicode titles and handles', () => {
    const { candidate } = parseFixture(UNICODE_CARD_HTML);
    expect(candidate.channel.handle).toBe('juanadelacruz');
    expect(candidate.title.length).toBeGreaterThan(0);
  });

  it('parses shorts shelf cards', () => {
    const el = document.createElement('template');
    el.innerHTML = SHORTS_SHELF_CARD_HTML.trim();
    const node = el.content.firstElementChild;
    if (!node) throw new Error('fixture broken');
    const candidate = parseShortsShelfCard(node, 'shorts-shelf', 123);
    expect(candidate.videoId).toBe('shortid01');
    expect(candidate.isShort).toBe(true);
    expect(candidate.surface).toBe('shorts-shelf');
  });
});

describe('routes', () => {
  it('maps YouTube paths to surfaces', () => {
    expect(pageContextFromUrl('https://www.youtube.com/').surface).toBe('home');
    expect(pageContextFromUrl('https://www.youtube.com/results?search_query=ai').surface).toBe(
      'search',
    );
    expect(pageContextFromUrl('https://www.youtube.com/watch?v=abc').surface).toBe('watch-sidebar');
    expect(pageContextFromUrl('https://www.youtube.com/feed/subscriptions').surface).toBe(
      'subscriptions',
    );
    expect(pageContextFromUrl('https://www.youtube.com/feed/history').surface).toBe('history');
    expect(pageContextFromUrl('https://www.youtube.com/playlist?list=PL1').surface).toBe(
      'playlist',
    );
    expect(pageContextFromUrl('https://www.youtube.com/@somechannel/videos').surface).toBe(
      'channel',
    );
    expect(pageContextFromUrl('https://www.youtube.com/channel/UCxyz/videos').surface).toBe(
      'channel',
    );
    expect(pageContextFromUrl('https://www.youtube.com/shorts/abc123').surface).toBe('shorts-feed');
  });

  it('fails open on unknown paths', () => {
    expect(pageContextFromUrl('https://www.youtube.com/whatever-new').surface).toBe('unknown');
    expect(pageContextFromUrl('not a url').surface).toBe('unknown');
  });

  it('extracts video ids from url forms', () => {
    expect(videoIdFromUrl('/watch?v=abc123')).toBe('abc123');
    expect(videoIdFromUrl('/shorts/xyz99')).toBe('xyz99');
    expect(videoIdFromUrl('/feed/subscriptions')).toBeUndefined();
  });

  it('extracts channel identity from hrefs', () => {
    expect(channelIdentityFromHref('/channel/UCabc123')).toEqual({ channelId: 'UCabc123' });
    expect(channelIdentityFromHref('/@handle')).toEqual({ handle: 'handle' });
    // Legacy /user/ aliases are unresolved aliases, not verified handles (A21).
    expect(channelIdentityFromHref('/user/legacyname')).toEqual({ legacyAlias: 'legacyname' });
    expect(channelIdentityFromHref('/c/legacyname')).toEqual({ legacyAlias: 'legacyname' });
    expect(channelIdentityFromHref('javascript:void(0)')).toEqual({});
  });
});
