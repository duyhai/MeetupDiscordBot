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
  });

  it('rejects anything else', () => {
    expect(
      parseMeetupMemberId('https://www.meetup.com/1-5genasians/'),
    ).toBeUndefined();
    expect(parseMeetupMemberId('jane')).toBeUndefined();
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
  it('leads with the first shared event and the total', () => {
    const text = formatWhereHaveWeMet('Jane', [hike, trivia, picnic]);
    expect(text).toContain(
      'You and Jane first met at [Hike](https://www.meetup.com/e/1/) on Mar 2, 2024.',
    );
    expect(text).toContain("You've been to 3 events together.");
  });

  it('lists the five most recent shared events, newest first', () => {
    const many = Array.from({ length: 8 }, (_, i) =>
      event(`${i}`, `2026-0${i + 1}-05T18:00:00-07:00`),
    );
    const text = formatWhereHaveWeMet('Jane', many);
    const listed = text.split('\n').filter((line) => line.startsWith('- '));
    expect(listed).toHaveLength(5);
    expect(listed[0]).toContain('Aug 5, 2026');
    expect(listed[4]).toContain('Apr 5, 2026');
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
