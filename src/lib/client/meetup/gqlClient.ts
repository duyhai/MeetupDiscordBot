import dayjs from 'dayjs';
import { GraphQLClient } from 'graphql-request';
import { Logger } from 'tslog';
import Configuration from '../../../configuration.js';
import {
  FetchInit,
  FetchUrl,
  boundedFetch,
} from '../../../util/boundedFetch.js';
import { cachedClientRequest } from '../cacheClientHelper.js';
import {
  announceEvent,
  closeEventRsvps,
  createEvent,
  editEvent,
  publishEventDraft,
} from './mutations.js';
import {
  getEvent,
  getEventRsvps,
  getGroupEvents,
  getGroupEventsCount,
  getGroupMembersByIds,
  getGroupMemberships,
  getMemberRsvps,
  getSelfPastRsvpCount,
  getUserHostedEvents,
  getUserInfo,
  getUserMembershipInfo,
} from './queries.js';
import {
  AnnounceEventInput,
  AnnounceEventResponse,
  BaseUserInfo,
  CloseEventRsvpsInput,
  CloseEventRsvpsResponse,
  CreateEventInput,
  CreateEventResponse,
  EditEventInput,
  EditEventResponse,
  EventSummary,
  GetEventResponse,
  GetEventRsvpsInput,
  GetEventRsvpsResponse,
  GetGroupEventsCountInput,
  GetGroupEventsCountResponse,
  GetGroupEventsInput,
  GetGroupEventsResponse,
  GetGroupMembersByIdsInput,
  GetGroupMembershipsInput,
  GetGroupMembershipsResponse,
  GetGroupMembersByIdsResponse,
  GetMemberRsvpsInput,
  GetMemberRsvpsResponse,
  GetUserHostedEventsInput,
  GetUserHostedEventsResponse,
  GetUserInfoResponse,
  GetUserMembershipInfoInput,
  GetUserMembershipInfoResponse,
  GroupEventFilter,
  MemberRsvpFilter,
  PaginationInput,
  PublishEventDraftInput,
  PublishEventDraftResponse,
  RsvpFilter,
} from './types.js';

const logger = new Logger({ name: 'GqlMeetupClient' });

// Matches the page size getPaginatedData already uses successfully against
// Meetup's API.
const MEMBER_LOOKUP_PAGE_SIZE = 100;
const MEMBER_RSVP_PAGE_SIZE = 100;

/**
 * Applied client-wide rather than to the roster query alone.
 *
 * Undici sets no total-request deadline, so a stalled connection to Meetup
 * never rejects. That is survivable on an interactive command -- the
 * interaction times out and a human retries -- but the roster walk runs
 * inside the daily digest after the day-claim is taken, where a hang means no
 * digest, no error and no retry until someone notices.
 *
 * Deliberately generous. This is a guard against hanging forever, not a
 * latency budget: the point is that every request terminates, and 30s is far
 * beyond anything a healthy Meetup query takes, so no existing caller's
 * behaviour changes. Tightening it toward real latencies would start failing
 * slow-but-working queries, which is a different and worse bug.
 */
const GQL_REQUEST_TIMEOUT_MS = 30_000;

/**
 * The group came back null. Named and self-describing because this is the
 * one error on the roster path an organizer can actually act on, and it
 * reaches them through the digest's degraded-sweep alert.
 */
export class MeetupGroupUnreadableError extends Error {
  /** Composed here rather than lifted from a response body; see below. */
  readonly organizerSafeMessage = true;

  constructor(urlname: string) {
    super(
      `Meetup returned no group for "${urlname}": the organizer token cannot ` +
        'read this group -- check that the grant is still valid and was made ' +
        'by an organizer of it.',
    );
    this.name = 'MeetupGroupUnreadableError';
  }
}

export class GqlMeetupClient {
  private client: GraphQLClient;

  constructor(accessToken: string) {
    this.client = new GraphQLClient(Configuration.meetup.endpoint, {
      headers: {
        authorization: `Bearer ${accessToken}`,
      },
      fetch: (url: FetchUrl, init?: FetchInit) =>
        boundedFetch(url, init, GQL_REQUEST_TIMEOUT_MS),
    });
  }

  public async customRequest(query: string, args: string): Promise<string> {
    logger.info(
      `Calling customRequest with input: ${JSON.stringify({ query, args })}`,
    );
    try {
      const result = JSON.stringify(
        await this.client.rawRequest(query, JSON.parse(args)),
      );
      logger.info(`customRequest result: ${result}`);
      return result;
    } catch (error) {
      logger.error(error);
      throw error;
    }
  }

