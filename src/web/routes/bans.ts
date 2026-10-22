import express, { RequestHandler } from 'express';

import { DASHBOARD_PATHS } from '../../lib/reports/dashboardPaths.js';
import { sniffImageType } from '../images.js';
import { load, notFound, parseRowId } from '../pageKit.js';
import type { DashboardPageDeps } from './dashboardPages.js';

/**
 * The ban routes. Routes go on `router` itself (protectedRouteList and the
 * access matrix only see those).
 */
export function registerBanRoutes(
  router: express.Router,
  deps: Pick<DashboardPageDeps, 'now' | 'bans'>,
): void {
  // One photo per request, by ban id only. The type comes from the bytes;
  // anything that is not PNG, JPEG or WebP is the 404 page, never the bytes.
  router.get(DASHBOARD_PATHS.banPhoto, (async (req, res) => {
    const id = parseRowId(req.params.id);
    if (id === undefined) {
      notFound(res);
      return;
    }
    // An abandoned request (a lazy image scrolled past, a closed tab): do
    // not queue it on the dashboard pool.
    if (req.socket?.destroyed) {
      return;
    }
    const loaded = await load(res, 'The photo', async () =>
      (await deps.bans()).getPhoto(id),
    );
    if (!loaded.ok) {
      return;
    }
    const bytes = loaded.value;
    const type = Buffer.isBuffer(bytes) ? sniffImageType(bytes) : undefined;
    if (!Buffer.isBuffer(bytes) || type === undefined) {
      notFound(res);
      return;
    }
    // As the identity thumb route: no-store and nosniff also come from
    // baseSecurityHeaders, restated so this route cannot lose them;
    // setHeader so Express adds no charset.
    res.statusCode = 200;
    res.setHeader('Content-Type', type);
    res.setHeader('Content-Length', String(bytes.length));
    res.setHeader('Content-Disposition', 'inline');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    res.end(bytes);
  }) as RequestHandler);
}
