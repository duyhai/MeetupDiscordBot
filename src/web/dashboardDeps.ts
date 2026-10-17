import crypto from 'crypto';
import { Client } from 'discord.js';
import express from 'express';
import { Logger } from 'tslog';

import { BASE_DISCORD_BOT_URL, SERVER_ROLES } from '../constants.js';
import { LogEntry, logActivity } from '../lib/helpers/discordLogger.js';
import {
  BuildJobDeps,
  defaultBuildJobDeps,
  requestRebuild,
} from '../lib/reports/buildJob.js';
import { PostgresReportSnapshotRepository } from '../lib/repositories/postgresReportSnapshotRepository.js';
import { PostgresIdentityRepository } from '../lib/repositories/postgresIdentityRepository.js';
import { PostgresLinkProgressRepository } from '../lib/repositories/postgresLinkProgressRepository.js';
import { PostgresSuspensionRepository } from '../lib/repositories/postgresSuspensionRepository.js';
import { ApplicationCache } from '../util/cache.js';
import {
  baseSecurityHeaders,
  createDashboardRouter,
} from './dashboardRouter.js';
import {
  buildDashboardLoginUrl,
  exchangeDashboardCode,
  fetchDiscordIdentity,
} from './discordOAuth.js';
import { html } from './html.js';
import { organizerLoginDeps } from './organizerLoginDeps.js';
import { layout } from './pages.js';
import { discordAccessCheck, discordRoleCheck } from './roleGate.js';
import {
  DashboardPageDeps,
  registerAllProtectedRoutes,
} from './routes/dashboardPages.js';
import { SessionStore } from './session.js';
import {
  DASHBOARD_CACHE_TIMEOUT_MS,
  releaseLateBuildLease,
  timedCacheFactory,
} from './timedCache.js';

export const MIN_SESSION_SECRET_LENGTH = 32;

const logger = new Logger({ name: 'dashboard' });

/** Why the dashboard is disabled, or undefined when it is configured. Never includes the secret. */
export function dashboardDisabledReason(
  env: Record<string, string | undefined>,
): string | undefined {
  const secret = env.DASHBOARD_SESSION_SECRET;
  if (!secret) {
    return 'DASHBOARD_SESSION_SECRET is not set';
  }
  if (secret.length < MIN_SESSION_SECRET_LENGTH) {
    return `DASHBOARD_SESSION_SECRET is shorter than ${MIN_SESSION_SECRET_LENGTH} characters`;
  }
  return undefined;
}

// Express boots before Discord logs in; index.ts hands the client over on
// ready, exactly as it does for the OAuth alert client.
let discordClient: Client | undefined;

export function setDashboardClient(client: Client | undefined) {
  discordClient = client;
}

/**
 * The only Origin a dashboard POST may carry. URL#origin never has a trailing
 * slash or path, matching what browsers send; a trailing slash here would make
 * every POST fail closed.
 */
export function dashboardOrigin(baseUrl: string = BASE_DISCORD_BOT_URL) {
  return new URL(baseUrl).origin;
}

function notConfiguredRouter(): express.Router {
  const router = express.Router();
  router.use((_req, res) => {
    const nonce = crypto.randomBytes(16).toString('base64');
    res
      .status(503)
      .set(baseSecurityHeaders(nonce))
      .type('html')
      .send(
        layout({
          title: 'Not available',
          nonce,
          body: html`<div class="card">
            <p>The staff dashboard is not set up yet.</p>
          </div>`,
        }),
      );
  });
  return router;
}

/**
 * The dashboard's cache: the shared client behind a 2 s deadline, so a Redis
 * outage answers 503 instead of hanging. Only the dashboard uses this; the
 * build job, the identity sweep and the token store keep the untimed
 * ApplicationCache.
 */
const dashboardCache = timedCacheFactory(ApplicationCache);

/**
 * Manual rebuilds (the refresh route) get the same deadline, so the route
 * cannot hang. A build lease granted after its request timed out is released
 * at once through the untimed cache.
 */
export const dashboardRebuildCache = timedCacheFactory(
  ApplicationCache,
  DASHBOARD_CACHE_TIMEOUT_MS,
  releaseLateBuildLease(ApplicationCache),
);

/**
 * Build job deps for a staff member's refresh: the job's own, with the timed
 * rebuild cache for the request phase (refusal checks, cooldown and lease
 * acquire, with the late-lease release) and the untimed shared cache for the
 * detached build and its lease release, which wait for Redis as long as it
 * takes.
 */
export async function manualRebuildDeps(client: Client): Promise<BuildJobDeps> {
  return {
    ...(await defaultBuildJobDeps(client)),
    cache: dashboardRebuildCache,
    backgroundCache: ApplicationCache,
  };
}

const auditActivity = async (entry: LogEntry) => {
  if (!discordClient) {
    return false;
  }
  return logActivity(discordClient, entry);
};

/** Production page deps. Later tasks add one field each, wired to the repositories' instance(). */
export function dashboardPageDeps(): DashboardPageDeps {
  return {
    now: () => new Date(),
    // The router's cache and clock (Date.now), so a revocation here is the
    // one the gate reads.
    sessionStore: async () => new SessionStore(await dashboardCache()),
    isLeadership: discordRoleCheck(
      () => discordClient,
      SERVER_ROLES.leadership,
    ),
    audit: auditActivity,
    snapshots: () => PostgresReportSnapshotRepository.instance(),
    // The refresh route: the timed request phase, the late-lease release and
    // the untimed background build (manualRebuildDeps). A CacheTimeoutError
    // from here is the route's 503.
    rebuild: async (period, requestedBy) => {
      if (!discordClient) {
        return { status: 'unavailable', message: 'The bot is still starting.' };
      }
      return requestRebuild(
        await manualRebuildDeps(discordClient),
        period,
        requestedBy,
      );
    },
    suspensions: () => PostgresSuspensionRepository.instance(),
    identity: () => PostgresIdentityRepository.instance(),
    linkProgress: () => PostgresLinkProgressRepository.instance(),
  };
}

export function dashboardRouterFromEnv(
  env: Record<string, string | undefined> = process.env,
): express.Router {
  const reason = dashboardDisabledReason(env);
  const secret = env.DASHBOARD_SESSION_SECRET;
  if (reason || !secret) {
    logger.warn(`Staff dashboard disabled: ${reason}`);
    return notConfiguredRouter();
  }
  const organizerDeps = organizerLoginDeps(() => discordClient);
  return createDashboardRouter({
    cache: dashboardCache,
    checkAccess: discordAccessCheck(() => discordClient),
    oauth: {
      buildLoginUrl: buildDashboardLoginUrl,
      exchangeCode: exchangeDashboardCode,
      fetchIdentity: fetchDiscordIdentity,
    },
    sessionSecret: secret,
    origin: dashboardOrigin(),
    requireHttps: dashboardOrigin().startsWith('https://'),
    audit: auditActivity,
    // Mounted by the router behind the session gate and the unsafe-method
    // (CSRF / Origin / rate-limit) guard.
    protectedRoutes: (router) =>
      registerAllProtectedRoutes(router, {
        organizer: organizerDeps,
        pages: dashboardPageDeps(),
      }),
    homeStatus: organizerDeps.credentialStatus,
  });
}
