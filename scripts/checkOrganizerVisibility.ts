/**
 * Read-only check: can the shared Meetup organizer credential see NO_SHOW and
 * ATTENDED RSVPs? Today the slash commands use the invoking moderator's token;
 * the report job will use the organizer's, so confirm this before relying on it.
 *
 * Run on a Heroku one-off dyno (tsx directly, so yarn's banner is not mixed
 * into the script output):
 *
 *   heroku run -a meetup-discord-bot "node_modules/.bin/tsx scripts/checkOrganizerVisibility.ts -- --event <id>"
 *
 * --event takes digits only (a Meetup event id); anything else exits 1.
 * Without --event it picks the newest PAST event that is at least 2 days old,
 * within the last 30 days. Prefer --event with an event known to have
 * no-shows: 0 / 0 on an event nobody marked proves nothing. (The original
 * command, `heroku run -a meetup-discord-bot "yarn tsx scripts/checkOrganizerVisibility.ts"`,
 * also works but prints yarn's banner.)
 *
 * Writes: none, except a locked token refresh (getOrganizerAccessToken goes
 * through the credential advisory lock) and, if not yet stored, the organizer
 * member id in oauth_credential_meta. First use may also create the
 * credential tables if they are missing. It never touches Redis or Discord
 * (no client is created or passed), and must not be run between 18:00 and
 * 19:00 UTC: the daily identity sweep may be refreshing the same token then
 * (Meetup may rotate refresh tokens; not documented, so assume it does).
 *
 * Script output is counts only, never names:
 *
 *   organizer account matches MEETUP_ORGANIZER_MEMBER_ID: yes|no|not configured
 *   event: <id> (<YYYY-MM-DD Pacific>)
 *   NO_SHOW rsvps visible: <n>
 *   ATTENDED rsvps visible: <n>
 *
 * A count is the number of RSVP edges returned (as the commands count); if
 * Meetup reports more than 100 it is totalCount, marked "(more than 100;
 * totalCount)".
 *
 * Exit codes: 0 both RSVP queries succeeded; 1 no token, no past event or an
 * invalid --event (fixed reason on stderr); 2 a query failed (stderr names the
 * query and error type, plus the HTTP status for a ClientError; never a body).
 *
 * Why names cannot leak: GqlMeetupClient.getUserInfo and getGroupEvents log
 * full results through tslog, and getGroupEvents/getEventRsvps are cached in
 * Redis under keys that ignore the token (a cached moderator-visible answer
 * would defeat this check, and a cache write is a write). So this script
 * talks to GraphQL directly with minimal queries that select no name. As
 * defence in depth, process.stdout/stderr are muted while main() runs, because
 * the token helper logs through tslog and one of its messages embeds a Meetup
 * response body; only this script's own lines are written, through the saved
 * originals. Unhandled errors go through reportFatal, which writes through
 * the saved original stderr while main() has it muted.
 */
import dayjs from 'dayjs';
import { ClientError, GraphQLClient, gql } from 'graphql-request';
import { pathToFileURL } from 'node:url';

import Configuration from '../src/configuration.js';
import { getOrganizerAccessToken } from '../src/lib/helpers/organizerMeetupClient.js';
import { boundedFetch } from '../src/util/boundedFetch.js';
import { tz } from '../src/util/timezone.js';

const REQUEST_TIMEOUT_MS = 30_000;
// Recent past events only; the newest is picked client-side so no ordering
// assumption is made of Meetup's response.
const LOOKBACK_DAYS = 30;
// Younger events may not have had attendance marked yet.
const MIN_AGE_DAYS = 2;
const RSVP_PAGE_SIZE = 100;
const EVENTS_PAGE_SIZE = 50;

const recentPastEvents = gql`
  query ($urlname: String!, $first: Int!, $filter: GroupEventFilter) {
    groupByUrlname(urlname: $urlname) {
      events(first: $first, filter: $filter) {
        pageInfo {
          hasNextPage
        }
        edges {
          node {
            id
            dateTime
          }
        }
      }
    }
  }
`;

const rsvpCount = gql`
  query ($eventId: ID!, $filter: RsvpFilter) {
    event(id: $eventId) {
      rsvps(first: 100, filter: $filter) {
        totalCount
        pageInfo {
          hasNextPage
        }
        edges {
          node {
            status
          }
        }
      }
    }
  }
`;

