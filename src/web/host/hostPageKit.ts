import dayjs from 'dayjs';
import { Response } from 'express';
import { Logger } from 'tslog';

import { tz } from '../../util/timezone.js';
import { SafeHtml, html } from '../html.js';
import { HostNavKey, hostLayout } from './hostLayout.js';
import { hostLocals } from './hostRouter.js';

const logger = new Logger({ name: 'hostDashboard' });

export function hostPage(
  res: Response,
  page: {
    title: string;
    current?: HostNavKey;
    body: SafeHtml;
    status?: number;
    /** A staticRaw constant run after the page loads. */
    script?: SafeHtml;
  },
) {
  const { session, nonce } = hostLocals(res);
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
