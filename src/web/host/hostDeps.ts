import crypto from 'crypto';
import { Client } from 'discord.js';
import express from 'express';
import { Logger } from 'tslog';

import { exchangeMeetupCode } from '../../lib/client/oauth/providers.js';
import { resolveHost } from '../../lib/hosts/eligibility.js';
import { organizerGroupEvents } from '../../lib/hosts/hostEvents.js';
import { LogEntry, logActivity } from '../../lib/helpers/discordLogger.js';
import { withOrganizerMeetup } from '../../lib/reports/organizerMeetup.js';
import { PostgresEventRequestRepository } from '../../lib/repositories/postgresEventRequestRepository.js';
import { getRandomTip } from '../../util/tips.js';
import Configuration from '../../configuration.js';
import { GqlMeetupClient } from '../../lib/client/meetup/gqlClient.js';
import { wrappedBuildLimiter } from '../../lib/wrapped/cache.js';
import {
  forgetMeetupTokens,
  getUsableMeetupTokens,
  moveMeetupTokens,
  storeMeetupTokens,
} from '../../lib/helpers/meetupTokens.js';
import { ApplicationCache } from '../../util/cache.js';
import { ApplicationMemberRepository } from '../../util/memberRepository.js';
import { baseSecurityHeaders } from '../dashboardRouter.js';
import { dashboardDisabledReason, dashboardOrigin } from '../dashboardDeps.js';
import {
  buildDashboardLoginUrl,
  exchangeDashboardCode,
  fetchDiscordIdentity,
  hostRedirectUri,
} from '../discordOAuth.js';
import { html } from '../html.js';
import { timedCacheFactory } from '../timedCache.js';
import { hostLayout } from './hostLayout.js';
import { registerHostPages } from './hostPages.js';
import { createHostRouter } from './hostRouter.js';
import { registerCreatePages } from './createPage.js';
import { registerWrappedPage } from './wrappedPage.js';
import {
  discordUsername,
  displayName,
  ensureServerMember,
  isServerMember,
} from './serverJoin.js';
import {
  alertVia,
  hostResolveDeps,
  postRequestToChannel,
  productionAnnouncer,
  productionPublisher,
  productionRequestPostDeps,
  requestsChannelId,
  verifyRunner,
} from './hostServices.js';
import { buildHostMeetupAuthUrl, fetchMeetupSelf } from './meetupSignIn.js';

const logger = new Logger({ name: 'hostDashboard' });

// Express boots before Discord logs in; index.ts hands the client over on
// ready, as for the staff dashboard.
let discordClient: Client | undefined;

export function setHostClient(client: Client | undefined) {
  discordClient = client;
}

/** The shared cache behind the dashboard's 2 s deadline (sessions only). */
const hostCache = timedCacheFactory(ApplicationCache);

const auditActivity = async (entry: LogEntry) => {
  if (!discordClient) {
    return false;
  }
  return logActivity(discordClient, entry);
};

function notConfiguredRouter(): express.Router {
  const router = express.Router();
  router.use((_req, res) => {
    const nonce = crypto.randomBytes(16).toString('base64');
    res
      .status(503)
      .set(baseSecurityHeaders(nonce))
      .type('html')
      .send(
        hostLayout({
          title: 'Not available',
          nonce,
          body: html`<div class="card">
            <h1>Not available</h1>
            <p>The host dashboard is not set up yet.</p>
          </div>`,
        }),
      );
  });
  return router;
}