  public async getUserInfo() {
    logger.info(`Calling getUserInfo with input: ${JSON.stringify({})}`);
    try {
      const result =
        await this.client.request<GetUserInfoResponse>(getUserInfo);
      logger.info(`getUserInfo result: ${JSON.stringify(result)}`);
      return result;
    } catch (error) {
      logger.error(error);
      throw error;
    }
  }

  public async getUserMembershipInfo() {
    logger.info(
      `Calling getUserMembershipInfo with input: ${JSON.stringify({})}`,
    );
    try {
      const result = await this.client.request<
        GetUserMembershipInfoResponse,
        GetUserMembershipInfoInput
      >(getUserMembershipInfo, {
        urlname: Configuration.meetup.groupUrlName,
      });
      logger.info(`getUserMembershipInfo result: ${JSON.stringify(result)}`);
      return result;
    } catch (error) {
      logger.error(error);
      throw error;
    }
  }

  public async getSelfPastRsvpCount(groupId: string) {
    logger.info(`Calling getSelfPastRsvpCount for group ${groupId}`);
    try {
      const result = await this.client.request<
        { self: { id: string; rsvps: { totalCount: number } } },
        { groupId: string }
      >(getSelfPastRsvpCount, { groupId });
      return result.self.rsvps.totalCount;
    } catch (error) {
      logger.error(error);
      throw error;
    }
  }

  public async getUserHostedEvents(input: PaginationInput) {
    logger.info(
      `Calling getUserHostedEvents with input: ${JSON.stringify(input)}`,
    );
    try {
      const result = await this.client.request<
        GetUserHostedEventsResponse,
        GetUserHostedEventsInput
      >(getUserHostedEvents, {
        ...input,
      });
      logger.info(`getUserHostedEvents result: ${JSON.stringify(result)}`);
      return result;
    } catch (error) {
      logger.error(error);
      throw error;
    }
  }

  public async getGroupEvents(
    input: PaginationInput,
    filter?: GroupEventFilter,
  ) {
    logger.info(
      `Calling getGroupEvents with input: ${JSON.stringify({ input, filter })}`,
    );

    let requestFilter = filter;
    let originalBeforeDateTime: number | undefined;
    let originalAfterDateTime: number | undefined;

    if (filter) {
      if (filter.afterDateTime) {
        originalAfterDateTime = dayjs(filter.afterDateTime).valueOf();
      }
      if (filter.beforeDateTime) {
        originalBeforeDateTime = dayjs(filter.beforeDateTime).valueOf();
        // Workaround: Expand query by 1 month to catch events ending later but starting within range
        const beforeDate = dayjs(filter.beforeDateTime);
        requestFilter = {
          ...filter,
          beforeDateTime: beforeDate.add(1, 'month').toISOString(),
        };
      }
    }

    // Can be cached because it doesn't retrieve user specific data
    return cachedClientRequest(
      'getGroupEvents',
      {
        urlname: Configuration.meetup.groupUrlName,
        ...input,
        filter: requestFilter,
      },
      async (callbackInput: GetGroupEventsInput) => {
        try {
          const result = await this.client.request<
            GetGroupEventsResponse,
            GetGroupEventsInput
          >(getGroupEvents, callbackInput);

          // Workaround: Filter in code by startDate, because Meetup filters by endDate
          if (
            result.groupByUrlname?.events?.edges &&
            (originalBeforeDateTime !== undefined ||
              originalAfterDateTime !== undefined)
          ) {
            result.groupByUrlname.events.edges =
              result.groupByUrlname.events.edges.filter((edge) => {
                const eventTime = dayjs(edge.node.dateTime).valueOf();
                if (
                  originalAfterDateTime !== undefined &&
                  eventTime < originalAfterDateTime
                ) {
                  return false;
                }
                if (
                  originalBeforeDateTime !== undefined &&
                  eventTime > originalBeforeDateTime
                ) {
                  return false;
                }
                return true;
              });
          }

          logger.info(`getGroupEvents result: ${JSON.stringify(result)}`);
          return result;
        } catch (error) {
          logger.error(error);
          throw error;
        }
      },
    );
  }

