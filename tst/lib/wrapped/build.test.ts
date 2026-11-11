import { ClientError } from 'graphql-request';
import { describe, expect, it, vi } from 'vitest';

import {
  EventSummary,
  GetEventRsvpsResponse,
  GetHostedEventsResponse,
  PaginationInput,
  RsvpFilter,
} from '../../../src/lib/client/meetup/types.js';
import { MemberRecord } from '../../../src/lib/repositories/types.js';
import {
  ATTENDEE_FETCH_CONCURRENCY,
  BuildDeps,
  buildWrapped,
} from '../../../src/lib/wrapped/build.js';

const GROUP = '7595882';

function ev(id: string, iso: string, title = `Event ${id}`): EventSummary {
  return {
    id,
    title,
    dateTime: iso,
    eventUrl: `https://www.meetup.com/e/${id}/`,
  };
}

const hike = ev('1', '2024-03-02T10:00:00-08:00', 'Hike');
const trivia = ev('2', '2026-05-10T19:00:00-07:00', 'Trivia');
const hotPot = ev('3', '2026-11-20T19:00:00-08:00', 'Hot Pot');

type HostedFixture = EventSummary & { attendance?: number };

const page = <T>(nodes: T[]) => ({
  pageInfo: {
    hasNextPage: false,
    hasPreviousPage: false,
    startCursor: null as string | null,
    endCursor: null as string | null,
  },
  totalCount: nodes.length,
  edges: nodes.map((node) => ({ node })),
});

function record(meetupId: string): MemberRecord {
  return {
    discordUserId: `d${meetupId}`,
    meetupId,
    meetupName: null,
    meetupMemberUrl: null,
    onboardMethod: 'self_onboard',
    onboardedBy: null,
    firstOnboardedAt: new Date(),
    lastSyncedAt: new Date(),
  };
}

function fakeDeps({
  selfMeetupId = 'me',
  events = [hike, trivia, hotPot],
  hosted = [],
  attendees = {},
  linked = [],
  selfError,
}: {
  selfMeetupId?: string;
  events?: EventSummary[];
  hosted?: HostedFixture[];
  attendees?: Record<string, string[]>;
  linked?: string[];
  selfError?: Error;
} = {}) {
  const getSelfPastRsvpEvents = vi.fn((_groupId: string) => {
    if (selfError) {
      return Promise.reject(selfError);
    }
    return Promise.resolve({ events, meetupId: selfMeetupId });
  });
  const getHostedEvents = vi.fn((_hostId: string, _input: PaginationInput) =>
    Promise.resolve<GetHostedEventsResponse>({
      groupByUrlname: {
        id: GROUP,
        events: page(
          hosted.map(({ attendance, ...event }) => ({
            ...event,
            eventHosts: [],
            maxTickets: 0,
            status: 'PAST' as const,
            attendance:
              attendance === undefined ? null : { totalCount: attendance },
          })),
        ),
      },
    }),
  );
  const getEventRsvps = vi.fn(
    (eventId: string, _input: PaginationInput, _filter?: RsvpFilter) =>
      Promise.resolve<GetEventRsvpsResponse>({
        event: {
          id: eventId,
          rsvps: page(
            (attendees[eventId] ?? []).map((id) => ({
              status: 'YES' as const,
              member: {
                id,
                name: `Member ${id}`,
                memberUrl: '',
                gender: 'NONE' as never,
              },
            })),
          ),
        },
      }),
  );
  const organizerRsvps = vi.fn((_meetupId: string) =>
    Promise.resolve<EventSummary[] | undefined>(events),
  );
  const onProgress = vi.fn((_message: string) => Promise.resolve());
  const claimBuild = vi.fn(() => true);
  const log = vi.fn((_message: string) => undefined);
  const deps: BuildDeps = {
    meetup: { getSelfPastRsvpEvents, getHostedEvents, getEventRsvps },
    claimBuild,
    organizerRsvps,
    findByMeetupId: (id) =>
      Promise.resolve(linked.includes(id) ? record(id) : undefined),
    isPresent: () => Promise.resolve(true),
    onProgress,
    now: () => new Date('2026-12-10T20:00:00Z'),
    log,
  };
  return {
    deps,
    getSelfPastRsvpEvents,
    getHostedEvents,
    getEventRsvps,
    organizerRsvps,
    onProgress,
    claimBuild,
    log,
  };
}

