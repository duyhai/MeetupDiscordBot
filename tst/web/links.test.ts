import { describe, expect, it } from 'vitest';

import {
  discordProfileUrl,
  discordUserLink,
  eventLink,
  meetupProfileUrl,
  memberLink,
} from '../../src/web/links.js';

describe('links', () => {
  it('refuses non-digit ids', () => {
    expect(meetupProfileUrl('12a')).toBeUndefined();
    expect(meetupProfileUrl(' 1')).toBeUndefined();
    expect(meetupProfileUrl('1 ')).toBeUndefined();
    expect(meetupProfileUrl('')).toBeUndefined();
    expect(meetupProfileUrl(123)).toBeUndefined();
    expect(meetupProfileUrl('javascript:1')).toBeUndefined();
    expect(meetupProfileUrl('1/../../evil')).toBeUndefined();
    expect(meetupProfileUrl('123')).toBe('https://www.meetup.com/members/123/');
  });

  it('refuses 21-digit ids', () => {
    expect(meetupProfileUrl('1'.repeat(21))).toBeUndefined();
    expect(meetupProfileUrl('1'.repeat(20))).toBe(
      `https://www.meetup.com/members/${'1'.repeat(20)}/`,
    );
  });

  it('discord ids need 17-20 digits', () => {
    expect(discordProfileUrl('1'.repeat(16))).toBeUndefined();
    expect(discordProfileUrl('1'.repeat(21))).toBeUndefined();
    expect(discordProfileUrl(123456789012345678)).toBeUndefined();
    expect(discordProfileUrl('12345678901234567a')).toBeUndefined();
    expect(discordProfileUrl('123456789012345678')).toBe(
      'https://discord.com/users/123456789012345678',
    );
    expect(discordProfileUrl('1'.repeat(17))).toBe(
      `https://discord.com/users/${'1'.repeat(17)}`,
    );
    expect(discordProfileUrl('1'.repeat(20))).toBe(
      `https://discord.com/users/${'1'.repeat(20)}`,
    );
  });

  it('memberLink escapes and isolates the name', () => {
    const out = memberLink({
      id: '1',
      name: '<img src=x onerror=alert(1)>‮',
    }).value;
    expect(out).toContain('&lt;img');
    expect(out).toContain('<bdi>');
    expect(out).not.toContain('<img');
    expect(out).toContain('href="https://www.meetup.com/members/1/"');
  });

  it('memberLink falls back to text for a bad id or a missing name', () => {
    const out = memberLink({ id: '1a', name: undefined }).value;
    expect(out).toBe('<bdi>Unknown member</bdi>');
  });

  it('memberLink ignores a payload memberUrl', () => {
    const member = {
      id: 'x',
      name: 'A',
      memberUrl: 'https://evil.example/',
    };
    const out = memberLink(member).value;
    expect(out).not.toContain('href');
    expect(out).not.toContain('evil');
    expect(out).toBe('<bdi>A</bdi>');
  });

  it('event links pass safeHref or render as text', () => {
    const good = eventLink({
      title: 'Board games',
      eventUrl: 'https://www.meetup.com/1-5genasians/events/1/',
    }).value;
    expect(good).toContain(
      'href="https://www.meetup.com/1-5genasians/events/1/"',
    );
    for (const eventUrl of [
      'javascript:alert(1)',
      'https://evil.example/',
      'http://www.meetup.com/x',
      'https://www.meetup.com.evil.example/',
      42,
      undefined,
    ]) {
      const out = eventLink({ title: '<b>T</b>', eventUrl }).value;
      expect(out).not.toContain('<a');
      expect(out).toBe('<bdi>&lt;b&gt;T&lt;/b&gt;</bdi>');
    }
    expect(eventLink({ title: 7, eventUrl: undefined }).value).toBe(
      '<bdi>Untitled event</bdi>',
    );
  });

  it('external links carry rel and target', () => {
    const outs = [
      memberLink({ id: '1', name: 'A' }).value,
      eventLink({
        title: 'E',
        eventUrl: 'https://www.meetup.com/1-5genasians/events/1/',
      }).value,
      discordUserLink('123456789012345678', 'profile').value,
    ];
    for (const out of outs) {
      expect(out).toMatch(
        /^<a href="https:\/\/[^"]+" rel="noopener noreferrer" target="_blank">/,
      );
    }
  });

  it('discordUserLink escapes the label and links only a real id', () => {
    expect(discordUserLink('abc', '<x>').value).toBe('&lt;x&gt;');
    expect(discordUserLink('123456789012345678', '<x>').value).toContain(
      '>&lt;x&gt;</a>',
    );
  });
});
