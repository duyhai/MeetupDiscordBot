import { Client } from 'discord.js';

import { SERVER_ROLES } from '../../constants.js';
import { GqlMeetupClient } from '../../lib/client/meetup/gqlClient.js';
import { HostResolveDeps, resolveHost } from '../../lib/hosts/eligibility.js';
import { PublishDeps, publishRequest } from '../../lib/hosts/publishRequest.js';
import { LogEntry, logAlert } from '../../lib/helpers/discordLogger.js';
import { getOrganizerAccessToken } from '../../lib/helpers/organizerMeetupClient.js';
import {
  OrganizerTokenUnavailableError,
  withOrganizerMeetup,
} from '../../lib/reports/organizerMeetup.js';
import { PostgresEventRequestRepository } from '../../lib/repositories/postgresEventRequestRepository.js';
import { PostgresMemberRepository } from '../../lib/repositories/postgresMemberRepository.js';
import { PostgresPromotedHostRepository } from '../../lib/repositories/postgresPromotedHostRepository.js';
import { discordRoleCheck } from '../roleGate.js';

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