const selfId = gql`
  query {
    self {
      id
    }
  }
`;

interface EventsResponse {
  groupByUrlname: {
    events: {
      pageInfo: { hasNextPage: boolean };
      edges: { node: { id: string; dateTime: string } }[];
    };
  } | null;
}

interface RsvpsResponse {
  event: {
    rsvps: {
      totalCount: number;
      pageInfo: { hasNextPage: boolean };
      edges: { node: { status: string } }[];
    };
  } | null;
}

/** Names the failing query; the cause is described only by describeError. */
class QueryError extends Error {
  constructor(
    readonly query: 'self' | 'events' | 'rsvps',
    cause: unknown,
  ) {
    super(`${query}: ${describeError(cause)}`);
    this.name = 'QueryError';
  }
}

/** The filter was ignored by Meetup: the result would be meaningless. */
class FilterNotAppliedError extends Error {
  constructor(status: string) {
    super(`filter not applied: ${status}`);
    this.name = 'FilterNotAppliedError';
  }
}

/** Error type only; the HTTP status (a number) for a ClientError. Never a body. */
export function describeError(error: unknown): string {
  if (error instanceof ClientError) {
    const status: unknown = error.response?.status;
    return typeof status === 'number'
      ? `ClientError HTTP ${status}`
      : 'ClientError';
  }
  return error instanceof Error ? error.name : 'UnknownError';
}

async function guarded<T>(
  query: 'self' | 'events' | 'rsvps',
  run: () => Promise<T>,
): Promise<T> {
  try {
    return await run();
  } catch (error: unknown) {
    throw new QueryError(query, error);
  }
}

/** Returns undefined when there is none; `truncated` when more than a page matched. */
async function newestPastEvent(client: GraphQLClient) {
  const now = dayjs();
  const latest = now.subtract(MIN_AGE_DAYS, 'day');
  const data = await guarded('events', () =>
    client.request<EventsResponse>(recentPastEvents, {
      urlname: Configuration.meetup.groupUrlName,
      first: EVENTS_PAGE_SIZE,
      filter: {
        status: ['PAST'],
        afterDateTime: now.subtract(LOOKBACK_DAYS, 'day').toISOString(),
        beforeDateTime: latest.toISOString(),
      },
    }),
  );
  const events = data.groupByUrlname?.events;
  // Meetup filters by end time, so re-check the start time here.
  const eligible = (events?.edges ?? [])
    .map(({ node }) => node)
    .filter((node) => !dayjs(node.dateTime).isAfter(latest));
  eligible.sort(
    (a, b) => dayjs(b.dateTime).valueOf() - dayjs(a.dateTime).valueOf(),
  );
  return {
    event: eligible[0],
    truncated: events?.pageInfo.hasNextPage ?? false,
  };
}

async function visibleCount(
  client: GraphQLClient,
  eventId: string,
  status: 'NO_SHOW' | 'ATTENDED',
): Promise<string> {
  const data = await guarded('rsvps', () =>
    client.request<RsvpsResponse>(rsvpCount, {
      eventId,
      filter: { rsvpStatus: [status] },
    }),
  );
  const rsvps = data.event?.rsvps;
  if (!rsvps) {
    return '0';
  }
  const wrong = rsvps.edges.find(({ node }) => node.status !== status);
  if (wrong) {
    const shown = /^[A-Z_]{1,30}$/.test(wrong.node.status)
      ? wrong.node.status
      : 'UNKNOWN';
    throw new FilterNotAppliedError(shown);
  }
  return rsvps.pageInfo.hasNextPage
    ? `${rsvps.totalCount} (more than ${RSVP_PAGE_SIZE}; totalCount)`
    : String(rsvps.edges.length);
}

// The stderr writer main() saved before muting; undefined when not muted.
let unmutedStderr: typeof process.stderr.write | undefined;

/**
 * Writes `fatal: <error type>` and nothing else. Goes through the saved
 * original writer while main() has stderr muted, so a stray rejection
 * during the run is still reported.
 */
