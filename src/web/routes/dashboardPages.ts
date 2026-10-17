import express from 'express';

import { LogEntry } from '../../lib/helpers/discordLogger.js';
import { RebuildResult } from '../../lib/reports/buildJob.js';
import { Period } from '../../lib/reports/period.js';
import { PostgresIdentityRepository } from '../../lib/repositories/postgresIdentityRepository.js';
import { PostgresLinkProgressRepository } from '../../lib/repositories/postgresLinkProgressRepository.js';
import { PostgresReportSnapshotRepository } from '../../lib/repositories/postgresReportSnapshotRepository.js';
import { PostgresSuspensionRepository } from '../../lib/repositories/postgresSuspensionRepository.js';
import { AccessCheck } from '../roleGate.js';
import { SessionStore } from '../session.js';
import {
  OrganizerLoginDeps,
  registerOrganizerLoginRoutes,
} from './organizerLogin.js';
import { registerHallOfFameRoutes } from './hallOfFame.js';
import { registerIdentityRoutes } from './identity.js';
import { registerLinkProgressRoutes } from './linkProgress.js';
import { registerNoShowHistoryRoutes } from './noShowHistory.js';
import { registerRefreshRoute } from './refresh.js';
import { registerSessionRoutes } from './sessions.js';
import { registerSuspensionRoutes } from './suspensions.js';
import { registerTrendsRoutes } from './trends.js';

/** The snapshot reads the month pages use: never save. */
export type SnapshotPageReader = Pick<
  PostgresReportSnapshotRepository,
  | 'getCurrent'
  | 'getCurrentMeta'
  | 'listSummaries'
  | 'listSummarySeries'
  | 'listMemberNoShowMonths'
>;

/** The suspension reads the records and trends pages use: never insert or void. */
export type SuspensionPageReader = Pick<
  PostgresSuspensionRepository,
  'listPage' | 'countByState' | 'countByMonth'
>;

/** The link progress read (newest first, at most 1000 days): never upsert. */
export type LinkProgressPageReader = Pick<
  PostgresLinkProgressRepository,
  'listDays'
>;

/**
 * The identity reads the changes page and thumbnail route use: never record
 * or delete. countChangesSince is for the home cards (Task 11).
 */
export type IdentityPageReader = Pick<
  PostgresIdentityRepository,
  | 'listChangesPage'
  | 'getChangeThumb'
  | 'countChangesSince'
  | 'listIdentityNames'
>;

/** requestRebuild's answer, or 'unavailable' when the bot is not ready to build. */
export type PageRebuildResult =
  RebuildResult | { status: 'unavailable'; message: string };

/** What the read-only pages need. Each getter may reject (no DATABASE_URL, pool down): pages answer 503. */
export interface DashboardPageDeps {
  now: () => Date;
  /** The same cache and clock as the router's own session store. */
  sessionStore: () => Promise<SessionStore>;
  /** Live Discord check for SERVER_ROLES.leadership. Rejects when Discord cannot answer. */
  isLeadership: AccessCheck;
  /** Activity log; call sites fire and forget. */
  audit: (entry: LogEntry) => Promise<unknown>;
  /** The report snapshot store. */
  snapshots: () => Promise<SnapshotPageReader>;
  /** A staff member's refresh of one month (requestRebuild). May reject. */
  rebuild: (period: Period, requestedBy: string) => Promise<PageRebuildResult>;
  /** The suspension records store. */
  suspensions: () => Promise<SuspensionPageReader>;
  /** The identity change store (pool of 2, shared with the sweeps). */
  identity: () => Promise<IdentityPageReader>;
  /** The daily link progress counts. */
  linkProgress: () => Promise<LinkProgressPageReader>;
}

/**
 * Every read-only page. Routes go on `router` itself with router.get/post,
 * never on a sub-router: protectedRouteList (and so the access matrix test)
 * only sees routes on this router.
 */
export function registerDashboardPages(
  router: express.Router,
  deps: DashboardPageDeps,
): void {
  registerSessionRoutes(router, deps);
  registerHallOfFameRoutes(router, deps);
  registerNoShowHistoryRoutes(router, deps);
  registerRefreshRoute(router, deps);
  registerSuspensionRoutes(router, deps);
  registerIdentityRoutes(router, deps);
  registerLinkProgressRoutes(router, deps);
  registerTrendsRoutes(router, deps);
}

/** Production's whole protectedRoutes hook, so the access matrix tests exactly what ships. */
export function registerAllProtectedRoutes(
  router: express.Router,
  deps: { organizer: OrganizerLoginDeps; pages: DashboardPageDeps },
): void {
  registerOrganizerLoginRoutes(router, deps.organizer);
  registerDashboardPages(router, deps.pages);
}