  /**
   * Like getGroupEvents, but sends the given filter unmodified (no
   * +1-month beforeDateTime expansion) and returns only totalCount. Use
   * this whenever a caller needs a count for an exact window -- the
   * expansion in getGroupEvents exists to catch multi-day events straddling
   * the boundary and would otherwise inflate the count.
   */
  public async getGroupEventsCount(filter?: GroupEventFilter): Promise<number> {
    logger.info(
      `Calling getGroupEventsCount with input: ${JSON.stringify({ filter })}`,
    );
    // Can be cached because it doesn't retrieve user specific data
    return cachedClientRequest(
      'getGroupEventsCount',
      {
        urlname: Configuration.meetup.groupUrlName,
        filter,
      },
      async (callbackInput: GetGroupEventsCountInput) => {
        try {
          const result = await this.client.request<
            GetGroupEventsCountResponse,
            GetGroupEventsCountInput
          >(getGroupEventsCount, callbackInput);
          logger.info(`getGroupEventsCount result: ${JSON.stringify(result)}`);
          return result.groupByUrlname.events.totalCount;
        } catch (error) {
          logger.error(error);
          throw error;
        }
      },
    );
  }

  /**
   * Looks up current group members by their Meetup IDs. Only people who are
   * still members of the group resolve; anyone who left is simply absent
   * from the result, so callers must treat misses as "name unknown".
   */
  public async getGroupMembersByIds(
    memberIds: string[],
  ): Promise<BaseUserInfo[]> {
    // Paged rather than one request of `first: memberIds.length`: this
    // lookup decides which suspension rows get recorded, and a response
    // truncated at Meetup's page cap would make every member past it look
    // unknown and have their suspension silently skipped.
    const members: BaseUserInfo[] = [];
    for (
      let start = 0;
      start < memberIds.length;
      start += MEMBER_LOOKUP_PAGE_SIZE
    ) {
      members.push(
        // eslint-disable-next-line no-await-in-loop
        ...(await this.getGroupMembersPage(
          memberIds.slice(start, start + MEMBER_LOOKUP_PAGE_SIZE),
        )),
      );
    }
    return members;
  }

  private async getGroupMembersPage(
    memberIds: string[],
  ): Promise<BaseUserInfo[]> {
    logger.info(
      `Calling getGroupMembersByIds with input: ${JSON.stringify({
        memberIds,
      })}`,
    );
    // Can be cached because it doesn't retrieve user specific data
    return cachedClientRequest(
      'getGroupMembersByIds',
      {
        urlname: Configuration.meetup.groupUrlName,
        memberIds: memberIds.map(Number),
        first: memberIds.length,
      },
      async (callbackInput: GetGroupMembersByIdsInput) => {
        try {
          const result = await this.client.request<
            GetGroupMembersByIdsResponse,
            GetGroupMembersByIdsInput
          >(getGroupMembersByIds, callbackInput);
          logger.info(`getGroupMembersByIds result: ${JSON.stringify(result)}`);
          return result.groupByUrlname.memberships.edges.map(
            ({ node }) => node,
          );
        } catch (error) {
          logger.error(error);
          throw error;
        }
      },
    );
  }

  /**
   * The events one member RSVP'd to in this group with the given statuses,
   * all pages. Returns undefined when the member isn't in the group any
   * more, so callers can tell "no RSVPs" from "can't see their history".
   *
   * Not cached: no-shows are marked after events and upcoming RSVPs change,
   * so a 12-hour-old answer would mislead the no-show report.
   */
  public async getMemberRsvpEvents(
    memberId: string,
    groupId: string,
    filter: MemberRsvpFilter,
  ): Promise<EventSummary[] | undefined> {
    logger.info(
      `Calling getMemberRsvpEvents with input: ${JSON.stringify({
        memberId,
        filter,
      })}`,
    );
    const events: EventSummary[] = [];
    let after: string | undefined;
    for (;;) {
      let result: GetMemberRsvpsResponse;
      try {
        // eslint-disable-next-line no-await-in-loop
        result = await this.client.request<
          GetMemberRsvpsResponse,
          GetMemberRsvpsInput
        >(getMemberRsvps, {
          urlname: Configuration.meetup.groupUrlName,
          memberIds: [Number(memberId)],
          first: MEMBER_RSVP_PAGE_SIZE,
          after,
          filter: { groupId, ...filter },
        });
      } catch (error) {
        logger.error(error);
        throw error;
      }
      const membership = result.groupByUrlname.memberships.edges[0];
      if (!membership) {
        return undefined;
      }
      const { rsvps } = membership.node;
      events.push(...rsvps.edges.map(({ node }) => node.event));
      if (!rsvps.pageInfo.hasNextPage) {
        return events;
      }
      after = rsvps.pageInfo.endCursor;
    }
  }

