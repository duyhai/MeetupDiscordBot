import { describe, expect, it, vi } from 'vitest';

import {
  EventSummary,
  GetEventRsvpsResponse,
  GetHostedEventsResponse,
} from '../../../src/lib/client/meetup/types.js';
import { MemberRecord } from '../../../src/lib/repositories/types.js';
import {
  SNAPSHOT_COUNT_SLACK,
  buildWrappedFromSnapshot,
  snapshotWrapped,
} from '../../../src/lib/snapshot/wrapped.js';
import { buildWrapped } from '../../../src/lib/wrapped/build.js';
import { FakeSnapshotReader } from './fakes.js';

const NOW = new Date('2026-12-05T20:00:00Z');

const ev = (
  id: string,
  iso: string,
  title: string,
  hosts?: string[],
): EventSummary & { hosts?: string[] } => ({
  id,
  title,
  dateTime: iso,
  eventUrl: `https://www.meetup.com/g/events/${id}/`,
  hosts,
});

const EVENTS = [
  ev('1', '2023-03-02T18:00:00Z', 'Hike'),
  ev('2', '2026-02-10T03:00:00Z', 'Board game night'),
  ev('3', '2026-05-10T02:00:00Z', 'Trivia', ['me']),
  ev('4', '2026-05-20T02:00:00Z', 'Hot pot dinner'),
  ev('5', '2026-08-01T02:00:00Z', 'Board games again'),
];
const ATTENDEES: Record<string, string[]> = {
  '1': ['me', 'a', 'b'],
  '2': ['me', 'a', 'c'],
  '3': ['me', 'a', 'b', 'x'],
  '4': ['me', 'c'],
  '5': ['a', 'b'], // not the member's
};

const linked: Record<string, string> = { a: 'da', b: 'db' };
const record = (meetupId: string): MemberRecord => ({
  discordUserId: linked[meetupId],
  meetupId,
  meetupName: null,
  meetupMemberUrl: null,
  onboardMethod: 'self_onboard',
  onboardedBy: null,
  firstOnboardedAt: NOW,
  lastSyncedAt: NOW,
});
const naming = {
  findByMeetupId: async (id: string) => {
    return linked[id] ? record(id) : undefined;
  },
  isPresent: async () => true,
  now: () => NOW,
  log: () => undefined,
};

describe('snapshotWrapped.sources', () => {
  it('serves a member present in a ready snapshot', async () => {
    const sources = await snapshotWrapped(
      new FakeSnapshotReader(EVENTS, ATTENDEES),
    ).sources('me');
    expect(sources?.events.map((e) => e.id)).toEqual(['1', '2', '3', '4']);
    expect(sources?.hosted).toEqual([
      expect.objectContaining({ id: '3', attendance: 4 }),
    ]);
  });

  it('is undefined before a full pull, for a member with nothing stored, and when unreadable', async () => {
    const reader = new FakeSnapshotReader(EVENTS, ATTENDEES);
    const snap = snapshotWrapped(reader);
    expect(await snap.sources('newcomer')).toBeUndefined();
    reader.ready = false;
    expect(await snap.sources('me')).toBeUndefined();
    reader.ready = true;
    reader.failing = new TypeError('pg down');
    expect(await snap.sources('me')).toBeUndefined();
    expect(await snap.updatedAt()).toBeUndefined();
  });

  it('cross-checks against the member’s own count, with a little slack', async () => {
    const fresh = () =>
      snapshotWrapped(new FakeSnapshotReader(EVENTS, ATTENDEES));
    expect(
      await fresh().sources('me', async () => 4 + SNAPSHOT_COUNT_SLACK),
    ).toBeDefined();
    expect(await fresh().sources('me', async () => undefined)).toBeDefined();
    expect(
      await fresh().sources('me', async () => {
        throw new Error('token refused');
      }),
    ).toBeDefined();
  });

  it('flags a member it undercounts, durably: the token path from then on, cross-check or not', async () => {
    const reader = new FakeSnapshotReader(EVENTS, ATTENDEES);
    const snap = snapshotWrapped(reader);
    expect(
      await snap.sources('me', async () => 4 + SNAPSHOT_COUNT_SLACK + 1),
    ).toBeUndefined();
    expect(reader.flagged.get('me')).toEqual({
      snapshot: 4,
      self: 4 + SNAPSHOT_COUNT_SLACK + 1,
    });
    // The backfill passes no cross-check: still the token path.
    expect(await snap.sources('me')).toBeUndefined();
  });

  it('clears the flag when a later cross-check agrees', async () => {
    const reader = new FakeSnapshotReader(EVENTS, ATTENDEES);
    await reader.flagUndercounted('me', 1, 9);
    const snap = snapshotWrapped(reader);
    // Still disagreeing, or no count: stays on the token path.
    expect(await snap.sources('me', async () => 9)).toBeUndefined();
    expect(await snap.sources('me', async () => undefined)).toBeUndefined();
    expect(reader.flagged.has('me')).toBe(true);
    // The snapshot has caught up.
    expect(await snap.sources('me', async () => 4)).toBeDefined();
    expect(reader.flagged.has('me')).toBe(false);
  });

  it('strict mode rethrows a reader error instead of answering the token path', async () => {
    const reader = new FakeSnapshotReader(EVENTS, ATTENDEES);
    reader.failing = new TypeError('pg down');
    await expect(
      snapshotWrapped(reader).sources('me', undefined, { strict: true }),
    ).rejects.toThrow(TypeError);
  });
});

