import { describe, expect, it, vi } from 'vitest';

import { EventSummary } from '../../../src/lib/client/meetup/types.js';
import {
  WhereHaveWeMetDeps,
  findSharedEvents,
  formatWhereHaveWeMet,
  parseMeetupMemberId,
  sharedEvents,
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

describe('sharedEvents', () => {
  it('keeps events both people went to, oldest first', () => {
    expect(
      sharedEvents([picnic, hike, trivia], [trivia, picnic]).map((e) => e.id),
    ).toEqual(['2', '3']);
  });

  it('counts an event once even if it is listed twice', () => {
    expect(sharedEvents([hike, hike], [hike])).toHaveLength(1);
  });
});

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

describe('findSharedEvents', () => {
  function deps(
    records: MemberRecord[],
    rsvps: Record<string, EventSummary[] | undefined>,
  ): WhereHaveWeMetDeps {
    return {
      findByDiscordId: async (id) =>
        records.find((r) => r.discordUserId === id),
      pastRsvps: vi.fn(async (meetupId: string) => rsvps[meetupId]),
    };
  }

  it('finds the events two linked members both went to', async () => {
    const d = deps([record('me', 'm1'), record('them', 'm2')], {
      m1: [hike, trivia],
      m2: [trivia, picnic],
    });

    const result = await findSharedEvents(d, 'me', { discordUserId: 'them' });

    expect(result).toEqual({ kind: 'found', shared: [trivia] });
  });

  it('accepts a Meetup member ID for someone not on Discord', async () => {
    const d = deps([record('me', 'm1')], { m1: [hike], m9: [hike] });

    const result = await findSharedEvents(d, 'me', { meetupId: 'm9' });

    expect(result).toEqual({ kind: 'found', shared: [hike] });
  });

  it('asks the requester to link first, without reading anyone’s RSVPs', async () => {
    const pastRsvps = vi.fn();
    const d = {
      ...deps([record('me', null), record('them', 'm2')], {}),
      pastRsvps,
    };

    expect(await findSharedEvents(d, 'me', { discordUserId: 'them' })).toEqual({
      kind: 'requester-unlinked',
    });
    expect(pastRsvps).not.toHaveBeenCalled();
  });

  it('says when the other person has not linked yet', async () => {
    const d = deps([record('me', 'm1')], { m1: [hike] });

    expect(await findSharedEvents(d, 'me', { discordUserId: 'them' })).toEqual({
      kind: 'target-unlinked',
    });
  });

  it('says when the other person is no longer in the group', async () => {
    const d = deps([record('me', 'm1'), record('them', 'm2')], {
      m1: [hike],
      m2: undefined,
    });

    expect(await findSharedEvents(d, 'me', { discordUserId: 'them' })).toEqual({
      kind: 'target-not-in-group',
    });
  });

  it('notices when someone looks themselves up', async () => {
    const d = deps([record('me', 'm1')], {});

    expect(await findSharedEvents(d, 'me', { discordUserId: 'me' })).toEqual({
      kind: 'self',
    });
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
