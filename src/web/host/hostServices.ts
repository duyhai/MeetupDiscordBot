import { Client } from 'discord.js';

import { GUILD_ID, SERVER_ROLES } from '../../constants.js';
import { GqlMeetupClient } from '../../lib/client/meetup/gqlClient.js';
import { getPaginatedData } from '../../lib/client/meetup/paginationHelper.js';
import {
  existingEventFilter,
  isEventFor,
} from '../../lib/hosts/eventRequest.js';
import { HostResolveDeps, resolveHost } from '../../lib/hosts/eligibility.js';
import { PublishDeps, publishRequest } from '../../lib/hosts/publishRequest.js';
import { LogEntry, logAlert } from '../../lib/helpers/discordLogger.js';
import { getBadges } from '../../lib/helpers/getBadges.js';
import { getUserRoles } from '../../lib/helpers/getUserRoles.js';
import { selfOnboardUser } from '../../lib/helpers/onboardUser.js';
import { VerificationSummary } from '../../lib/helpers/verificationSummary.js';
import { VerifyContext } from '../../lib/helpers/verifyContext.js';
import { getOrganizerAccessToken } from '../../lib/helpers/organizerMeetupClient.js';
import {
  OrganizerTokenUnavailableError,
  withOrganizerMeetup,
} from '../../lib/reports/organizerMeetup.js';
import { PostgresEventRequestRepository } from '../../lib/repositories/postgresEventRequestRepository.js';
import { PostgresMemberRepository } from '../../lib/repositories/postgresMemberRepository.js';
import { PostgresPromotedHostRepository } from '../../lib/repositories/postgresPromotedHostRepository.js';
import { ApplicationCache } from '../../util/cache.js';
import { discordRoleCheck } from '../roleGate.js';
import { SessionStore } from '../session.js';
import { timedCacheFactory } from '../timedCache.js';
import { HOST_SESSION_OPTIONS, HostSession } from './hostSession.js';

/** Production lookups for resolveHost. Each throws when its source is down. */
export function hostResolveDeps(
  getClient: () => Client | undefined,
): HostResolveDeps {
  const guestHost = discordRoleCheck(getClient, SERVER_ROLES.guest_host);
  return {
    discordIdForMeetup: async (meetupId) =>
      (
        await (
          await PostgresMemberRepository.instance()
        ).findByMeetupId(meetupId)
      )?.discordUserId,
    meetupIdForDiscord: async (discordId) =>
      (
        await (
          await PostgresMemberRepository.instance()
        ).findByDiscordId(discordId)
      )?.meetupId ?? undefined,
    hasGuestHostRole: guestHost,
    pastHostedCount: (meetupId) =>
      withOrganizerMeetup(getClient(), (meetup) =>
        meetup.getGroupEventsCount({ status: ['PAST'], hostId: meetupId }),
      ),
    isPromoted: async (meetupId) =>
      (await PostgresPromotedHostRepository.instance()).isPromoted(meetupId),
  };
}

/** #meetup-bot-alerts, plain; false while the bot is not logged in. */
export function alertVia(
  getClient: () => Client | undefined,
): (entry: LogEntry) => Promise<unknown> {
  return async (entry) => {
    const client = getClient();
    return client ? logAlert(client, entry) : false;
  };
}

/**
 * Production publish deps, shared by the host site (a Community Host's own
 * request) and the staff queue (approve, retry). The organizer client is
 * made once per publish and never re-runs a write on a 401.
 */
export function productionPublishDeps(
  getClient: () => Client | undefined,
): PublishDeps {
  const resolveDeps = hostResolveDeps(getClient);
  return {
    requests: {
      startPublishing: async (...args) =>
        (await PostgresEventRequestRepository.instance()).startPublishing(
          ...args,
        ),
      recordCreated: async (...args) =>
        (await PostgresEventRequestRepository.instance()).recordCreated(
          ...args,
        ),
      finish: async (...args) =>
        (await PostgresEventRequestRepository.instance()).finish(...args),
    },
    organizer: async () => {
      const token = await getOrganizerAccessToken({ client: getClient() });
      if (!token) {
        throw new OrganizerTokenUnavailableError();
      }
      return new GqlMeetupClient(token, { bypassCache: true });
    },
    // Fresh, not organizerGroupEvents' 5-minute cache: the event may have
    // been created a minute ago.
    findExisting: async (request) => {
      const nodes = await withOrganizerMeetup(getClient(), (meetup) =>
        getPaginatedData(async (pagination) => {
          const result = await meetup.getGroupEvents(
            pagination,
            existingEventFilter(request),
          );
          return result.groupByUrlname.events;
        }),
      );
      const match = nodes.find((node) => isEventFor(node, request));
      return match
        ? { id: String(match.id), eventUrl: String(match.eventUrl) }
        : undefined;
    },
    tierOf: async (meetupMemberId) => {
      const resolution = await resolveHost(resolveDeps, { meetupMemberId });
      return resolution.kind === 'host' ? resolution.tier : 'not-a-host';
    },
    alert: alertVia(getClient),
    now: () => new Date(),
  };
}

/** publishRequest on the production deps. */
export function productionPublisher(getClient: () => Client | undefined) {
  const deps = productionPublishDeps(getClient);
  return (
    ...args: Parameters<typeof publishRequest> extends [unknown, ...infer R]
      ? R
      : never
  ) => publishRequest(deps, ...args);
}

/**
 * The Verify button's steps for "Verify on Discord" on the host dashboard:
 * the same selfOnboardUser → getUserRoles → getBadges, run as the member
 * with their fresh Meetup access token (used here once, never stored), on
 * a context built from the Discord account just linked.
 */
export function verifyRunner(
  getClient: () => Client | undefined,
): (
  meetupAccessToken: string,
  discordUserId: string,
) => Promise<VerificationSummary> {
  return async (meetupAccessToken, discordUserId) => {
    const client = getClient();
    if (!client) {
      throw new Error('Discord client is not ready');
    }
    const guild = await client.guilds.fetch(GUILD_ID);
    const user = await client.users.fetch(discordUserId);
    const member: VerifyContext = {
      guild,
      client,
      userId: discordUserId,
      username: user.username,
      attempt: 'host dashboard',
      linkMethod: 'web_link',
    };
    const meetupClient = new GqlMeetupClient(meetupAccessToken, {
      bypassCache: true,
    });
    const { meetupName, meetupMemberUrl } = await selfOnboardUser(
      meetupClient,
      member,
    );
    const rolesGranted = await getUserRoles(meetupClient, member);
    const { hostedCount, attendedCount } = await getBadges(
      meetupClient,
      member,
    );
    return {
      meetupName,
      meetupMemberUrl,
      rolesGranted,
      hostedCount,
      attendedCount,
    };
  };
}

const sessionCache = timedCacheFactory(ApplicationCache);

/**
 * Ends every host-dashboard session of a Meetup member (the staff side's
 * promote and demote), on the cache the host site's sessions live in.
 */
export async function revokeHostSessions(
  meetupMemberId: string,
): Promise<void> {
  await new SessionStore<HostSession>(
    await sessionCache(),
    Date.now,
    HOST_SESSION_OPTIONS,
  ).revokeUser(meetupMemberId);
}
