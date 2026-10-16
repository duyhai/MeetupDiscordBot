import nock from 'nock';

import Configuration from '../../../src/configuration.js';
import {
  getEventRsvps,
  getGroupEvents,
  getGroupEventsCount,
  getMemberRsvps,
  getUserMembershipInfo,
} from '../../../src/lib/client/meetup/queries.js';
import {
  EventStatus,
  GroupEventFilter,
} from '../../../src/lib/client/meetup/types.js';

export type FixtureRsvpStatus = 'YES' | 'NO' | 'ATTENDED' | 'NO_SHOW';
export interface FixtureMember {
  id: string;
  name: string;
}
export interface FixtureEvent {
  id: string;
  title: string;
  /** Meetup's own format: local wall time with offset, no seconds, e.g. '2026-09-03T19:00-07:00'. */
  dateTime: string;
  status: EventStatus;
  maxTickets: number;
  hostIds: string[];
  description?: string;
  fee?: { amount: number; currency: string };
}
export interface FixtureRsvp {
  eventId: string;
  memberId: string;
  status: FixtureRsvpStatus;
}
export interface MeetupWorld {
  groupId: string;
  members: FixtureMember[];
  /** Left the group: member-RSVP lookups return no membership. */
  departedIds: string[];
  events: FixtureEvent[];
  rsvps: FixtureRsvp[];
}
export type QueryName =
  | 'getGroupEvents'
  | 'getGroupEventsCount'
  | 'getEventRsvps'
  | 'getUserMembershipInfo'
  | 'getMemberRsvps';
export interface RecordedCall {
  name: QueryName | 'unhandled';
  variables: Record<string, unknown>;
  authorization: string | undefined;
}
export interface ResponderOptions {
  /** Caps every page, whatever `first` asks for (forces multi-page walks with small fixtures). Default 100. */
  maxPageSize?: number;
}

const ENDPOINT = new URL(Configuration.meetup.endpoint);

// Matched by identity of the query text: graphql-request sends the constant
// unchanged, and the queries are anonymous (no operationName to match on).
const QUERY_NAMES = new Map<string, QueryName>([
  [getGroupEvents, 'getGroupEvents'],
  [getGroupEventsCount, 'getGroupEventsCount'],
  [getEventRsvps, 'getEventRsvps'],
  [getUserMembershipInfo, 'getUserMembershipInfo'],
  [getMemberRsvps, 'getMemberRsvps'],
]);

// A filter key the responder does not understand fails loudly instead of
// being silently ignored (which would make a golden pass for the wrong reason).
const GROUP_FILTER_KEYS = new Set([
  'status',
  'afterDateTime',
  'beforeDateTime',
  'hostId',
]);

export const memberUrl = (id: string) =>
  `https://www.meetup.com/members/${id}/`;
export const eventUrl = (id: string) =>
  `https://www.meetup.com/1-5genasians/events/${id}/`;

const cursorFor = (offset: number) =>
  Buffer.from(`offset:${offset}`).toString('base64');

function offsetOf(after: unknown): number {
  if (after === undefined || after === null) {
    return 0;
  }
  const match = /^offset:(\d+)$/.exec(
    Buffer.from(String(after), 'base64').toString(),
  );
  if (!match) {
    throw new Error(`bad cursor ${String(after)}`);
  }
  return Number(match[1]);
}

function page<T>(items: T[], variables: Record<string, unknown>, cap: number) {
  const start = offsetOf(variables.after);
  const size = Math.min(Number(variables.first), cap);
  const slice = items.slice(start, start + size);
  const end = start + slice.length;
  return {
    slice,
    pageInfo: {
      hasNextPage: end < items.length,
      hasPreviousPage: start > 0,
      startCursor: cursorFor(start),
      endCursor: cursorFor(end),
    },
  };
}