  // Deliberately NOT wrapped in cachedClientRequest, unlike getGroupEvents
  // above: the identity sweep diffs today's roster against yesterday's
  // stored snapshot, so this call must always hit the live API. A cached
  // roster would make the sweep compare today's baseline against yesterday's
  // data, which defeats the point of the diff.
  public async getGroupMemberships(input: PaginationInput) {
    logger.info(
      `Calling getGroupMemberships with input: ${JSON.stringify(input)}`,
    );
    try {
      const result = await this.client.request<
        GetGroupMembershipsResponse,
        GetGroupMembershipsInput
      >(getGroupMemberships, {
        urlname: Configuration.meetup.groupUrlName,
        ...input,
      });
      // Meetup answers an unreadable group with a null node and no GraphQL
      // error, so this is the shape an expired or under-scoped organizer
      // grant actually arrives in. Without the check it becomes "cannot read
      // properties of null" from inside the pagination loop, which says
      // nothing about the credential that is the real cause.
      if (!result.groupByUrlname) {
        throw new MeetupGroupUnreadableError(Configuration.meetup.groupUrlName);
      }
      // Counts only, not the full page: this method returns ~60 full roster
      // pages of member names and photo URLs daily, and this repo has a
      // production log-flooding history (a previous feature emitted ~900
      // lines per run before an incident surfaced it).
      const { edges, pageInfo } = result.groupByUrlname.memberships;
      logger.info(
        `getGroupMemberships page: ${edges.length} members, hasNextPage=${pageInfo.hasNextPage}`,
      );
      return result;
    } catch (error) {
      logger.error(error);
      throw error;
    }
  }

  public async getEventRsvps(
    eventId: string,
    input: PaginationInput,
    filter?: RsvpFilter,
  ) {
    logger.info(
      `Calling getEventRsvps with input: ${JSON.stringify({
        eventId,
        input,
        filter,
      })}`,
    );
    // Can be cached because it doesn't retrieve user specific data
    return cachedClientRequest(
      'getEventRsvps',
      {
        eventId,
        ...input,
        filter,
      },
      async (callbackInput: GetEventRsvpsInput) => {
        try {
          const result = await this.client.request<
            GetEventRsvpsResponse,
            GetEventRsvpsInput
          >(getEventRsvps, callbackInput);
          // logger.info(`getEventRsvps result: ${JSON.stringify(result)}`);
          return result;
        } catch (error) {
          logger.error(error);
          throw error;
        }
      },
    );
  }

  public async getEvent(eventId: string) {
    logger.info(`Calling getEvent with input: ${JSON.stringify({ eventId })}`);
    try {
      const result = await this.client.request<GetEventResponse>(getEvent, {
        eventId,
      });
      logger.info(`getEvent result: ${JSON.stringify(result)}`);
      return result;
    } catch (error) {
      logger.error(error);
      throw error;
    }
  }

  public async createEvent(input: CreateEventInput) {
    logger.info(`Calling createEvent with input: ${JSON.stringify({ input })}`);
    try {
      const result = await this.client.request<CreateEventResponse>(
        createEvent,
        { input },
      );
      logger.info(`createEvent result: ${JSON.stringify(result)}`);
      return result;
    } catch (error) {
      logger.error(error);
      throw error;
    }
  }

  public async editEvent(input: EditEventInput) {
    logger.info(`Calling editEvent with input: ${JSON.stringify({ input })}`);
    try {
      const result = await this.client.request<EditEventResponse>(editEvent, {
        input,
      });
      logger.info(`editEvent result: ${JSON.stringify(result)}`);
      return result;
    } catch (error) {
      logger.error(error);
      throw error;
    }
  }

  public async closeEventRsvps(input: CloseEventRsvpsInput) {
    logger.info(
      `Calling closeEventRsvps with input: ${JSON.stringify({ input })}`,
    );
    try {
      const result = await this.client.request<CloseEventRsvpsResponse>(
        closeEventRsvps,
        { input },
      );
      logger.info(`closeEventRsvps result: ${JSON.stringify(result)}`);
      return result;
    } catch (error) {
      logger.error(error);
      throw error;
    }
  }

  public async publishEventDraft(input: PublishEventDraftInput) {
    logger.info(
      `Calling publishEventDraft with input: ${JSON.stringify({ input })}`,
    );
    try {
      const result = await this.client.request<PublishEventDraftResponse>(
        publishEventDraft,
        { input },
      );
      logger.info(`publishEventDraft result: ${JSON.stringify(result)}`);
      return result;
    } catch (error) {
      logger.error(error);
      throw error;
    }
  }

  public async announceEvent(input: AnnounceEventInput) {
    logger.info(
      `Calling announceEvent with input: ${JSON.stringify({ input })}`,
    );
    try {
      const result = await this.client.request<AnnounceEventResponse>(
        announceEvent,
        { input },
      );
      logger.info(`announceEvent result: ${JSON.stringify(result)}`);
      return result;
    } catch (error) {
      logger.error(error);
      throw error;
    }
  }
}
