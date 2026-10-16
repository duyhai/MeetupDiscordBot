/**
 * Read-only check: can the shared Meetup organizer credential see NO_SHOW and
 * ATTENDED RSVPs? Today the slash commands use the invoking moderator's token;
 * the report job will use the organizer's, so confirm this before relying on it.
 *
 * Run on a Heroku one-off dyno:
 *
 *   heroku run -a meetup-discord-bot "yarn tsx scripts/checkOrganizerVisibility.ts"
 *
 * It writes nothing except a possible token refresh, which goes through
 * getOrganizerAccessToken and so under the credential advisory lock. It never
 * logs in to Discord (no client is created or passed). Do NOT run it between
 * 18:00 and 19:00 UTC: the daily identity sweep may be refreshing the same
 * rotating token then.
 *
 * Output is exactly four lines on stdout and counts only, never names:
 *
 *   organizer account matches MEETUP_ORGANIZER_MEMBER_ID: yes|no|not configured
 *   event: <id> (<YYYY-MM-DD Pacific>)
 *   NO_SHOW rsvps visible: <n>
 *   ATTENDED rsvps visible: <n>
 *
 * Exit codes: 0 both RSVP queries succeeded; 1 no token or no past event;
 * 2 a query failed (only the error name is printed, to stderr).
 *
 * Why names cannot leak: GqlMeetupClient.getUserInfo and getGroupEvents log
 * full results through tslog, and getGroupEvents/getEventRsvps are cached in
 * Redis under keys that ignore the token (a cached moderator-visible answer
 * would defeat this check, and a cache write is a write). So this script
 * talks to GraphQL directly with minimal queries that do not select any name
 * (`self { id }`, event ids and dates, RSVP `totalCount`). As defence in
 * depth, process.stdout/stderr are muted while main() runs, because the token
 * helper logs through tslog and one of its messages embeds a Meetup response
 * body; only this script's own lines are written, through the saved originals.
 */
import dayjs from 'dayjs';
import { GraphQLClient, gql } from 'graphql-request';
import { pathToFileURL } from 'node:url';

import Configuration from '../src/configuration.js';
import { getOrganizerAccessToken } from '../src/lib/helpers/organizerMeetupClient.js';
import { boundedFetch } from '../src/util/boundedFetch.js';
import { tz } from '../src/util/timezone.js';

const REQUEST_TIMEOUT_MS = 30_000;
// Recent past events only; the newest is picked client-side so no ordering
// assumption is made of Meetup's response.
const LOOKBACK_DAYS = 60;
const EVENTS_PAGE_SIZE = 50;

const recentPastEvents = gql`
  query ($urlname: String!, $first: Int!, $filter: GroupEventFilter) {
    groupByUrlname(urlname: $urlname) {
      events(first: $first, filter: $filter) {
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
      rsvps(first: 1, filter: $filter) {
        totalCount
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
    events: { edges: { node: { id: string; dateTime: string } }[] };
  } | null;
}

async function newestPastEvent(client: GraphQLClient) {
  const now = dayjs();
  const data = await client.request<EventsResponse>(recentPastEvents, {
    urlname: Configuration.meetup.groupUrlName,
    first: EVENTS_PAGE_SIZE,
    filter: {
      status: ['PAST'],
      afterDateTime: now.subtract(LOOKBACK_DAYS, 'day').toISOString(),
      beforeDateTime: now.toISOString(),
    },
  });
  const started = (data.groupByUrlname?.events.edges ?? [])
    .map(({ node }) => node)
    .filter((node) => dayjs(node.dateTime).isBefore(now));
  started.sort(
    (a, b) => dayjs(b.dateTime).valueOf() - dayjs(a.dateTime).valueOf(),
  );
  return started[0];
}

async function visibleCount(
  client: GraphQLClient,
  eventId: string,
  status: 'NO_SHOW' | 'ATTENDED',
): Promise<number> {
  const data = await client.request<{
    event: { rsvps: { totalCount: number } } | null;
  }>(rsvpCount, { eventId, filter: { rsvpStatus: [status] } });
  return data.event?.rsvps.totalCount ?? 0;
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : 'UnknownError';
}

/** Returns the process exit code; prints nothing but the four result lines. */
export async function main(): Promise<number> {
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
  process.stdout.write = mute;
  process.stderr.write = mute;
  try {
    // No client: no Discord connection, no alerts.
    const token = await getOrganizerAccessToken();
    if (!token) {
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
        const self = await client.request<{ self: { id: string } }>(selfId);
        matches = self.self.id === expected ? 'yes' : 'no';
      }
      const event = await newestPastEvent(client);
      if (!event) {
        return 1;
      }
      const noShow = await visibleCount(client, event.id, 'NO_SHOW');
      const attended = await visibleCount(client, event.id, 'ATTENDED');
      lines = [
        `organizer account matches MEETUP_ORGANIZER_MEMBER_ID: ${matches}`,
        `event: ${event.id} (${tz(dayjs(event.dateTime)).format('YYYY-MM-DD')})`,
        `NO_SHOW rsvps visible: ${noShow}`,
        `ATTENDED rsvps visible: ${attended}`,
      ];
    } catch (error: unknown) {
      realStderr(`${errorName(error)}\n`);
      return 2;
    }
    realStdout(`${lines.join('\n')}\n`);
    return 0;
  } finally {
    process.stdout.write = originalStdout;
    process.stderr.write = originalStderr;
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  // Exit explicitly: the credential repository's pg pool would hold the
  // process open.
  main().then(
    (code) => process.exit(code),
    (error: unknown) => {
      process.stderr.write(`${errorName(error)}\n`);
      process.exit(2);
    },
  );
}
