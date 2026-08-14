import { describe, expect, it } from 'vitest';

import {
  formatMemberFields,
  parseMeetupMemberId,
} from '../../../src/lib/helpers/whois.js';
import { MemberRecord } from '../../../src/lib/repositories/types.js';

const linkedRow: MemberRecord = {
  discordUserId: 'discord-1',
  meetupId: '186893524',
  meetupName: 'Test User',
  meetupMemberUrl: 'https://www.meetup.com/members/186893524/',
  onboardMethod: 'self_onboard',
  onboardedBy: null,
  firstOnboardedAt: new Date('2026-08-14T17:00:00Z'),
  lastSyncedAt: new Date('2026-08-15T17:00:00Z'),
};

const manualRow: MemberRecord = {
  ...linkedRow,
  meetupId: null,
  meetupName: null,
  meetupMemberUrl: null,
  onboardMethod: 'manual',
  onboardedBy: 'mod-1',
};

describe('parseMeetupMemberId', () => {
  it('accepts a raw numeric ID', () => {
    expect(parseMeetupMemberId('186893524')).toBe('186893524');
    expect(parseMeetupMemberId('  186893524  ')).toBe('186893524');
  });

  it('extracts the ID from profile URL variants', () => {
    expect(
      parseMeetupMemberId('https://www.meetup.com/members/186893524/'),
    ).toBe('186893524');
    expect(parseMeetupMemberId('meetup.com/members/186893524')).toBe(
      '186893524',
    );
    expect(
      parseMeetupMemberId('https://www.meetup.com/members/186893524/?op=1'),
    ).toBe('186893524');
  });

  it('accepts locale-prefixed profile URLs', () => {
    expect(
      parseMeetupMemberId('https://www.meetup.com/es/members/186893524/'),
    ).toBe('186893524');
    expect(
      parseMeetupMemberId('https://www.meetup.com/en-US/members/186893524/'),
    ).toBe('186893524');
  });

  it('rejects input without a member ID', () => {
    expect(parseMeetupMemberId('hello')).toBeUndefined();
    expect(parseMeetupMemberId('https://www.meetup.com/1-5-gen-asians/')).toBe(
      undefined,
    );
    expect(parseMeetupMemberId('')).toBeUndefined();
  });

  it('rejects lookalike domains', () => {
    expect(
      parseMeetupMemberId('https://fakemeetup.com/members/123456/'),
    ).toBeUndefined();
    expect(
      parseMeetupMemberId('https://evil-meetup.com/members/123456/'),
    ).toBeUndefined();
    expect(
      parseMeetupMemberId('https://evil.meetup.com/members/123456/'),
    ).toBeUndefined();
    expect(
      parseMeetupMemberId('https://meetup.com.evil.com/members/123456/'),
    ).toBeUndefined();
    expect(
      parseMeetupMemberId('https://meetup.com@evil.com/members/123456/'),
    ).toBeUndefined();
  });

  it('rejects meetup.com embedded in a hostile URL path', () => {
    expect(
      parseMeetupMemberId('https://evil.com/meetup.com/members/123456/'),
    ).toBeUndefined();
    expect(
      parseMeetupMemberId('https://evil.com/www.meetup.com/members/123456/'),
    ).toBeUndefined();
  });

  it('accepts mixed-case hosts (hostnames are case-insensitive)', () => {
    expect(parseMeetupMemberId('https://Meetup.com/members/186893524/')).toBe(
      '186893524',
    );
    expect(
      parseMeetupMemberId('https://WWW.MEETUP.COM/members/186893524/'),
    ).toBe('186893524');
  });
});

describe('formatMemberFields', () => {
  it('formats a linked row with profile link, ID, and timestamps', () => {
    const fields = formatMemberFields(linkedRow);
    const byName = Object.fromEntries(fields.map((f) => [f.name, f.value]));

    expect(byName['Discord user']).toBe('<@discord-1>');
    expect(byName['Meetup account']).toBe(
      '[Test User](https://www.meetup.com/members/186893524/)',
    );
    expect(byName['Meetup ID']).toBe('186893524');
    expect(byName['Onboard method']).toBe('self_onboard');
    expect(byName['First onboarded']).toMatch(/^<t:\d+:D>$/);
    expect(byName['Last synced']).toMatch(/^<t:\d+:D>$/);
    expect(byName['Onboarded by']).toBeUndefined();
  });

  it('formats a manual row as not linked with the onboarding mod', () => {
    const fields = formatMemberFields(manualRow);
    const byName = Object.fromEntries(fields.map((f) => [f.name, f.value]));

    expect(byName['Meetup account']).toBe('not linked');
    expect(byName['Meetup ID']).toBeUndefined();
    expect(byName['Onboard method']).toBe('manual');
    expect(byName['Onboarded by']).toBe('<@mod-1>');
  });
});
