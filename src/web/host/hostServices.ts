import { Client } from 'discord.js';
import { Logger } from 'tslog';

import { GUILD_ID, SERVER_ROLES } from '../../constants.js';
import { GqlMeetupClient } from '../../lib/client/meetup/gqlClient.js';
import { getPaginatedData } from '../../lib/client/meetup/paginationHelper.js';
import {
  existingEventFilter,
  isEventFor,
} from '../../lib/hosts/eventRequest.js';
import {
  HostResolveDeps,
  publishTier,
  resolveHost,
} from '../../lib/hosts/eligibility.js';
import {
  AnnounceDeps,
  AnnounceEventDetails,
  announceHostEvent,
  cancelHeldAnnouncement,
  requestAnnouncement,
} from '../../lib/hosts/announceEvent.js';
import { AnnounceTickDeps } from '../../lib/hosts/announceTick.js';
import {
  RecreateDeps,
  recreatable,
  recreateAndAnnounce,
} from '../../lib/hosts/recreateEvent.js';
import { HostEventsDeps, hostedEvents } from '../../lib/hosts/hostEvents.js';
import { PostgresEventAnnouncementRepository } from '../../lib/repositories/postgresEventAnnouncementRepository.js';
import type { AnnounceRouteDeps } from './announcePage.js';
import { PublishDeps, publishRequest } from '../../lib/hosts/publishRequest.js';
import { DiscordRequestDeps } from '../../lib/hosts/discordRequests.js';
import {
  DecisionDeps,
  REFUSAL_AUDIT_WINDOW_MS,
  decideRequest,
} from '../../lib/hosts/requestDecision.js';
import {
  RequestPostDeps,
  mirrorDecision,
  postRequest,
} from '../../lib/hosts/requestPost.js';
import {
  LogEntry,
  logActivity,
  logAlert,
} from '../../lib/helpers/discordLogger.js';
import { countHostedEvents } from '../../lib/helpers/countHostedEvents.js';
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
import {
  DISCORD_ID,
  EventRequest,
  PostgresEventRequestRepository,
} from '../../lib/repositories/postgresEventRequestRepository.js';
import { PostgresMemberRepository } from '../../lib/repositories/postgresMemberRepository.js';
import { PostgresPromotedHostRepository } from '../../lib/repositories/postgresPromotedHostRepository.js';
import { ApplicationCache } from '../../util/cache.js';
import { getRandomTip } from '../../util/tips.js';
import { dashboardOrigin } from '../dashboardDeps.js';
import { FixedWindowLimiter } from '../rateLimit.js';
import { discordRoleCheck } from '../roleGate.js';
import { SessionStore } from '../session.js';
import { timedCacheFactory } from '../timedCache.js';
import { HOST_SESSION_OPTIONS, HostSession } from './hostSession.js';

const logger = new Logger({ name: 'hostServices' });

/**
 * EVENT_REQUESTS_CHANNEL_ID, trimmed: the Discord channel website requests
 * are posted in. undefined when unset or not a channel id; either warns
 * once, by name (never the value), and website requests are then not
 * posted (everything else works). Discord requests post where the command
 * ran, whatever this says.
 */
export function requestsChannelId(
  env: Record<string, string | undefined>,
  warn: (message: string) => void = (message) => logger.warn(message),
): string | undefined {
  const value = env.EVENT_REQUESTS_CHANNEL_ID?.trim();
  if (!value) {
    warn(
      'EVENT_REQUESTS_CHANNEL_ID is not set; website requests are not posted in Discord',
    );
    return undefined;
  }
  if (!DISCORD_ID.test(value)) {
    warn(
      'EVENT_REQUESTS_CHANNEL_ID is not a Discord channel id (17-20 digits); website requests are not posted',
    );
    return undefined;
  }
  return value;
}

/**
 * postRequest into a fixed channel, for requests made on the website. The
 * send failing (bot offline, channel gone, no access) is postRequest's
 * alert; nothing is thrown.
 */
export function postRequestToChannel(
  getClient: () => Client | undefined,
  channelId: string,
  deps: RequestPostDeps,
): (request: EventRequest) => Promise<void> {
  return (request) =>
    postRequest(deps, request, {
      send: async (payload) => {
        const client = getClient();
        if (!client) {
          throw new Error('Discord client is not ready');
        }
        const channel = await client.channels.fetch(channelId);
        if (!channel?.isSendable()) {
          throw new Error('Requests channel is missing or not sendable');
        }
        const message = await channel.send(payload);
        return { id: message.id, channelId: message.channelId };
      },
    });
}

