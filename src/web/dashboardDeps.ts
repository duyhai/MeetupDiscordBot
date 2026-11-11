import crypto from 'crypto';
import { Client } from 'discord.js';
import express from 'express';
import { Logger } from 'tslog';

import { BASE_DISCORD_BOT_URL, SERVER_ROLES } from '../constants.js';
import {
  LogEntry,
  logActivity,
  logModeration,
} from '../lib/helpers/discordLogger.js';
import {
  BuildJobDeps,
  defaultBuildJobDeps,
  requestRebuild,
} from '../lib/reports/buildJob.js';
import { PostgresReportSnapshotRepository } from '../lib/repositories/postgresReportSnapshotRepository.js';
import { PostgresIdentityRepository } from '../lib/repositories/postgresIdentityRepository.js';
import { PostgresLinkProgressRepository } from '../lib/repositories/postgresLinkProgressRepository.js';
import { PostgresMemberRepository } from '../lib/repositories/postgresMemberRepository.js';
import { PostgresNoShowWorkspaceRepository } from '../lib/repositories/postgresNoShowWorkspaceRepository.js';
import { PostgresBanRepository } from '../lib/repositories/postgresBanRepository.js';
import {
  BanServiceDeps,
  importBans,
  liftBan,
  recordBan,
  uploadBanPhoto,
} from '../lib/bans/service.js';
import { PostgresSuspensionRepository } from '../lib/repositories/postgresSuspensionRepository.js';
import { PostgresPromotedHostRepository } from '../lib/repositories/postgresPromotedHostRepository.js';
import { PostgresEventAuditRepository } from '../lib/repositories/postgresEventAuditRepository.js';
import {
  defaultEventAuditDeps,
  requestEventAudit,
} from '../lib/eventAudit/job.js';
import { hostedEvents, organizerGroupEvents } from '../lib/hosts/hostEvents.js';
import {
  promotionCandidates,
  singleFlight,
} from '../lib/hosts/promotionCandidates.js';
import { withOrganizerMeetup } from '../lib/reports/organizerMeetup.js';
import { PostgresEventRequestRepository } from '../lib/repositories/postgresEventRequestRepository.js';
import {
  performWorkspaceAction,
  syncWorkspace,
} from '../lib/workspace/service.js';
import {
  createUpcomingLoader,
  organizerFetchMany,
} from '../lib/workspace/upcoming.js';
import { ApplicationCache } from '../util/cache.js';
import { PostgresWrappedAnnouncementRepository } from '../lib/repositories/postgresWrappedAnnouncementRepository.js';
import { PostgresWrappedBackfillRepository } from '../lib/repositories/postgresWrappedBackfillRepository.js';
import { RUN_NOW_KEY, RUN_NOW_TTL_SEC } from '../lib/wrapped/backfill.js';
import { nextTickAt } from '../lib/wrapped/queue.js';
import {
  announceYear,
  loadWrappedAnnounceConfig,
  productionWrappedAnnounceDeps,
  runWrappedAnnounce,
} from '../lib/wrapped/announce.js';
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
import { mirrorDecision } from '../lib/hosts/requestPost.js';
import {
  alertVia,
  productionPublishDeps,
  productionPublisher,
  revokeHostSessions,
} from './host/hostServices.js';
import { organizerLoginDeps } from './organizerLoginDeps.js';
import { layout } from './pages.js';
import { discordAccessCheck, discordRoleCheck } from './roleGate.js';
import {
  BanActions,
  DashboardPageDeps,
  registerAllProtectedRoutes,
} from './routes/dashboardPages.js';
import { renderHomeReports } from './routes/home.js';
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
            <h1>Not available</h1>
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

/**
 * Live upcoming RSVPs for the workspace cards. Created once, so its
 * single-flight map is shared by every request; cached (derived fields only,
 * 6 h) in the dashboard's timed cache.
 */
const upcomingLoader = createUpcomingLoader({
  now: () => new Date(),
  cache: dashboardCache,
  fetchMany: organizerFetchMany(() => discordClient),
});

const auditActivity = async (entry: LogEntry) => {
  if (!discordClient) {
    return false;
  }
  return logActivity(discordClient, entry);
};

/** The moderation log for workspace actions and refusals: embed only, no pings. */
const workspaceModerationLog = async (entry: LogEntry) => {
  if (!discordClient) {
    return false;
  }
  return logModeration(discordClient, entry);
};

/**
 * The ban service bound to its production deps. moderationLog is
 * logModeration: an embed only, allowedMentions { parse: [] }, no content.
 */
function banActions(
  isLeadership: (id: string) => Promise<boolean>,
): BanActions {
  const deps: BanServiceDeps = {
    now: () => new Date(),
    repository: () => PostgresBanRepository.instance(),
    moderationLog: workspaceModerationLog,
    isLeadership,
  };
  return {
    record: (input) => recordBan(deps, input),
    import: (input) => importBans(deps, input),
    lift: (input) => liftBan(deps, input),
    uploadPhoto: (input) => uploadBanPhoto(deps, input),
  };
}

/** The candidates are kept 30 minutes: a cold read is a year of events plus a count per host. */
const CANDIDATES_TTL_MS = 30 * 60 * 1000;
/** A hung Meetup read gives up after this, so the next load starts afresh. */
const CANDIDATES_READ_TIMEOUT_MS = 2 * 60 * 1000;