/** Shares DASHBOARD_SESSION_SECRET with the staff dashboard (separate MAC domains). */
export function hostRouterFromEnv(
  env: Record<string, string | undefined> = process.env,
): express.Router {
  const reason = dashboardDisabledReason(env);
  const secret = env.DASHBOARD_SESSION_SECRET;
  if (reason || !secret) {
    logger.warn(`Host dashboard disabled: ${reason}`);
    return notConfiguredRouter();
  }
  const resolveDeps = hostResolveDeps(() => discordClient);
  const publish = productionPublisher(() => discordClient);
  const channelId = requestsChannelId(env);
  const postToDiscord =
    channelId === undefined
      ? undefined
      : postRequestToChannel(
          () => discordClient,
          channelId,
          productionRequestPostDeps(() => discordClient),
        );
  const events = {
    fetchGroupEvents: organizerGroupEvents(() => discordClient),
    now: () => new Date(),
  };
  return createHostRouter({
    cache: hostCache,
    resolve: (who) => resolveHost(resolveDeps, who),
    discord: {
      buildLoginUrl: (state, verifier) =>
        buildDashboardLoginUrl(state, verifier, hostRedirectUri()),
      exchangeCode: (code, verifier) =>
        exchangeDashboardCode(code, verifier, hostRedirectUri()),
      fetchIdentity: fetchDiscordIdentity,
    },
    meetup: {
      buildAuthUrl: buildHostMeetupAuthUrl,
      exchangeCode: exchangeMeetupCode,
      fetchSelf: fetchMeetupSelf,
    },
    sessionSecret: secret,
    origin: dashboardOrigin(),
    requireHttps: dashboardOrigin().startsWith('https://'),
    audit: auditActivity,
    alert: alertVia(() => discordClient),
    // The same store Verify writes and resolveHost reads.
    members: () => ApplicationMemberRepository(),
    discordVerifyUrl: (state, verifier) =>
      buildDashboardLoginUrl(state, verifier, hostRedirectUri(), [
        'identify',
        'guilds.join',
      ]),
    joinServer: async (discordUserId, accessToken) => {
      const { joined, pending } = await ensureServerMember(
        () => discordClient,
        discordUserId,
        accessToken,
      );
      return { joined, pending };
    },
    runVerify: verifyRunner(() => discordClient),
    isServerMember: (discordUserId) =>
      isServerMember(() => discordClient, discordUserId),
    discordUsername: (discordUserId) =>
      discordUsername(() => discordClient, discordUserId),
    // The bot's member token store: the same keys, TTL and refresh.
    meetupTokens: {
      keep: async (owner, tokens) =>
        storeMeetupTokens(await ApplicationCache(), owner, tokens),
      usable: async (owner) =>
        getUsableMeetupTokens(await ApplicationCache(), owner),
      move: async (from, to) =>
        moveMeetupTokens(await ApplicationCache(), from, to),
      forget: async (owner) =>
        forgetMeetupTokens(await ApplicationCache(), owner),
    },
    pages: (router) => {
      registerHostPages(router, {
        events,
        requests: () => PostgresEventRequestRepository.instance(),
        announce: productionAnnouncer(() => discordClient, events),
      });
      registerCreatePages(
        router,
        {
          now: () => new Date(),
          requests: () => PostgresEventRequestRepository.instance(),
          copySource: async (eventId) =>
            (await withOrganizerMeetup(discordClient, (meetup) =>
              meetup.getEventForCopy(eventId),
            )) ?? undefined,
          publish: (id, version, actor) =>
            publish(id, version, actor, ['pending']),
          alert: alertVia(() => discordClient),
          tip: getRandomTip,
          ...(postToDiscord === undefined ? {} : { postToDiscord }),
        },
        dashboardOrigin(),
      );
      // The Discord command's cache, slot and lease; the member's own token
      // from the bot's store; the organizer credential as the RSVP fallback.
      registerWrappedPage(router, {
        cache: ApplicationCache,
        memberToken: async (discordUserId) =>
          (await getUsableMeetupTokens(await ApplicationCache(), discordUserId))
            ?.accessToken,
        meetupClient: (accessToken) => new GqlMeetupClient(accessToken),
        organizerRsvps: (meetupId) =>
          withOrganizerMeetup(discordClient, (organizer) =>
            organizer.getMemberRsvpEvents(
              meetupId,
              Configuration.meetup.groupId,
              { rsvpStatus: ['YES', 'ATTENDED'], eventStatus: ['PAST'] },
            ),
          ),
        findByMeetupId: async (meetupId) =>
          (await ApplicationMemberRepository()).findByMeetupId(meetupId),
        isPresent: (discordUserId) =>
          isServerMember(() => discordClient, discordUserId),
        displayName: (discordUserId) =>
          displayName(() => discordClient, discordUserId),
        limiter: wrappedBuildLimiter,
        alert: alertVia(() => discordClient),
        groupId: Configuration.meetup.groupId,
      });
    },
  });
}
