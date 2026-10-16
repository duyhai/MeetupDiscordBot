import express from 'express';

import { LogEntry } from '../../lib/helpers/discordLogger.js';
import { AccessCheck } from '../roleGate.js';
import { SessionStore } from '../session.js';
import {
  OrganizerLoginDeps,
  registerOrganizerLoginRoutes,
} from './organizerLogin.js';
import { registerSessionRoutes } from './sessions.js';

/** What the read-only pages need. Each getter may reject (no DATABASE_URL, pool down): pages answer 503. */
export interface DashboardPageDeps {
  now: () => Date;
  /** The same cache and clock as the router's own session store. */
  sessionStore: () => Promise<SessionStore>;
  /** Live Discord check for SERVER_ROLES.leadership. Rejects when Discord cannot answer. */
  isLeadership: AccessCheck;
  /** Activity log; call sites fire and forget. */
  audit: (entry: LogEntry) => Promise<unknown>;
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
  // Tasks 5-10 add one register…Routes(router, deps) line each.
}

/** Production's whole protectedRoutes hook, so the access matrix tests exactly what ships. */
export function registerAllProtectedRoutes(
  router: express.Router,
  deps: { organizer: OrganizerLoginDeps; pages: DashboardPageDeps },
): void {
  registerOrganizerLoginRoutes(router, deps.organizer);
  registerDashboardPages(router, deps.pages);
}
