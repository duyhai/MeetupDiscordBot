import express from 'express';

import { LogEntry } from '../../lib/helpers/discordLogger.js';
import { RebuildResult } from '../../lib/reports/buildJob.js';
import { Period } from '../../lib/reports/period.js';
import { PostgresIdentityRepository } from '../../lib/repositories/postgresIdentityRepository.js';
import { PostgresLinkProgressRepository } from '../../lib/repositories/postgresLinkProgressRepository.js';
import { PostgresMemberRepository } from '../../lib/repositories/postgresMemberRepository.js';
import { PostgresNoShowWorkspaceRepository } from '../../lib/repositories/postgresNoShowWorkspaceRepository.js';
import { PostgresReportSnapshotRepository } from '../../lib/repositories/postgresReportSnapshotRepository.js';
import { PostgresSuspensionRepository } from '../../lib/repositories/postgresSuspensionRepository.js';
import {
  WorkspaceActionInput,
  WorkspaceActionResult,
  WorkspaceSyncCode,
} from '../../lib/workspace/service.js';
import { UpcomingEntry } from '../../lib/workspace/upcoming.js';
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
import { registerWorkspaceRoutes } from './workspace.js';
import { registerWorkspaceActionRoutes } from './workspaceActions.js';

/** The snapshot reads the month pages use: never save. */
export type SnapshotPageReader = Pick<
  PostgresReportSnapshotRepository,
  | 'getCurrent'
  | 'getCurrentMeta'
  | 'listSummaries'
  | 'listSummarySeries'
  | 'listMemberNoShowMonths'
>;

/**
 * The suspension reads the records, trends and workspace pages use: never
 * insert or void. listByMemberIds is live records only; listByIds includes
 * voided ones (a linked record's live state).
 */
export type SuspensionPageReader = Pick<
  PostgresSuspensionRepository,
  'listPage' | 'countByState' | 'countByMonth' | 'listByMemberIds' | 'listByIds'
>;

/** The link progress read (newest first, at most 1000 days): never upsert. */
export type LinkProgressPageReader = Pick<
  PostgresLinkProgressRepository,
  'listDays'
>;

/** The Discord link lookup the Hall of Fame mention text uses: never upsert or remove. */
export type MemberLinkPageReader = Pick<
  PostgresMemberRepository,
  'discordIdsByMeetupIds'
>;

/**
 * The identity reads the changes page and thumbnail route use: never record
 * or delete. countChangesSince is for the home page's report cards.
 */
export type IdentityPageReader = Pick<
  PostgresIdentityRepository,
  | 'listChangesPage'
  | 'getChangeThumb'
  | 'countChangesSince'
  | 'listIdentityNames'
>;

/** The workspace reads the workspace, home and no-show history pages use: never sync or act. */
export type WorkspacePageReader = Pick<
  PostgresNoShowWorkspaceRepository,
  | 'monthState'
  | 'listMonths'
  | 'listRows'
  | 'countRows'
  | 'getRow'
  | 'listRecentEvents'
  | 'statusCounts'
  | 'statusesByMember'
  | 'statusesForMember'
>;

/** The workspace's state changes (the service). Each may reject; the routes answer 'error'. */
export interface WorkspaceActions {
  /** performWorkspaceAction. The route runs the live Leadership check and passes leadershipConfirmed. */
  perform(input: WorkspaceActionInput): Promise<WorkspaceActionResult>;
  /** syncWorkspace. */
  sync(period: Period): Promise<WorkspaceSyncCode>;
  /** The moderation log (embed only, no pings); call sites fire and forget. */
  moderationLog(entry: LogEntry): Promise<unknown>;
}

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
  /** Meetup id -> Discord id links, for the Hall of Fame mention text. */
  memberLinks: () => Promise<MemberLinkPageReader>;
  /** The no-show workspace store (dashboard pool). */
  workspace: () => Promise<WorkspacePageReader>;
  /** The workspace's actions and sync. */
  workspaceActions: WorkspaceActions;
  /** Live upcoming RSVPs for the workspace's suspension cards (createUpcomingLoader). Never rejects. */
  upcoming: (memberIds: string[]) => Promise<Map<string, UpcomingEntry>>;
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
  registerWorkspaceRoutes(router, deps);
  registerWorkspaceActionRoutes(router, deps);
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
