import { describe, expect, it } from 'vitest';

import { GET_VERIFIED_CHANNEL_ID } from '../../../src/constants.js';
import { CachedWrapped } from '../../../src/lib/wrapped/cache.js';
import {
  parseShareCustomId,
  replies,
  shareButtonRow,
  shareCustomId,
  sharedPostContent,
  wrappedEmbed,
} from '../../../src/lib/wrapped/format.js';

const full: CachedWrapped = {
  meetupId: 'm1',
  stats: {
    year: 2026,
    firstEvent: {
      id: 'e1',
      title: 'Saturday Hike',
      dateTime: '2024-03-02T10:00:00-08:00',
      eventUrl: 'https://www.meetup.com/e/e1/',
    },
    attendedThisYear: 12,
    attendedAllTime: 40,
    topTypes: [
      { type: 'food', count: 5 },
      { type: 'games', count: 4 },
    ],
    hosting: { thisYear: 1, allTime: 3 },
    busiestMonth: { month: 6, count: 4 },
    longestStreakMonths: 5,
  },
  companions: {
    named: [
      { discordUserId: 'd1', sharedCount: 4 },
      { discordUserId: 'd2', sharedCount: 2 },
    ],
    otherCount: 5,
  },
  builtAt: '2026-12-10T20:00:00.000Z',
};

const quiet: CachedWrapped = {
  meetupId: 'm1',
  stats: {
    ...full.stats,
    attendedThisYear: 0,
    topTypes: [],
    hosting: null,
    busiestMonth: null,
    longestStreakMonths: 0,
  },
  companions: { named: [], otherCount: 0 },
  builtAt: full.builtAt,
};

const fieldNames = (embed: ReturnType<typeof wrappedEmbed>) =>
  (embed.data.fields ?? []).map((field) => field.name);
const field = (embed: ReturnType<typeof wrappedEmbed>, name: string) =>
  (embed.data.fields ?? []).find((f) => f.name === name)?.value;

describe('wrappedEmbed', () => {
  it('titles the embed for the member and carries the RSVP caveat', () => {
    const embed = wrappedEmbed('Jane', full);

    expect(embed.data.title).toBe("🎁 Jane's 1.5 Gen Wrapped 2026");
    expect(embed.data.footer?.text).toBe(
      'Counted from Meetup RSVPs, so an event you signed up for but missed still counts.',
    );
  });

  it('lays the fields out in order, with hosting only for hosts', () => {
    expect(fieldNames(wrappedEmbed('Jane', full))).toEqual([
      'First event with us',
      'This year',
      'Top activities',
      'Hosting',
      'Busiest month',
      'Longest streak',
      'Went with the most',
    ]);
    expect(fieldNames(wrappedEmbed('Jane', quiet))).not.toContain('Hosting');
  });

  it('names companions as mentions and folds the rest into a count', () => {
    expect(field(wrappedEmbed('Jane', full), 'Went with the most')).toBe(
      '<@d1> (4 events), <@d2> (2 events) and 5 other members',
    );
    expect(field(wrappedEmbed('Jane', quiet), 'Went with the most')).toBe(
      'Nobody yet — next year!',
    );
  });

  it('links the first event quietly with its Pacific date', () => {
    const value = field(wrappedEmbed('Jane', full), 'First event with us');

    expect(value).toContain('[Saturday Hike](<https://www.meetup.com/e/e1/>)');
    expect(value).toContain('Mar 2, 2024');
  });

  it('calls a year with no events quiet and points at all-time', () => {
    const value = field(wrappedEmbed('Jane', quiet), 'This year');

    expect(value).toMatch(/quiet year/i);
    expect(value).toContain('40');
  });

  it('spells out the fun stats', () => {
    const embed = wrappedEmbed('Jane', full);

    expect(field(embed, 'This year')).toContain('12');
    expect(field(embed, 'Top activities')).toContain('Food & drink');
    expect(field(embed, 'Hosting')).toContain('3');
    expect(field(embed, 'Busiest month')).toContain('July');
    expect(field(embed, 'Longest streak')).toContain('5 months');
  });
});

describe('wrappedEmbed shared view', () => {
  it('names linked companions as plain display names, never tags', () => {
    const embed = wrappedEmbed('Jane', full, {
      kind: 'shared',
      displayNames: { d1: 'Alex <@999> @here', d2: 'Sam_B' },
    });
    const json = JSON.stringify(embed.toJSON());

    expect(json).not.toContain('<@');
    expect(json).not.toContain('@here');
    expect(field(embed, 'Went with the most')).toContain('Alex');
    expect(field(embed, 'Went with the most')).toContain('Sam\\_B (2 events)');
    expect(field(embed, 'Went with the most')).toContain('5 other members');
  });

  it.each([
    // A masked link needs "](" intact to render.
    ['[free nitro](https://evil.example)', [/\]\(/]],
    // Headings and list items only render at the start of a line.
    ['# Big', [/^# /m]],
    ['- item', [/^- /m]],
    ['1. item', [/^1\. /m]],
    ['@everyone', [/@everyone/]],
    ['<@&1>', [/<@/]],
    ['<#1>', [/<#/]],
  ])('renders the hostile nickname %s as inert text', (nickname, forbidden) => {
    const value = field(
      wrappedEmbed('Jane', full, {
        kind: 'shared',
        displayNames: { d1: nickname, d2: 'Sam' },
      }),
      'Went with the most',
    );

    forbidden.forEach((pattern) => {
      expect(value).not.toMatch(pattern);
    });
    // Still names them, in some neutralised form.
    expect(value).toContain('(4 events)');
  });

  it('folds a companion whose name could not be resolved into the count', () => {
    const embed = wrappedEmbed('Jane', full, {
      kind: 'shared',
      displayNames: { d1: 'Alex' },
    });

    expect(field(embed, 'Went with the most')).toBe(
      'Alex (4 events) and 6 other members',
    );
  });

  it('keeps mentions in the private view', () => {
    expect(field(wrappedEmbed('Jane', full), 'Went with the most')).toContain(
      '<@d1>',
    );
  });
});

describe('share button', () => {
  it('round-trips the year and channel through the custom id', () => {
    const id = shareCustomId(2026, '123');

    expect(parseShareCustomId(id)).toEqual({ year: 2026, channelId: '123' });
    expect(parseShareCustomId('wrapped_share:abc:1')).toBeUndefined();
    expect(parseShareCustomId('something_else')).toBeUndefined();
  });

  it('builds a button row with that id', () => {
    const row = shareButtonRow(2026, '123').toJSON();

    expect(row.components).toHaveLength(1);
    expect(row.components[0]).toMatchObject({
      custom_id: shareCustomId(2026, '123'),
    });
  });

  it('writes the public post lead', () => {
    expect(sharedPostContent('u1', 2026)).toBe(
      '<@u1> shared their 1.5 Gen Wrapped 2026',
    );
  });
});

describe('replies', () => {
  it('nudges unlinked members to the verification channel', () => {
    expect(replies.notLinked).toBe(
      'Wrapped is for linked members. Press **Link Meetup Account** in ' +
        `<#${GET_VERIFIED_CHANNEL_ID}> to link your Meetup account, then run ` +
        '`/wrapped` again.',
    );
  });

  it('says how long until the next build', () => {
    expect(replies.rateLimited(42)).toContain('42 minutes');
  });
});