function meetupError(status: number): ClientError {
  return new ClientError(
    { status, headers: new Headers(), body: '', errors: [] },
    { query: 'q' },
  );
}

describe('buildWrapped', () => {
  it("builds from the member's own history and this year's attendee lists", async () => {
    const f = fakeDeps({
      hosted: [{ ...hotPot, attendance: 12 }],
      attendees: { '2': ['me', '7', '8'], '3': ['me', '7'] },
      linked: ['7'],
    });

    const result = await buildWrapped(f.deps, 'me', 2026, GROUP);

    expect(result.kind).toBe('built');
    if (result.kind !== 'built') {
      return;
    }
    expect(result.wrapped.stats).toMatchObject({
      year: 2026,
      firstEvent: hike,
      attendedThisYear: 2,
      attendedAllTime: 3,
      hosting: {
        thisYear: 1,
        allTime: 1,
        topThisYear: [{ event: hotPot, attendance: 12 }],
        allTimeBest: { event: hotPot, attendance: 12 },
      },
    });
    expect(result.wrapped.companions).toEqual({
      named: [
        { discordUserId: 'd7', sharedCount: 2, sharedEvents: [trivia, hotPot] },
      ],
      otherCount: 1,
    });
    expect(result.wrapped.builtAt).toBe('2026-12-10T20:00:00.000Z');
    expect(result.wrapped.meetupId).toBe('me');

    expect(f.getSelfPastRsvpEvents).toHaveBeenCalledWith(GROUP);
    expect(f.getHostedEvents.mock.calls[0][0]).toBe('me');
    // Only this year's events are scanned, with the shared attendee filter.
    expect(f.getEventRsvps.mock.calls.map((call) => call[0]).sort()).toEqual([
      '2',
      '3',
    ]);
    f.getEventRsvps.mock.calls.forEach((call) => {
      expect(call[2]).toEqual({ rsvpStatus: ['ATTENDED', 'YES'] });
    });
    expect(f.organizerRsvps).not.toHaveBeenCalled();
    expect(ATTENDEE_FETCH_CONCURRENCY).toBe(5);
  });

  it("reports an account mismatch when the token's Meetup id differs from the linked one", async () => {
    const f = fakeDeps({ selfMeetupId: 'other' });

    const result = await buildWrapped(f.deps, 'me', 2026, GROUP);

    expect(result).toEqual({
      kind: 'account-mismatch',
      tokenMeetupId: 'other',
    });
    expect(f.getHostedEvents).not.toHaveBeenCalled();
    expect(f.getEventRsvps).not.toHaveBeenCalled();
  });

  it('falls back to the organizer read only when the member token is refused', async () => {
    const f = fakeDeps({ selfError: meetupError(401) });

    const result = await buildWrapped(f.deps, 'me', 2026, GROUP);

    expect(result.kind).toBe('built');
    expect(f.organizerRsvps).toHaveBeenCalledWith('me');
  });

  it('lets any other member-read failure propagate instead of falling back', async () => {
    const f = fakeDeps({ selfError: meetupError(500) });

    await expect(buildWrapped(f.deps, 'me', 2026, GROUP)).rejects.toThrow();
    expect(f.organizerRsvps).not.toHaveBeenCalled();
    expect(f.claimBuild).not.toHaveBeenCalled();
  });

  it('is not-in-group when the fallback cannot see the member', async () => {
    const f = fakeDeps({ selfError: meetupError(401) });
    f.organizerRsvps.mockResolvedValue(undefined);

    const result = await buildWrapped(f.deps, 'me', 2026, GROUP);

    expect(result).toEqual({ kind: 'not-in-group' });
  });

  it('propagates an attendee fetch failure', async () => {
    const f = fakeDeps();
    f.getEventRsvps.mockRejectedValueOnce(new Error('rsvps down'));

    await expect(buildWrapped(f.deps, 'me', 2026, GROUP)).rejects.toThrow(
      'rsvps down',
    );
  });

  it('claims the build only once the history is readable, and stops when refused', async () => {
    const refused = fakeDeps();
    refused.claimBuild.mockReturnValue(false);

    expect(await buildWrapped(refused.deps, 'me', 2026, GROUP)).toEqual({
      kind: 'rate-limited',
    });
    expect(refused.getHostedEvents).not.toHaveBeenCalled();

    const mismatch = fakeDeps({ selfMeetupId: 'other' });
    await buildWrapped(mismatch.deps, 'me', 2026, GROUP);
    expect(mismatch.claimBuild).not.toHaveBeenCalled();
  });

  it('reports progress along the way', async () => {
    const f = fakeDeps();

    await buildWrapped(f.deps, 'me', 2026, GROUP);

    expect(f.onProgress.mock.calls.map((call) => call[0])).toEqual([
      'Reading your RSVPs…',
      'Finding who you went with…',
      'Looking back at your early events…',
    ]);
  });

  /** Eleven games nights 2023–2026 (two in 2026), one hot pot in 2026. */
  const gamesNights = Array.from({ length: 11 }, (_, i) =>
    ev(
      `g${i}`,
      `${2023 + Math.floor(i / 3)}-0${1 + (i % 3)}-05T19:00:00-08:00`,
      'Trivia',
    ),
  );

  it("fetches early events' attendee lists once each, skipping ones already fetched this year", async () => {
    const f = fakeDeps({ events: [...gamesNights, hotPot] });

    await buildWrapped(f.deps, 'me', 2026, GROUP);

    const fetched = f.getEventRsvps.mock.calls.map((call) => call[0]);
    expect(fetched.length).toBe(new Set(fetched).size);
    // This year's three events, plus the first ten games nights (g0..g9),
    // two of which (g9, g10 are 2026) were fetched already.
    expect([...fetched].sort()).toEqual(
      ['3', ...gamesNights.map((e) => e.id)].sort(),
    );
    expect(f.getEventRsvps).toHaveBeenCalledTimes(12);
  });

  it("fills each top type's cohort with linked, present people who also shared an event this year", async () => {
    const attendees: Record<string, string[]> = {
      g0: ['me', 'old', 'ghost', 'stranger'],
      g1: ['me', 'old'],
      g9: ['me', 'old', 'ghost'],
      g10: ['me', 'ghost', 'new'],
      '3': ['me', 'new'],
    };
    const f = fakeDeps({
      events: [...gamesNights, hotPot],
      attendees,
      linked: ['old', 'new'],
    });

    const result = await buildWrapped(f.deps, 'me', 2026, GROUP);

    if (result.kind !== 'built') {
      throw new Error(result.kind);
    }
    const games = result.wrapped.stats.topTypes.find((t) => t.type === 'games');
    // old: at three early events, shared g9 this year; ghost: linked? no → counted; stranger: nothing this year → absent.
    expect(games?.cohort).toEqual({
      named: [{ discordUserId: 'dold', earlyCount: 3, sharedCount: 1 }],
      otherCount: 1,
    });
    const food = result.wrapped.stats.topTypes.find((t) => t.type === 'food');
    // hot pot is the only food event ever and nobody from it is "early" but new shared it this year.
    expect(food?.cohort).toEqual({
      named: [{ discordUserId: 'dnew', earlyCount: 1, sharedCount: 2 }],
      otherCount: 0,
    });
    // Neither the Meetup ids nor the names the attendee lists carried.
    const json = JSON.stringify(result.wrapped);
    expect(json).not.toContain('ghost');
    expect(json).not.toContain('stranger');
    expect(json).not.toContain('"old"');
    expect(json).not.toContain('Member ghost');
    expect(json).not.toContain('Member old');
    expect(json).not.toContain('Member new');
  });

  it('attaches the shared events to the top companion only', async () => {
    const f = fakeDeps({
      attendees: { '2': ['me', '7', '8'], '3': ['me', '7', '8'] },
      linked: ['7', '8'],
    });

    const result = await buildWrapped(f.deps, 'me', 2026, GROUP);

    if (result.kind !== 'built') {
      throw new Error(result.kind);
    }
    expect(result.wrapped.companions.named[0].sharedEvents).toEqual([
      trivia,
      hotPot,
    ]);
    expect(result.wrapped.companions.named[1].sharedEvents).toBeUndefined();
  });

  it('a zero-event year makes no cohort fetch', async () => {
    const f = fakeDeps({ events: [hike] });

    const result = await buildWrapped(f.deps, 'me', 2026, GROUP);

    expect(result.kind).toBe('built');
    expect(f.getEventRsvps).not.toHaveBeenCalled();
  });

  it('logs the build duration', async () => {
    const f = fakeDeps();

    await buildWrapped(f.deps, 'me', 2026, GROUP);

    expect(f.log).toHaveBeenCalledWith(
      expect.stringMatching(
        /^Wrapped build for Meetup member me \(2026\) took \d+ ms$/,
      ),
    );
  });
});
