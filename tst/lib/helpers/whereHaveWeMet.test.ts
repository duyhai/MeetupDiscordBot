import { describe, expect, it, vi } from 'vitest';

import { EventSummary } from '../../../src/lib/client/meetup/types.js';
import {
  WhereHaveWeMetDeps,
  configuredLookup,
  findSharedEvents,
  formatWhereHaveWeMet,
  parseMeetupMemberId,
  resolveTargetMeetupId,
} from '../../../src/lib/helpers/whereHaveWeMet.js';
import { MemberRecord } from '../../../src/lib/repositories/types.js';

function event(
  id: string,
  dateTime: string,
  title = `Event ${id}`,
): EventSummary {
  return { id, title, dateTime, eventUrl: `https://www.meetup.com/e/${id}/` };
}

function record(discordUserId: string, meetupId: string | null): MemberRecord {
  return {
    discordUserId,
    meetupId,
    meetupName: meetupId ? 'Name' : null,
    meetupMemberUrl: null,
    onboardMethod: meetupId ? 'self_onboard' : 'manual',
    onboardedBy: null,
    firstOnboardedAt: new Date(),
    lastSyncedAt: new Date(),
  };
}

const hike = event('1', '2024-03-02T10:00:00-08:00', 'Hike');
const trivia = event('2', '2025-06-10T19:00:00-07:00', 'Trivia');
const picnic = event('3', '2026-08-15T12:00:00-07:00', 'Picnic');

describe('parseMeetupMemberId', () => {
  it('reads the ID from a Meetup profile link or a bare number', () => {
    expect(
      parseMeetupMemberId('https://www.meetup.com/members/238429835/'),
    ).toBe('238429835');
    expect(
      parseMeetupMemberId(
        'https://www.meetup.com/members/238429835/group/7595882/',
      ),
    ).toBe('238429835');
    expect(parseMeetupMemberId(' 238429835 ')).toBe('238429835');
    expect(parseMeetupMemberId('meetup.com/members/238429835')).toBe(
      '238429835',
    );
  });

  it('reads the ID from a link copied from the group’s member list or a localized page', () => {
    expect(
      parseMeetupMemberId(
        'https://www.meetup.com/1-5genasians/members/238429835/',
      ),
    ).toBe('238429835');
    expect(
      parseMeetupMemberId(
        'https://www.meetup.com/1-5genasians/members/238429835/profile/?x=1',
      ),
    ).toBe('238429835');
    expect(
      parseMeetupMemberId('https://www.meetup.com/en-US/members/99/'),
    ).toBe('99');
  });

  it('rejects anything else', () => {
    expect(
      parseMeetupMemberId('https://www.meetup.com/1-5genasians/'),
    ).toBeUndefined();
    expect(parseMeetupMemberId('jane')).toBeUndefined();
    expect(
      parseMeetupMemberId('https://www.meetup.com/1-5genasians/members/'),
    ).toBeUndefined();
    expect(
      parseMeetupMemberId('https://www.meetup.com/members/12abc/'),
    ).toBeUndefined();
  });

  it('rejects links that are not on meetup.com', () => {
    expect(
      parseMeetupMemberId('https://notmeetup.com/members/5/'),
    ).toBeUndefined();
    expect(
      parseMeetupMemberId('https://evil.example/?x=meetup.com/members/1'),
    ).toBeUndefined();
    expect(
      parseMeetupMemberId('https://meetup.com.evil.example/members/1/'),
    ).toBeUndefined();
  });
});

describe('resolveTargetMeetupId', () => {
  const deps = {
    findByDiscordId: async (id: string) =>
      [record('linked', 'm2'), record('manual', null)].find(
        (r) => r.discordUserId === id,
      ),
  };

  it('reads a linked Discord member’s Meetup ID', async () => {
    expect(await resolveTargetMeetupId(deps, { discordUserId: 'linked' })).toBe(
      'm2',
    );
  });

  it('accepts a Meetup member ID for someone not on Discord', async () => {
    expect(await resolveTargetMeetupId(deps, { meetupId: 'm9' })).toBe('m9');
  });

  it('finds nothing for someone who has not linked', async () => {
    expect(
      await resolveTargetMeetupId(deps, { discordUserId: 'manual' }),
    ).toBeUndefined();
    expect(
      await resolveTargetMeetupId(deps, { discordUserId: 'stranger' }),
    ).toBeUndefined();
  });
});

