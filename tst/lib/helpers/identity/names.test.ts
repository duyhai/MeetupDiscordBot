import { describe, expect, it } from 'vitest';

import {
  discordDisplayName,
  displayNameFor,
  escapeDiscordText,
  identityNameKey,
  meetupProfileUrl,
} from '../../../../src/lib/helpers/identity/names.js';

describe('discordDisplayName', () => {
  it('prefers the server nickname, which is what organizers see in the guild', () => {
    expect(
      discordDisplayName({
        nickname: 'Nick',
        globalName: 'Global',
        username: 'user',
      }),
    ).toBe('Nick');
  });

  it('falls back to the global display name, then the username', () => {
    expect(
      discordDisplayName({
        nickname: null,
        globalName: 'Global',
        username: 'user',
      }),
    ).toBe('Global');
    expect(
      discordDisplayName({
        nickname: null,
        globalName: null,
        username: 'user',
      }),
    ).toBe('user');
  });

  it('skips a blank value rather than rendering an empty name', () => {
    expect(
      discordDisplayName({ nickname: '  ', globalName: '', username: 'user' }),
    ).toBe('user');
  });

  it('returns null when nothing is stored', () => {
    expect(
      discordDisplayName({ nickname: null, globalName: null, username: null }),
    ).toBeNull();
  });
});

describe('meetupProfileUrl', () => {
  it('builds the member profile url', () => {
    expect(meetupProfileUrl('279964402')).toBe(
      'https://www.meetup.com/members/279964402/',
    );
  });

  it('refuses a non-numeric id, which could otherwise smuggle markup into the url', () => {
    expect(meetupProfileUrl('1) [x](https://evil.example')).toBeUndefined();
    expect(meetupProfileUrl('')).toBeUndefined();
  });
});

describe('displayNameFor', () => {
  const subject = {
    platform: 'meetup' as const,
    scopeId: 's1',
    subjectId: 'm1',
  };

  it('finds a name by platform, scope and subject', () => {
    const names = new Map([[identityNameKey('meetup', 's1', 'm1'), 'Jane D.']]);

    expect(displayNameFor(subject, names)).toBe('Jane D.');
  });

  it('does not hand a Discord member the name of a Meetup member with the same id', () => {
    const names = new Map([[identityNameKey('meetup', 's1', 'm1'), 'Jane D.']]);

    expect(
      displayNameFor({ ...subject, platform: 'discord' }, names),
    ).toBeUndefined();
  });

  it('treats a blank stored name as missing', () => {
    const names = new Map([[identityNameKey('meetup', 's1', 'm1'), '   ']]);

    expect(displayNameFor(subject, names)).toBeUndefined();
  });
});

describe('escapeDiscordText', () => {
  it('leaves an ordinary name readable', () => {
    expect(escapeDiscordText('Ngò 🌿')).toBe('Ngò 🌿');
    expect(escapeDiscordText("Jane O'Neil D.")).toBe("Jane O'Neil D.");
  });

  it('escapes markdown emphasis and code', () => {
    expect(escapeDiscordText('*a* _b_ ~c~ `d` ||e||')).toBe(
      '\\*a\\* \\_b\\_ \\~c\\~ \\`d\\` \\|\\|e\\|\\|',
    );
  });

  it('escapes the characters that could close link text or start a link', () => {
    expect(escapeDiscordText('x](https://evil.example) [y')).toBe(
      'x\\]\\(https\\://evil.example\\) \\[y',
    );
  });

  it('defuses user, role and everyone mentions', () => {
    expect(escapeDiscordText('<@123> <@&456> @everyone @here')).toBe(
      '\\<\\@123\\> \\<\\@&456\\> \\@everyone \\@here',
    );
  });

  it('escapes a backslash so it cannot cancel the escape that follows it', () => {
    expect(escapeDiscordText('a\\*b*')).toBe('a\\\\\\*b\\*');
  });

  it('flattens newlines so a name cannot forge a second digest row', () => {
    expect(escapeDiscordText('Jane\n18:14  Meetup  fake row\r\n\tx')).toBe(
      'Jane 18\\:14 Meetup fake row x',
    );
  });

  it('drops bidi overrides and zero-width characters', () => {
    expect(escapeDiscordText('ab\u202Ecd\u200B\u2066ef')).toBe('abcdef');
  });

  it('truncates an over-long name by code point before escaping', () => {
    const out = escapeDiscordText('🌿'.repeat(100), 10);

    expect(Array.from(out)).toHaveLength(11);
    expect(out.endsWith('…')).toBe(true);
    // A cut through a surrogate pair would leave a lone half behind.
    expect(out).toBe(`${'🌿'.repeat(10)}…`);
  });

  it('never ends on a dangling backslash after truncation', () => {
    // Truncating AFTER escaping could cut between a backslash and the
    // character it escapes, leaving the backslash to eat whatever markup the
    // caller appends next (the closing "]" of the link text).
    expect(escapeDiscordText('*'.repeat(50), 5)).toBe(`${'\\*'.repeat(5)}…`);
  });
});
