import express from 'express';

import {
  OrganizerLoginDeps,
  registerOrganizerLoginRoutes,
} from './organizerLogin.js';

/** What the read-only pages need. Each getter may reject (no DATABASE_URL, pool down): pages answer 503. */
export interface DashboardPageDeps {
  now: () => Date;
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
  // Tasks 5-10 add one register…Routes(router, deps) line each.
  void router;
  void deps;
}

/** Production's whole protectedRoutes hook, so the access matrix tests exactly what ships. */
export function registerAllProtectedRoutes(
  router: express.Router,
  deps: { organizer: OrganizerLoginDeps; pages: DashboardPageDeps },
): void {
  registerOrganizerLoginRoutes(router, deps.organizer);
  registerDashboardPages(router, deps.pages);
}