describe('findSharedEvents', () => {
  /** `attendees` maps an event ID to the Meetup IDs on its attendee list. */
  function deps(myEvents: EventSummary[], attendees: Record<string, string[]>) {
    const attendeeIds = vi.fn(
      async (eventId: string) => attendees[eventId] ?? [],
    );
    const d: WhereHaveWeMetDeps = {
      findByDiscordId: async () => undefined,
      myPastEvents: async () => ({ meetupId: 'm1', events: myEvents }),
      attendeeIds,
      theirPastEvents: async () => {
        throw new Error('the attendee-lists lookup must not read their RSVPs');
      },
    };
    return { d, attendeeIds };
  }

  it('finds the requester’s events the other person also went to, oldest first', async () => {
    const { d } = deps([picnic, hike, trivia], {
      '1': ['m1'],
      '2': ['m1', 'm2'],
      '3': ['m2', 'm1'],
    });

    expect(await findSharedEvents(d, 'm2')).toEqual({
      kind: 'found',
      shared: [trivia, picnic],
    });
  });

  it('only ever looks at events the requester went to', async () => {
    // The other person also went to event 9, but the requester didn't, so
    // its attendee list is never read and it can't show up.
    const { d, attendeeIds } = deps([hike], { '1': ['m1', 'm2'], '9': ['m2'] });

    const result = await findSharedEvents(d, 'm2');

    expect(result).toEqual({ kind: 'found', shared: [hike] });
    expect(attendeeIds).toHaveBeenCalledTimes(1);
    expect(attendeeIds).toHaveBeenCalledWith('1');
  });

  it('counts an event once even if it is listed twice', async () => {
    const { d } = deps([hike, hike], { '1': ['m1', 'm2'] });

    expect(await findSharedEvents(d, 'm2')).toEqual({
      kind: 'found',
      shared: [hike],
    });
  });

  it('skips events renamed "cancelled", without reading their attendee lists', async () => {
    const renamed = event('4', '2023-01-07T10:00:00-08:00', 'CANCELLED: Hike');
    const { d, attendeeIds } = deps([renamed, trivia], {
      '2': ['m1', 'm2'],
      '4': ['m1', 'm2'],
    });

    expect(await findSharedEvents(d, 'm2')).toEqual({
      kind: 'found',
      shared: [trivia],
    });
    expect(attendeeIds).not.toHaveBeenCalledWith('4');
  });

  it('finds nothing when they never went to the same event', async () => {
    const { d } = deps([hike], { '1': ['m1'] });

    expect(await findSharedEvents(d, 'm2')).toEqual({
      kind: 'found',
      shared: [],
    });
  });

  it('notices when someone looks themselves up, without reading attendee lists', async () => {
    const { d, attendeeIds } = deps([hike], { '1': ['m1'] });

    expect(await findSharedEvents(d, 'm1')).toEqual({ kind: 'self' });
    expect(attendeeIds).not.toHaveBeenCalled();
  });
});

describe('findSharedEvents with the member-rsvps lookup', () => {
  function deps(
    myEvents: EventSummary[],
    theirEvents: EventSummary[] | undefined,
  ): WhereHaveWeMetDeps {
    return {
      findByDiscordId: async () => undefined,
      myPastEvents: async () => ({ meetupId: 'm1', events: myEvents }),
      attendeeIds: async () => {
        throw new Error('the member-rsvps lookup must not read attendee lists');
      },
      theirPastEvents: async () => theirEvents,
    };
  }

  it('shows the overlap, and only events the requester went to', async () => {
    const d = deps([picnic, hike], [hike, trivia, picnic]);

    expect(await findSharedEvents(d, 'm2', 'member-rsvps')).toEqual({
      kind: 'found',
      shared: [hike, picnic],
    });
  });

  it('skips events renamed "cancelled"', async () => {
    const renamed = event('4', '2023-01-07T10:00:00-08:00', 'Hike (canceled)');
    const d = deps([renamed, hike], [renamed, hike]);

    expect(await findSharedEvents(d, 'm2', 'member-rsvps')).toEqual({
      kind: 'found',
      shared: [hike],
    });
  });

  it('says when the other person is no longer in the group', async () => {
    const d = deps([hike], undefined);

    expect(await findSharedEvents(d, 'm2', 'member-rsvps')).toEqual({
      kind: 'target-not-in-group',
    });
  });
});

