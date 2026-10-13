import { describe, expect, it } from 'vitest';

import {
  discordDisplayName,
  displayNameFor,
  escapeDiscordLinkText,
  escapeDiscordText,
  identityNameKey,
  meetupDisplayNameFor,
  meetupProfileUrl,
  sanitizeDisplayText,
  visibleSkeleton,
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

describe('sanitizeDisplayText', () => {
  it('strips filler and formatting characters that render as nothing', () => {
    // Hangul fillers, soft hyphen, combining grapheme joiner, Mongolian vowel
    // separator, Arabic letter mark: each a known way to fake a blank name.
    expect(
      sanitizeDisplayText('a\u3164\u115F\u1160\uFFA0\u00AD\u034F\u180E\u061Cb'),
    ).toBe('ab');
  });

  it('is empty for a name made only of invisible characters', () => {
    expect(sanitizeDisplayText('\u200B')).toBe('');
    expect(sanitizeDisplayText(' \u3164\u200D\u200C\u2060 ')).toBe('');
  });

  it('keeps the joiners inside a family emoji', () => {
    const family = '\u{1F468}\u200D\u{1F469}\u200D\u{1F467}';

    expect(sanitizeDisplayText(family)).toBe(family);
  });

  it('keeps a joiner after a variation selector or skin tone', () => {
    const flag = '\u{1F3F3}\uFE0F\u200D\u{1F308}';
    const couple = '\u{1F469}\u{1F3FD}\u200D\u{1F91D}\u200D\u{1F468}\u{1F3FB}';

    expect(sanitizeDisplayText(flag)).toBe(flag);
    expect(sanitizeDisplayText(couple)).toBe(couple);
  });

  it('keeps the zero-width non-joiner inside a Persian word', () => {
    const word = '\u0645\u06CC\u200C\u062E\u0648\u0627\u0647\u0645';

    expect(sanitizeDisplayText(word)).toBe(word);
  });

  it('drops a joiner that joins nothing', () => {
    expect(sanitizeDisplayText('\u200Dab\u200D')).toBe('ab');
    expect(sanitizeDisplayText('a \u200D b')).toBe('a b');
    expect(sanitizeDisplayText('a\u200D\u200Db')).toBe('ab');
  });
});

describe('visibleSkeleton', () => {
  it('ignores every invisible character, joiners between letters included', () => {
    // A joiner between Latin letters is kept for display but draws nothing,
    // so it must not count as a visible difference.
    expect(visibleSkeleton('Bo\u200Db')).toBe('Bob');
    expect(visibleSkeleton('Bo\u200Bb')).toBe('Bob');
    expect(visibleSkeleton('\u202EBob')).toBe('Bob');
    expect(visibleSkeleton(' Bob  ')).toBe('Bob');
  });

  it('keeps visible differences', () => {
    expect(visibleSkeleton('Bob')).not.toBe(visibleSkeleton('B0b'));
  });
});

describe('names made only of invisible characters', () => {
  const subject = {
    platform: 'meetup' as const,
    scopeId: 's1',
    subjectId: 'm1',
  };
  const stored = (name: string) =>
    new Map([[identityNameKey('meetup', 's1', 'm1'), name]]);

  it('are treated as missing by displayNameFor', () => {
    expect(displayNameFor(subject, stored('\u200B'))).toBeUndefined();
    expect(displayNameFor(subject, stored('\u3164\u3164'))).toBeUndefined();
  });

  it('are skipped by discordDisplayName in favour of the next name', () => {
    expect(
      discordDisplayName({
        nickname: '\u200B\u2060',
        globalName: '\u3164',
        username: 'user',
      }),
    ).toBe('user');
  });

  it('are skipped by the name-change fallback', () => {
    expect(
      meetupDisplayNameFor(
        { ...subject, field: 'name', oldValue: 'Jane D.', newValue: '\u200B' },
        new Map(),
      ),
    ).toBe('Jane D.');
    expect(
      meetupDisplayNameFor(
        { ...subject, field: 'name', oldValue: '\u00AD', newValue: '\u200B' },
        new Map(),
      ),
    ).toBeUndefined();
  });
});

describe('escapeDiscordLinkText', () => {
  it('swaps balanced square brackets for parentheses', () => {
    // A backslash-escaped bracket inside masked-link text stops Discord
    // matching the link at all, so brackets are replaced rather than escaped.
    expect(escapeDiscordLinkText('Jane [she/her]')).toBe('Jane \\(she/her\\)');
  });

  it('swaps an unbalanced square bracket', () => {
    expect(escapeDiscordLinkText('a[b')).toBe('a\\(b');
    expect(escapeDiscordLinkText('a]b')).toBe('a\\)b');
  });

  it('leaves no square bracket for an injected link to close on', () => {
    const out = escapeDiscordLinkText('Jane](https://evil.example) [x');

    expect(out).toBe('Jane\\)\\(https\\://evil.example\\) \\(x');
    expect(out).not.toMatch(/[[\]]/);
  });

  it('still escapes everything else', () => {
    expect(escapeDiscordLinkText('*a* <@&1> @everyone')).toBe(
      '\\*a\\* \\<\\@&1\\> \\@everyone',
    );
  });
});
