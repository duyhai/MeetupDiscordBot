import dayjs from 'dayjs';
import { Response } from 'express';
import { Logger } from 'tslog';

import { tz } from '../../util/timezone.js';
import { baseSecurityHeaders } from '../dashboardRouter.js';
import { SafeHtml, SafeUrl, html } from '../html.js';
import { HostNavKey, hostLayout } from './hostLayout.js';
import { HOST_CSP_OPTIONS, hostLocals } from './hostRouter.js';

const logger = new Logger({ name: 'hostDashboard' });

/** OpenStreetMap's tile server (tile usage policy: attribution, a Referer, light use). */
export const MAP_TILE_HOST = 'tile.openstreetmap.org';

/**
 * The host site's CSP (HOST_CSP_OPTIONS) with one addition, for map pages
 * only: tile images from MAP_TILE_HOST. Scripts and styles stay nonce-only
 * (the map library is served from our own origin under the nonce).
 */
export function mapContentSecurityPolicy(nonce: string): string {
  return baseSecurityHeaders(nonce, {
    ...HOST_CSP_OPTIONS,
    imgHosts: [...(HOST_CSP_OPTIONS.imgHosts ?? []), MAP_TILE_HOST],
  })['Content-Security-Policy'];
}

export function hostPage(
  res: Response,
  page: {
    title: string;
    current?: HostNavKey;
    body: SafeHtml;
    status?: number;
    /** staticRaw constants run after the page loads, each its own script. */
    script?: SafeHtml | readonly SafeHtml[];
    /** Our own files (the map library), loaded before `script`. */
    assets?: { stylesheets: SafeUrl[]; scripts: SafeUrl[] };
    /** Lets the page load OpenStreetMap tiles (MAP_TILE_HOST) as images. */
    mapTiles?: boolean;
  },
) {
  const { session, nonce } = hostLocals(res);
  if (page.mapTiles) {
    res.set('Content-Security-Policy', mapContentSecurityPolicy(nonce));
  }
  res
    .status(page.status ?? 200)
    .type('html')
    .send(
      hostLayout({
        title: page.title,
        nonce,
        user: session,
        current: page.current,
        body: page.body,
        script: page.script,
        assets: page.assets,
      }),
    );
}

/** A Meetup outage: never a partial page. */
export function unavailable(res: Response, error: unknown) {
  logger.warn(
    `Host page Meetup read failed: ${error instanceof Error ? error.name : 'Error'}`,
  );
  hostPage(res, {
    title: 'Unavailable',
    status: 503,
    body: html`<div class="card">
      <h1>Unavailable</h1>
      <p>
        Events cannot be loaded from Meetup right now. Please try again in a few
        minutes.
      </p>
    </div>`,
  });
}

export const dayLabel = (day: string) => dayjs(day).format('ddd, MMM D');
export const timeLabel = (dateTime: string) =>
  tz(dayjs(dateTime)).format('h:mm A');
export const dateLabel = (dateTime: string) =>
  tz(dayjs(dateTime)).format('ddd, MMM D, YYYY');