/** The post module's production deps: the request store, the organizer's hosted count, alerts. */
export function productionRequestPostDeps(
  getClient: () => Client | undefined,
): RequestPostDeps {
  return {
    store: () => PostgresEventRequestRepository.instance(),
    pastHostedCount: hostResolveDeps(getClient).pastHostedCount,
    alert: alertVia(getClient),
    origin: dashboardOrigin(),
    mirror: (request) =>
      mirrorDecision({ getClient, alert: alertVia(getClient) }, request),
  };
}

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
    // Listed and filtered, not Meetup's totalCount: the shared rule leaves
    // out cancelled events and Open Houses (countedEvents.ts).
    pastHostedCount: (meetupId) =>
      withOrganizerMeetup(getClient(), (meetup) =>
        countHostedEvents(meetup, meetupId),
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
    tierOf: async (meetupMemberId) =>
      publishTier(await resolveHost(resolveDeps, { meetupMemberId })),
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

let decisionDeps: DecisionDeps | undefined;

/** ANNOUNCE_RECREATE_CANCEL=1 lets recreate-and-announce cancel the old event on Meetup. */
export function recreateCancelEnabled(
  env: Record<string, string | undefined>,
): boolean {
  return env.ANNOUNCE_RECREATE_CANCEL?.trim() === '1';
}

/**
 * A client on the organizer credential for one write, never re-running
 * the write on a 401. Not getting the credential (Redis down, no token)
 * calls nothing: an OrganizerTokenUnavailableError.
 */
async function organizerWriter(
  getClient: () => Client | undefined,
): Promise<GqlMeetupClient> {
  let token: string | undefined;
  try {
    token = await getOrganizerAccessToken({ client: getClient() });
  } catch {
    token = undefined;
  }
  if (!token) {
    throw new OrganizerTokenUnavailableError();
  }
  return new GqlMeetupClient(token, { bypassCache: true });
}

/** The announce pre-checks' read of an event, with the organizer credential. */
function organizerEventDetails(
  getClient: () => Client | undefined,
): AnnounceDeps['eventDetails'] {
  return (meetupEventId) =>
    withOrganizerMeetup(getClient(), async (meetup) => {
      const event = await meetup.getEventForAnnounce(meetupEventId);
      if (!event) {
        return undefined;
      }
      const details: AnnounceEventDetails = {
        id: String(event.id),
        title: String(event.title ?? ''),
        eventUrl: String(event.eventUrl ?? ''),
        dateTime: String(event.dateTime),
        createdTime: event.createdTime ? String(event.createdTime) : null,
        rsvpState: event.rsvpState ? String(event.rsvpState) : null,
        rsvpsClosed:
          typeof event.rsvpSettings?.rsvpsClosed === 'boolean'
            ? event.rsvpSettings.rsvpsClosed
            : null,
        hosts: (event.eventHosts ?? []).flatMap((h) => {
          return h?.member?.id
            ? [{ id: String(h.member.id), name: String(h.member.name ?? '') }]
            : [];
        }),
      };
      return details;
    });
}

/** The production AnnounceDeps: the table, the host's own list, the organizer credential. */
function productionAnnounceDeps(
  getClient: () => Client | undefined,
  events: HostEventsDeps,
): AnnounceDeps {
  return {
    announcements: () => PostgresEventAnnouncementRepository.instance(),
    ownUpcoming: (meetupMemberId: string) =>
      hostedEvents(events, meetupMemberId, 'upcoming'),
    eventDetails: organizerEventDetails(getClient),
    announce: async (meetupEventId: string) => {
      await (
        await organizerWriter(getClient)
      ).announceEvent(
        { eventId: meetupEventId },
        { requireConfirmation: true },
      );
    },
    alert: alertVia(getClient),
    now: () => new Date(),
  };
}

/**
 * The Announce button's production deps: the announcements table, the
 * host's own upcoming events (the site's 5-minute list), announceEvent
 * with the organizer credential, and recreate-and-announce (a copy made
 * and the old event cancelled with the same credential).
 */
export function productionAnnouncer(
  getClient: () => Client | undefined,
  events: HostEventsDeps,
): AnnounceRouteDeps {
  const deps = productionAnnounceDeps(getClient, events);
  const repo = () => PostgresEventAnnouncementRepository.instance();
  const recreateDeps: RecreateDeps = {
    ownUpcoming: deps.ownUpcoming,
    // Fresh reads: the RSVP list decides whether an event may be cancelled.
    othersRsvped: (meetupEventId) =>
      withOrganizerMeetup(getClient(), async (meetup) => {
        const event = await meetup.getEventForAnnounce(meetupEventId);
        const hostIds = new Set(
          (event?.eventHosts ?? []).flatMap((h) => {
            return h?.member?.id ? [String(h.member.id)] : [];
          }),
        );
        const rsvps = await getPaginatedData(async (pagination) => {
          const result = await meetup.getEventRsvps(meetupEventId, pagination, {
            rsvpStatus: ['YES', 'WAITLIST'],
          });
          return result.event.rsvps;
        });
        return rsvps.some((r) => !hostIds.has(String(r.member?.id)));
      }),
    copySource: (meetupEventId) =>
      withOrganizerMeetup(
        getClient(),
        async (meetup) =>
          (await meetup.getEventForCopy(meetupEventId)) ?? undefined,
      ),
    organizer: () => organizerWriter(getClient),
    // Off until Hai has tried deleteEvent(removeFromCalendar: false) on a
    // throwaway event: until then the old event is left for leadership.
    cancelEvent: recreateCancelEnabled(process.env)
      ? async (meetupEventId) => {
          await (
            await organizerWriter(getClient)
          ).deleteEvent({ eventId: meetupEventId, removeFromCalendar: false });
        }
      : undefined,
    recreations: async () => {
      const store = await repo();
      return {
        claim: (oldId, by) => store.claimRecreation(oldId, by),
        fill: (oldId, newId) => store.fillRecreation(oldId, newId),
        release: (oldId, by) => store.releaseRecreation(oldId, by),
        get: (oldId) => store.recreationOf(oldId),
      };
    },
    announce: (host, event, confirmation) =>
      requestAnnouncement(deps, host, event, { confirmation }),
    alert: alertVia(getClient),
    audit: async (entry) => {
      const client = getClient();
      return client ? logActivity(client, entry) : false;
    },
    firstWithin: async (key, ttlSec) =>
      (await ApplicationCache()).exclusive_set(key, '1', ttlSec),
  };
  return {
    announce: (host, meetupEventId, options) =>
      announceHostEvent(deps, host, meetupEventId, options),
    announcements: async (ids) => (await repo()).forEvents(ids),
    cancel: async (host, meetupEventId) =>
      cancelHeldAnnouncement(
        deps,
        async (id) => (await repo()).cancelHeld(id),
        host,
        meetupEventId,
      ),
    recreatable: (host, meetupEventId) =>
      recreatable(recreateDeps, host, meetupEventId),
    recreate: (host, meetupEventId, confirmation) =>
      recreateAndAnnounce(recreateDeps, host, meetupEventId, confirmation),
  };
}

/** The announce tick's production deps (startAnnounceScheduler). */
export function productionAnnounceTickDeps(
  getClient: () => Client | undefined,
): AnnounceTickDeps {
  const events: HostEventsDeps = {
    fetchGroupEvents: async () => [],
    now: () => new Date(),
  };
  const deps = productionAnnounceDeps(getClient, events);
  return {
    cache: () => ApplicationCache(),
    announcements: () => PostgresEventAnnouncementRepository.instance(),
    eventDetails: deps.eventDetails,
    announce: deps.announce,
    alert: deps.alert,
    now: deps.now,
  };
}

/**
 * Production deps for decideRequest: the live Leadership check, the
 * activity log, the request store, the publisher and the Discord mirror.
 * Shared by the staff queue and the Discord buttons. One instance per
 * process (the first `getClient` is kept; there is one bot client), so the
 * refusal-audit limiter holds across button presses.
 */
export function productionDecisionDeps(
  getClient: () => Client | undefined,
): DecisionDeps {
  if (decisionDeps !== undefined) {
    return decisionDeps;
  }
  const alert = alertVia(getClient);
  decisionDeps = {
    now: () => new Date(),
    isLeadership: discordRoleCheck(getClient, SERVER_ROLES.leadership),
    audit: async (entry) => {
      const client = getClient();
      return client ? logActivity(client, entry) : false;
    },
    store: () => PostgresEventRequestRepository.instance(),
    publishRequest: productionPublisher(getClient),
    findExistingEvent: productionPublishDeps(getClient).findExisting,
    mirror: (request) => mirrorDecision({ getClient, alert }, request),
    refusals: new FixedWindowLimiter(1, REFUSAL_AUDIT_WINDOW_MS),
  };
  return decisionDeps;
}

/** Production deps for the Discord request command and buttons. */
export function productionDiscordRequestDeps(
  getClient: () => Client | undefined,
): DiscordRequestDeps {
  const resolveDeps = hostResolveDeps(getClient);
  const decisionDeps = productionDecisionDeps(getClient);
  const publish = productionPublisher(getClient);
  return {
    now: () => new Date(),
    meetupIdForDiscord: resolveDeps.meetupIdForDiscord,
    resolve: (who) => resolveHost(resolveDeps, who),
    store: () => PostgresEventRequestRepository.instance(),
    pastHostedCount: resolveDeps.pastHostedCount,
    publish: (id, version, actor) => publish(id, version, actor, ['pending']),
    decide: (input) => decideRequest(decisionDeps, input),
    tip: getRandomTip,
    alert: alertVia(getClient),
    origin: dashboardOrigin(),
    mirror: (request) =>
      mirrorDecision({ getClient, alert: alertVia(getClient) }, request),
  };
}