/** The promotion pages' organizer reads, shared by every request. */
function promotionReads(getClient: () => Client | undefined) {
  const fetchGroupEvents = organizerGroupEvents(getClient);
  const now = () => new Date();
  const isOrganizerRole = discordRoleCheck(getClient, SERVER_ROLES.organizer);
  return {
    promotionCandidates: singleFlight(
      () =>
        promotionCandidates(
          {
            fetchGroupEvents,
            now,
            pastHostedEvents: (meetupId) =>
              hostedEvents({ fetchGroupEvents, now }, meetupId, 'past'),
            memberships: (meetupIds) =>
              withOrganizerMeetup(getClient(), (meetup) =>
                meetup.getGroupMembershipsByIds(meetupIds),
              ),
            // The Organizer Discord role, through the identity link; an
            // unlinked member is judged by Meetup's LEADER status alone.
            isOrganizer: async (meetupId) => {
              const linked = await (
                await PostgresMemberRepository.instance()
              ).findByMeetupId(meetupId);
              return linked?.discordUserId
                ? isOrganizerRole(linked.discordUserId)
                : false;
            },
          },
          new Set(),
        ),
      CANDIDATES_TTL_MS,
      {
        // A list missing some hosts is shown, not kept: the next load asks
        // Meetup again.
        keep: (list) => list.uncounted === 0,
        timeoutMs: CANDIDATES_READ_TIMEOUT_MS,
      },
    ),
    hostPastEvents: (meetupId: string) =>
      hostedEvents({ fetchGroupEvents, now }, meetupId, 'past'),
  };
}

/** Production page deps, each read wired to its repository's instance(). */
export function dashboardPageDeps(): DashboardPageDeps {
  const isLeadership = discordRoleCheck(
    () => discordClient,
    SERVER_ROLES.leadership,
  );
  return {
    now: () => new Date(),
    // The router's cache and clock (Date.now), so a revocation here is the
    // one the gate reads.
    sessionStore: async () => new SessionStore(await dashboardCache()),
    isLeadership,
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
    bans: () => PostgresBanRepository.instance(),
    identity: () => PostgresIdentityRepository.instance(),
    linkProgress: () => PostgresLinkProgressRepository.instance(),
    memberLinks: () => PostgresMemberRepository.instance(),
    workspace: () => PostgresNoShowWorkspaceRepository.instance(),
    workspaceActions: {
      perform: (input) =>
        performWorkspaceAction(
          {
            now: () => new Date(),
            repository: () => PostgresNoShowWorkspaceRepository.instance(),
            moderationLog: workspaceModerationLog,
            isLeadership,
          },
          input,
        ),
      sync: (period) =>
        syncWorkspace(
          {
            now: () => new Date(),
            repository: () => PostgresNoShowWorkspaceRepository.instance(),
            snapshots: () => PostgresReportSnapshotRepository.instance(),
          },
          period,
        ),
      moderationLog: workspaceModerationLog,
    },
    banActions: banActions(isLeadership),
    upcoming: upcomingLoader,
    eventRequests: () => PostgresEventRequestRepository.instance(),
    publishRequest: productionPublisher(() => discordClient),
    findExistingEvent: productionPublishDeps(() => discordClient).findExisting,
    promotedHosts: () => PostgresPromotedHostRepository.instance(),
    ...promotionReads(() => discordClient),
    revokeHostSessions,
    hostAlert: alertVia(() => discordClient),
    eventAudit: () => PostgresEventAuditRepository.instance(),
    // Snapshot now: the job's deps with the timed rebuild cache for the
    // request phase (a late lease is released by its hook), as the refresh
    // route does. A CacheTimeoutError from here is the route's 503.
    snapshotNow: async (requestedBy) => {
      if (!discordClient) {
        return { status: 'unavailable' };
      }
      return requestEventAudit(
        {
          ...(await defaultEventAuditDeps(discordClient)),
          cache: dashboardRebuildCache,
        },
        requestedBy,
      );
    },
    mirrorRequest: (request) =>
      mirrorDecision(
        {
          getClient: () => discordClient,
          alert: alertVia(() => discordClient),
        },
        request,
      ),
    wrappedBackfill: {
      status: async () => {
        const store = await PostgresWrappedBackfillRepository.instance();
        const cache = await ApplicationCache();
        const now = new Date();
        const [lastRun, openRun, queueLength] = await Promise.all([
          store.lastFinishedRun(),
          store.openRun(),
          store.queueLength(),
        ]);
        return {
          lastRun,
          openRun,
          queueLength,
          nextTickAt: await nextTickAt(cache, now),
        };
      },
      // The flag the next tick honours (backfill.ts); a run already open
      // needs no flag, and a second press is told the first one stands.
      runNow: async (requestedBy) => {
        const store = await PostgresWrappedBackfillRepository.instance();
        if (await store.openRun()) {
          return 'already-running';
        }
        const cache = await ApplicationCache();
        return (await cache.exclusive_set(
          RUN_NOW_KEY,
          requestedBy,
          RUN_NOW_TTL_SEC,
        ))
          ? 'requested'
          : 'already-requested';
      },
    },
    wrappedAnnounce: {
      config: () => loadWrappedAnnounceConfig(),
      status: async () => {
        const { date } = loadWrappedAnnounceConfig();
        return date === undefined
          ? undefined
          : (await PostgresWrappedAnnouncementRepository.instance()).get(
              announceYear({ date }),
            );
      },
      // The job's own deps and claim: Post now can never post twice.
      postNow: () =>
        runWrappedAnnounce(
          productionWrappedAnnounceDeps(() => discordClient),
          {
            force: true,
          },
        ),
    },
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
  const pageDeps = dashboardPageDeps();
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
        pages: pageDeps,
      }),
    homeStatus: organizerDeps.credentialStatus,
    homeReports: (view) => renderHomeReports(pageDeps, view),
  });
}