describe('configuredLookup', () => {
  it('uses attendee lists unless member-rsvps is switched on', () => {
    expect(configuredLookup(undefined)).toBe('attendee-lists');
    expect(configuredLookup('typo')).toBe('attendee-lists');
    expect(configuredLookup('member-rsvps')).toBe('member-rsvps');
  });
});

describe('formatWhereHaveWeMet', () => {
  const caveat =
    'Counted from Meetup RSVPs, so an event one of you signed up for but missed still counts.';

  // Hai's call (2026-10-05): the friendly "first met" lead reads better;
  // the RSVP caveat at the end carries the honesty.
  it('leads with the first shared event and keeps the RSVP caveat', () => {
    const text = formatWhereHaveWeMet('Jane', [hike, trivia, picnic]);
    expect(text).toContain(
      'You and Jane first met at [Hike](<https://www.meetup.com/e/1/>) on Mar 2, 2024.',
    );
    expect(text).toContain('3 shared events in all.');
    expect(text).toContain(caveat);
  });

  // Bare URLs make Discord render a preview card per link; wrapping every
  // URL in <> suppresses them, or ten shared events become ten cards.
  it('angle-brackets every link so Discord shows no previews', () => {
    const text = formatWhereHaveWeMet('Jane', [hike, trivia, picnic]);
    expect(text).not.toMatch(/\]\((?!<)/);
  });

  it('shows all shared events oldest first when there are ten or fewer', () => {
    const ten = Array.from({ length: 10 }, (_, i) =>
      event(`${i}`, `2026-${String(i + 1).padStart(2, '0')}-05T18:00:00-07:00`),
    );
    const listed = formatWhereHaveWeMet('Jane', ten)
      .split('\n')
      .filter((line) => line.startsWith('- '));
    expect(listed).toHaveLength(10);
    expect(listed[0]).toContain('Jan 5, 2026');
    expect(listed[9]).toContain('Oct 5, 2026');
  });

  it('shows the earliest five and most recent five when there are more', () => {
    const many = Array.from({ length: 12 }, (_, i) =>
      event(`${i}`, `2026-${String(i + 1).padStart(2, '0')}-05T18:00:00-07:00`),
    );
    const text = formatWhereHaveWeMet('Jane', many);
    const listed = text.split('\n').filter((line) => line.startsWith('- '));
    expect(text.indexOf('Earliest together:')).toBeLessThan(
      text.indexOf('Most recent:'),
    );
    expect(listed).toHaveLength(10);
    // Earliest first ...
    expect(listed[0]).toContain('Jan 5, 2026');
    expect(listed[4]).toContain('May 5, 2026');
    // ... then most recent, newest first.
    expect(listed[5]).toContain('Dec 5, 2026');
    expect(listed[9]).toContain('Aug 5, 2026');
  });

  it('handles a single shared event without a list', () => {
    const text = formatWhereHaveWeMet('Jane', [trivia]);
    expect(text).toContain("the only event you've been to together so far");
    expect(
      text.split('\n').filter((line) => line.startsWith('- ')),
    ).toHaveLength(0);
  });

  it('uses Seattle dates, not UTC', () => {
    // 7pm Jun 10 in Seattle is already Jun 11 in UTC.
    expect(formatWhereHaveWeMet('Jane', [trivia])).toContain('Jun 10, 2025');
  });

  it('is encouraging when there are no shared events yet', () => {
    expect(formatWhereHaveWeMet('Jane', [])).toBe(
      "You and Jane haven't been to the same event yet. Maybe the next one!",
    );
  });
});
