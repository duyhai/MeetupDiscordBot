import { ClientError } from 'graphql-request';
import { describe, expect, it, vi } from 'vitest';

import {
  EventSummary,
  GetEventRsvpsResponse,
  GetGroupEventsResponse,
  GroupEventFilter,
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
  hosted?: EventSummary[];
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
  const getGroupEvents = vi.fn(
    (_input: PaginationInput, _filter?: GroupEventFilter) =>
      Promise.resolve<GetGroupEventsResponse>({
        groupByUrlname: {
          id: GROUP,
          events: page(
            hosted.map((event) => ({
              ...event,
              eventHosts: [],
              maxTickets: 0,
              status: 'PAST' as const,
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
  const deps: BuildDeps = {
    meetup: { getSelfPastRsvpEvents, getGroupEvents, getEventRsvps },
    claimBuild,
    organizerRsvps,
    findByMeetupId: (id) =>
      Promise.resolve(linked.includes(id) ? record(id) : undefined),
    isPresent: () => Promise.resolve(true),
    onProgress,
    now: () => new Date('2026-12-10T20:00:00Z'),
  };
  return {
    deps,
    getSelfPastRsvpEvents,
    getGroupEvents,
    getEventRsvps,
    organizerRsvps,
    onProgress,
    claimBuild,
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
      hosted: [hotPot],
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
      hosting: { thisYear: 1, allTime: 1 },
    });
    expect(result.wrapped.companions).toEqual({
      named: [{ discordUserId: 'd7', sharedCount: 2 }],
      otherCount: 1,
    });
    expect(result.wrapped.builtAt).toBe('2026-12-10T20:00:00.000Z');
    expect(result.wrapped.meetupId).toBe('me');

    expect(f.getSelfPastRsvpEvents).toHaveBeenCalledWith(GROUP);
    expect(f.getGroupEvents.mock.calls[0][1]).toEqual({
      status: ['PAST'],
      hostId: 'me',
    });
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
    expect(f.getGroupEvents).not.toHaveBeenCalled();
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
    expect(refused.getGroupEvents).not.toHaveBeenCalled();

    const mismatch = fakeDeps({ selfMeetupId: 'other' });
    await buildWrapped(mismatch.deps, 'me', 2026, GROUP);
    expect(mismatch.claimBuild).not.toHaveBeenCalled();
  });

  it('reports progress along the way', async () => {
    const f = fakeDeps();

    await buildWrapped(f.deps, 'me', 2026, GROUP);

    expect(f.onProgress.mock.calls.length).toBeGreaterThanOrEqual(2);
    f.onProgress.mock.calls.forEach((call) => {
      expect(typeof call[0]).toBe('string');
    });
  });
});