export function installMeetupResponder(
  world: MeetupWorld,
  options: ResponderOptions = {},
) {
  const cap = options.maxPageSize ?? 100;
  const calls: RecordedCall[] = [];
  const membersById = new Map(world.members.map((m) => [m.id, m]));
  const eventsById = new Map(world.events.map((e) => [e.id, e]));
  const byStart = (a: FixtureEvent, b: FixtureEvent) =>
    Date.parse(a.dateTime) - Date.parse(b.dateTime);
  const eventsByStart = [...world.events].sort(byStart);

  const member = (id: string) => {
    const found = membersById.get(id);
    if (!found) {
      throw new Error(`unknown member ${id}`);
    }
    return {
      id: found.id,
      name: found.name,
      gender: 'NONE',
      memberUrl: memberUrl(found.id),
    };
  };
  const eventNode = (e: FixtureEvent) => ({
    id: e.id,
    title: e.title,
    dateTime: e.dateTime,
    eventUrl: eventUrl(e.id),
    eventHosts: e.hostIds.map((id) => ({ member: member(id) })),
    maxTickets: e.maxTickets,
    status: e.status,
  });
  const requireGroup = (variables: Record<string, unknown>) => {
    if (variables.urlname !== Configuration.meetup.groupUrlName) {
      throw new Error(`unexpected urlname ${String(variables.urlname)}`);
    }
  };
  // Window semantics: [afterDateTime, beforeDateTime) on the event START.
  // (Real Meetup is said to filter by end time; the client compensates by
  // padding beforeDateTime and re-filtering by start, so start-based matching
  // here reproduces what the client ends up keeping.)
  const matchesGroupFilter = (
    e: FixtureEvent,
    filter: GroupEventFilter | undefined,
  ) => {
    if (!filter) {
      return true;
    }
    Object.keys(filter).forEach((key) => {
      if (!GROUP_FILTER_KEYS.has(key)) {
        throw new Error(`unsupported group event filter "${key}"`);
      }
    });
    const start = Date.parse(e.dateTime);
    if (filter.status && !filter.status.includes(e.status)) {
      return false;
    }
    if (filter.afterDateTime && start < Date.parse(filter.afterDateTime)) {
      return false;
    }
    if (filter.beforeDateTime && start >= Date.parse(filter.beforeDateTime)) {
      return false;
    }
    if (filter.hostId && !e.hostIds.includes(filter.hostId)) {
      return false;
    }
    return true;
  };

  const handlers: Record<QueryName, (v: Record<string, unknown>) => unknown> = {
    getGroupEvents: (v) => {
      requireGroup(v);
      const matching = eventsByStart.filter((e) =>
        matchesGroupFilter(e, v.filter as GroupEventFilter),
      );
      const { slice, pageInfo } = page(matching, v, cap);
      return {
        groupByUrlname: {
          id: world.groupId,
          events: {
            pageInfo,
            totalCount: matching.length,
            edges: slice.map((e) => ({ node: eventNode(e) })),
          },
        },
      };
    },
    getGroupEventsCount: (v) => {
      requireGroup(v);
      return {
        groupByUrlname: {
          id: world.groupId,
          events: {
            totalCount: eventsByStart.filter((e) =>
              matchesGroupFilter(e, v.filter as GroupEventFilter),
            ).length,
          },
        },
      };
    },
    getEventRsvps: (v) => {
      const event = eventsById.get(String(v.eventId));
      if (!event) {
        throw new Error(`unknown event ${String(v.eventId)}`);
      }
      const statuses = (v.filter as { rsvpStatus?: string[] } | undefined)
        ?.rsvpStatus;
      const all = world.rsvps.filter((r) => r.eventId === event.id); // fixture order
      const matching = statuses
        ? all.filter((r) => statuses.includes(r.status))
        : all;
      const { slice, pageInfo } = page(matching, v, cap);
      return {
        event: {
          id: event.id,
          rsvps: {
            pageInfo,
            yesCount: all.filter((r) => r.status === 'YES').length,
            totalCount: matching.length,
            edges: slice.map((r) => ({
              node: { status: r.status, member: member(r.memberId) },
            })),
          },
        },
      };
    },
    getUserMembershipInfo: (v) => {
      requireGroup(v);
      return {
        groupByUrlname: {
          id: world.groupId,
          name: '1.5 Gen Asians (fixture)',
          isMember: true,
          membershipMetadata: {
            status: 'ACTIVE',
            joinTime: '2020-01-01T00:00-08:00',
            rsvpStats: { noShowCount: 0 },
          },
        },
      };
    },
    getMemberRsvps: (v) => {
      requireGroup(v);
      const memberId = String((v.memberIds as number[])[0]);
      const filter = v.filter as {
        groupId: string;
        rsvpStatus: string[];
        eventStatus: ('PAST' | 'UPCOMING')[];
      };
      if (filter.groupId !== world.groupId) {
        throw new Error(`unexpected groupId ${filter.groupId}`);
      }
      if (world.departedIds.includes(memberId) || !membersById.has(memberId)) {
        return {
          groupByUrlname: { id: world.groupId, memberships: { edges: [] } },
        };
      }
      // PAST <-> fixture status PAST; UPCOMING <-> ACTIVE.
      const STATUS_FOR = { PAST: 'PAST', UPCOMING: 'ACTIVE' } as const;
      const statusOk = (e: FixtureEvent) =>
        filter.eventStatus.some((s) => e.status === STATUS_FOR[s]);
      const matching = world.rsvps
        .filter(
          (r) =>
            r.memberId === memberId && filter.rsvpStatus.includes(r.status),
        )
        .map((r) => eventsById.get(r.eventId))
        .filter((e): e is FixtureEvent => e !== undefined && statusOk(e))
        .sort(byStart);
      const { slice, pageInfo } = page(matching, v, cap);
      const withPay = v.withPaymentInfo === true; // @include(if: $withPaymentInfo)
      return {
        groupByUrlname: {
          id: world.groupId,
          memberships: {
            edges: [
              {
                node: {
                  id: memberId,
                  rsvps: {
                    pageInfo,
                    totalCount: matching.length,
                    edges: slice.map((e) => ({
                      node: {
                        event: {
                          id: e.id,
                          title: e.title,
                          dateTime: e.dateTime,
                          eventUrl: eventUrl(e.id),
                          ...(withPay && {
                            description: e.description ?? null,
                            feeSettings: e.fee ?? null,
                          }),
                        },
                      },
                    })),
                  },
                },
              },
            ],
          },
        },
      };
    },
  };

  nock(ENDPOINT.origin)
    .persist()
    .post(ENDPOINT.pathname)
    .reply(function reply(_uri, body) {
      const { query, variables = {} } = body as {
        query: string;
        variables?: Record<string, unknown>;
      };
      // nock lowercases header names; graphql-request sends `authorization`.
      const header = this.req.headers.authorization as
        string | string[] | undefined;
      const authorization = Array.isArray(header) ? header[0] : header;
      const name = QUERY_NAMES.get(query);
      if (!name) {
        calls.push({ name: 'unhandled', variables, authorization });
        return [
          200,
          { errors: [{ message: 'fixture responder: unhandled query' }] },
        ];
      }
      calls.push({ name, variables, authorization });
      try {
        return [200, { data: handlers[name](variables) }];
      } catch (error) {
        return [
          200,
          {
            errors: [
              { message: `fixture responder: ${(error as Error).message}` },
            ],
          },
        ];
      }
    });

  return {
    calls,
    unhandled: () => calls.filter((c) => c.name === 'unhandled'),
  };
}
