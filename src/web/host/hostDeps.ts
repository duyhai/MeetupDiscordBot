import crypto from 'crypto';
import { Client } from 'discord.js';
import express from 'express';
import { Logger } from 'tslog';

import { SERVER_ROLES } from '../../constants.js';
import { exchangeMeetupCode } from '../../lib/client/oauth/providers.js';
import { HostResolveDeps, resolveHost } from '../../lib/hosts/eligibility.js';
import { organizerGroupEvents } from '../../lib/hosts/hostEvents.js';
import { LogEntry, logActivity } from '../../lib/helpers/discordLogger.js';
import { withOrganizerMeetup } from '../../lib/reports/organizerMeetup.js';
import { PostgresMemberRepository } from '../../lib/repositories/postgresMemberRepository.js';
import { PostgresPromotedHostRepository } from '../../lib/repositories/postgresPromotedHostRepository.js';
import { ApplicationCache } from '../../util/cache.js';
import { baseSecurityHeaders } from '../dashboardRouter.js';
import { dashboardDisabledReason, dashboardOrigin } from '../dashboardDeps.js';
import {
  buildDashboardLoginUrl,
  exchangeDashboardCode,
  fetchDiscordIdentity,
  hostRedirectUri,
} from '../discordOAuth.js';
import { html } from '../html.js';
import { discordRoleCheck } from '../roleGate.js';
import { timedCacheFactory } from '../timedCache.js';
import { hostLayout } from './hostLayout.js';
import { registerHostPages } from './hostPages.js';
import { createHostRouter } from './hostRouter.js';
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

/** Production lookups for resolveHost. Each throws when its source is down. */
export function hostResolveDeps(
  getClient: () => Client | undefined = () => discordClient,
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
  const resolveDeps = hostResolveDeps();
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
      exchangeCode: async (code) =>
        (await exchangeMeetupCode(code)).accessToken,
      fetchSelf: fetchMeetupSelf,
    },
    sessionSecret: secret,
    origin: dashboardOrigin(),
    requireHttps: dashboardOrigin().startsWith('https://'),
    audit: auditActivity,
    pages: (router) => registerHostPages(router, { events }),
  });
}