describe('buildWrappedFromSnapshot', () => {
  it('takes the slot first: refused is rate-limited, with no read', async () => {
    const reader = new FakeSnapshotReader(EVENTS, ATTENDEES);
    const snap = snapshotWrapped(reader);
    const sources = await snap.sources('me');
    const result = await buildWrappedFromSnapshot(
      { ...naming, attendees: snap.attendees, claimBuild: () => false },
      'me',
      2026,
      sources,
    );
    expect(result).toEqual({ kind: 'rate-limited' });
    expect(reader.attendeeReads).toBe(0);
  });

  it('equals the token build on the same data, and names only linked members by Discord id', async () => {
    const snap = snapshotWrapped(new FakeSnapshotReader(EVENTS, ATTENDEES));
    const sources = await snap.sources('me');
    const fromSnapshot = await buildWrappedFromSnapshot(
      { ...naming, attendees: snap.attendees },
      'me',
      2026,
      sources,
    );

    const mine = EVENTS.filter((e) => ATTENDEES[e.id].includes('me')).map(
      ({ hosts: _h, ...e }) => e,
    );
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
    const meetup = {
      getSelfPastRsvpEvents: vi.fn(async () => ({
        events: mine,
        meetupId: 'me',
      })),
      getHostedEvents: vi.fn(async (): Promise<GetHostedEventsResponse> => ({
        groupByUrlname: {
          id: 'g',
          events: page(
            EVENTS.filter((e) => e.hosts?.includes('me')).map(
              ({ hosts: _h, ...e }) => ({
                ...e,
                eventHosts: [],
                maxTickets: 0,
                status: 'PAST' as const,
                attendance: { totalCount: ATTENDEES[e.id].length },
              }),
            ),
          ),
        },
      })),
      getEventRsvps: vi.fn(
        async (eventId: string): Promise<GetEventRsvpsResponse> => ({
          event: {
            id: eventId,
            rsvps: page(
              (ATTENDEES[eventId] ?? []).map((id) => ({
                status: 'YES' as const,
                member: {
                  id,
                  name: `N ${id}`,
                  memberUrl: '',
                  gender: 'NONE' as never,
                },
              })),
            ),
          },
        }),
      ),
    };
    const fromToken = await buildWrapped(
      { ...naming, meetup, organizerRsvps: async () => mine },
      'me',
      2026,
      'g',
    );
    expect(fromSnapshot.kind).toBe('built');
    expect(fromToken.kind).toBe('built');
    if (fromSnapshot.kind !== 'built' || fromToken.kind !== 'built') {
      return;
    }
    const { builtFrom, ...sameShape } = fromSnapshot.wrapped;
    expect(builtFrom).toBe('snapshot');
    expect(fromToken.wrapped.builtFrom).toBeUndefined();
    expect(sameShape).toEqual(fromToken.wrapped);
    expect(fromSnapshot.wrapped.stats.attendedThisYear).toBe(3);
    expect(fromSnapshot.wrapped.stats.hosting?.thisYear).toBe(1);
    const json = JSON.stringify(fromSnapshot.wrapped);
    // Other people only as linked Discord ids; no other Meetup id, no names.
    expect(json).toContain('"da"');
    for (const other of ['"a"', '"b"', '"c"', '"x"', 'N a']) {
      expect(json).not.toContain(other);
    }
  });
});