export function reportFatal(error: unknown): void {
  // eslint-disable-next-line @typescript-eslint/unbound-method
  const write = unmutedStderr ?? process.stderr.write;
  write.call(process.stderr, `fatal: ${describeError(error)}\n`);
}

/** `--event <digits>` (a bare `--` is ignored); null when absent, false when invalid. */
function parseEventArg(args: string[]): string | null | false {
  const rest = args.filter((arg) => arg !== '--');
  const at = rest.indexOf('--event');
  if (at === -1) {
    return null;
  }
  const value = rest[at + 1];
  return value !== undefined && /^\d{1,20}$/.test(value) ? value : false;
}

/** Returns the process exit code; prints nothing but the result lines. */
export async function main(args = process.argv.slice(2)): Promise<number> {
  // Saved so the finally block restores exactly what was there (a test spy,
  // in the unit tests), and so our own lines bypass the mute.
  // eslint-disable-next-line @typescript-eslint/unbound-method
  const originalStdout = process.stdout.write;
  // eslint-disable-next-line @typescript-eslint/unbound-method
  const originalStderr = process.stderr.write;
  const realStdout = (text: string): void => {
    originalStdout.call(process.stdout, text);
  };
  const realStderr = (text: string): void => {
    originalStderr.call(process.stderr, text);
  };
  const mute = (() => true) as typeof process.stdout.write;
  try {
    unmutedStderr = originalStderr;
    process.stdout.write = mute;
    process.stderr.write = mute;

    const eventArg = parseEventArg(args);
    if (eventArg === false) {
      realStderr('invalid --event\n');
      return 1;
    }
    // No client: no Discord connection, no alerts.
    const token = await getOrganizerAccessToken();
    if (!token) {
      realStderr('no organizer token\n');
      return 1;
    }
    const client = new GraphQLClient(Configuration.meetup.endpoint, {
      headers: { authorization: `Bearer ${token}` },
      fetch: (url, init) => boundedFetch(url, init, REQUEST_TIMEOUT_MS),
    });

    let lines: string[];
    try {
      const expected = Configuration.meetup.organizerMemberId;
      let matches = 'not configured';
      if (expected) {
        const self = await guarded('self', () =>
          client.request<{ self: { id: string } }>(selfId),
        );
        matches = self.self.id === expected ? 'yes' : 'no';
      }
      let eventId: string;
      let eventDate: dayjs.Dayjs | undefined;
      if (eventArg === null) {
        const { event, truncated } = await newestPastEvent(client);
        if (truncated) {
          realStderr(
            `more than ${EVENTS_PAGE_SIZE} past events in the window; picked the newest of those returned\n`,
          );
        }
        if (!event) {
          realStderr('no past event in the last 30 days\n');
          return 1;
        }
        eventId = event.id;
        eventDate = dayjs(event.dateTime);
      } else {
        eventId = eventArg;
      }
      const noShow = await visibleCount(client, eventId, 'NO_SHOW');
      const attended = await visibleCount(client, eventId, 'ATTENDED');
      lines = [
        `organizer account matches MEETUP_ORGANIZER_MEMBER_ID: ${matches}`,
        `event: ${eventId}${eventDate ? ` (${tz(eventDate).format('YYYY-MM-DD')})` : ''}`,
        `NO_SHOW rsvps visible: ${noShow}`,
        `ATTENDED rsvps visible: ${attended}`,
      ];
    } catch (error: unknown) {
      // QueryError / FilterNotAppliedError messages are composed here from
      // fixed text and numbers; anything else is reduced to its type.
      realStderr(
        `${
          error instanceof QueryError || error instanceof FilterNotAppliedError
            ? error.message
            : describeError(error)
        }\n`,
      );
      return 2;
    }
    realStdout(`${lines.join('\n')}\n`);
    return 0;
  } finally {
    process.stdout.write = originalStdout;
    process.stderr.write = originalStderr;
    unmutedStderr = undefined;
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  // Errors outside main() bypass its mute, so they get a handler that can
  // only print the error type.
  const die = (error: unknown): void => {
    reportFatal(error);
    process.exit(2);
  };
  process.on('unhandledRejection', die);
  process.on('uncaughtException', die);
  // Exit explicitly: the credential repository's pg pool would hold the
  // process open.
  main().then((code) => process.exit(code), die);
}
