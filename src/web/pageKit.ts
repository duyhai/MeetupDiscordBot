import dayjs from 'dayjs';
import { Response } from 'express';
import { Logger } from 'tslog';

import {
  MonthPathTemplate,
  linkableMonthPath,
} from '../lib/reports/dashboardPaths.js';
import { noShowsMissing } from '../lib/reports/meetupMonth.js';
import {
  GROUP_FIRST_PERIOD,
  Period,
  comparePeriods,
  isFinished,
  monthLabel,
  parsePeriodKey,
  periodOf,
} from '../lib/reports/period.js';
import { AttendanceEvidence } from '../lib/reports/types.js';
import { isWorkspaceMonth } from '../lib/workspace/months.js';
import { tz } from '../util/timezone.js';
import { dashboardLocals } from './dashboardRouter.js';
import { SafeHtml, html, localUrl, staticRaw } from './html.js';
import { discordProfileUrl, discordUserLink } from './links.js';
import { errorPage, layout, navKeyFor } from './pages.js';
import { KIT_SCRIPT } from './ui/script.js';

const logger = new Logger({ name: 'dashboard' });

/**
 * Fixed text for the ban photo forms (Task 6). In each form[data-ban-photo],
 * found by position: hides the no-JavaScript note and shows the picker;
 * decodes the picked file with createImageBitmap (orientation applied;
 * older WebKit refuses that option, so a failure retries once without it),
 * draws it on the form's canvas at most 512 px on a side (never enlarged;
 * the canvas is the preview, no blob: URL), and encodes WebP at 0.8, 0.7,
 * 0.6, then 0.5. A browser that returns another type for WebP (Safari gives
 * PNG) is re-encoded as JPEG with the same steps (D2); a JPEG request that
 * still gives another type is a fixed message. The first blob of at
 * most 153600 bytes goes into the hidden photo field as base64url (D3) and
 * enables the button; none fits, or any failure, is a fixed message, an
 * empty field and a disabled button, and a submit then is cancelled. A
 * second pick restarts and outdated callbacks are ignored. The file input
 * has no name, so the original file is never sent. Uses no fetch, worker,
 * blob: or data: URL, so the CSP is unchanged.
 */
// eslint-disable-next-line @stylistic/max-len -- one line, so the script text is exactly what runs
export const BAN_PHOTO_SCRIPT = staticRaw`document.querySelectorAll('form[data-ban-photo]').forEach(function(f){var note=f.querySelector('[data-ban-photo-nojs]'),label=f.querySelector('label'),input=f.querySelector('input[type=file]'),field=f.querySelector('input[name=photo]'),canvas=f.querySelector('canvas'),status=f.querySelector('[data-ban-photo-status]'),button=f.querySelector('button[type=submit]');if(!note||!label||!input||!field||!canvas||!status||!button){return;}note.hidden=true;if(typeof createImageBitmap!=='function'||typeof HTMLCanvasElement==='undefined'||!HTMLCanvasElement.prototype.toBlob){status.textContent='This browser cannot prepare the photo. Use a current Chrome, Edge, Firefox or Safari.';return;}label.hidden=false;var run=0,steps=[0.8,0.7,0.6,0.5];function fail(mine,t){if(mine===run){field.value='';button.disabled=true;status.textContent=t;}}f.addEventListener('submit',function(e){if(button.disabled||!field.value){e.preventDefault();}});function done(mine,blob){blob.arrayBuffer().then(function(buf){if(mine!==run){return;}var b=new Uint8Array(buf),s='';for(var k=0;k<b.length;k+=8192){s+=String.fromCharCode.apply(null,b.subarray(k,k+8192));}field.value=btoa(s).split('+').join('-').split('/').join('_').replace(/=+$/,'');status.textContent='Ready: '+Math.ceil(b.length/1024)+' KB';button.disabled=false;},function(){fail(mine,'That photo could not be prepared. Try another picture.');});}function encode(mine,type,i){canvas.toBlob(function(blob){if(mine!==run){return;}if(!blob){fail(mine,'That photo could not be prepared. Try another picture.');return;}if(type==='image/webp'&&blob.type!=='image/webp'){encode(mine,'image/jpeg',0);return;}if(type==='image/jpeg'&&blob.type!=='image/jpeg'){fail(mine,'This browser could not make a JPEG or WebP photo. Use a current Chrome, Edge, Firefox or Safari.');return;}if(blob.size>153600){if(i+1<steps.length){encode(mine,type,i+1);}else{fail(mine,'That photo is still too large after compressing. Try a smaller picture.');}return;}done(mine,blob);},type,steps[i]);}input.addEventListener('change',function(){run+=1;var mine=run;field.value='';button.disabled=true;var file=input.files&&input.files[0];if(!file){status.textContent='';return;}status.textContent='Preparing the photo.';new Promise(function(ok){ok(createImageBitmap(file,{imageOrientation:'from-image'}));}).catch(function(){return createImageBitmap(file);}).then(function(bmp){if(mine!==run){return;}var w=bmp.width,h=bmp.height,s=Math.min(1,512/Math.max(w,h));canvas.width=Math.max(1,Math.round(w*s));canvas.height=Math.max(1,Math.round(h*s));canvas.getContext('2d').drawImage(bmp,0,0,canvas.width,canvas.height);if(bmp.close){bmp.close();}canvas.hidden=false;encode(mine,'image/webp',0);},function(){fail(mine,'That file could not be read as a picture.');});});});`;

export function dashboardPage(
  res: Response,
  page: {
    title: string;
    body: SafeHtml;
    status?: number;
    /** 'bans': BAN_PHOTO_SCRIPT too, after the kit's, with the page nonce. */
    script?: 'bans';
  },
): void {
  const { session, nonce } = dashboardLocals(res);
  // The UI kit's one script (copy buttons, modals), once on every page.
  // prettier-ignore
  const kit = html`<script nonce="${nonce}">${KIT_SCRIPT}</script>`;
  // prettier-ignore
  const bans = page.script === 'bans' ? html`<script nonce="${nonce}">${BAN_PHOTO_SCRIPT}</script>` : '';
  res
    .status(page.status ?? 200)
    .type('html')
    .send(
      layout({
        title: page.title,
        nonce,
        user: session,
        // The route decides the current tab, by comparison with the nav's own paths.
        current: navKeyFor(res.req?.originalUrl),
        body: html`${page.body}${kit}${bans}`,
      }),
    );
}

export function notFound(res: Response): void {
  res
    .status(404)
    .type('html')
    .send(errorPage(404, dashboardLocals(res).nonce));
}

/** A data outage: errorPage's 503 text is about the access check, so this has its own page. */
export function unavailable(res: Response, what: string): void {
  dashboardPage(res, {
    title: 'Unavailable',
    status: 503,
    body: html`<div class="card">
      <h1>Unavailable</h1>
      <p>
        ${what} cannot be loaded right now. Please try again in a few minutes.
      </p>
    </div>`,
  });
}

/**
 * How long a page's data read may take before the 503 page renders. A
 * blackholed Postgres would otherwise hold the request in pool.connect past
 * Heroku's 30 s router timeout (H12). The pools' own connectionTimeoutMillis
 * stays as it is: they are shared with the identity sweep and the commands.
 */
export const PAGE_LOAD_DEADLINE_MS = 10_000;

class PageLoadTimeoutError extends Error {
  constructor(ms: number) {
    super(`page read took over ${ms} ms`);
    this.name = 'PageLoadTimeoutError';
  }
}

/**
 * Runs a data read under `deadlineMs` (PAGE_LOAD_DEADLINE_MS unless a page
 * part asks for less); on failure or timeout logs the error's class name
 * only and renders nothing: for a page part that has its own fixed
 * fallback. A read still running at the deadline is left to finish (or
 * fail) unobserved.
 */
export async function loadOptional<T>(
  what: string,
  fn: () => Promise<T>,
  deadlineMs: number = PAGE_LOAD_DEADLINE_MS,
): Promise<{ ok: true; value: T } | { ok: false }> {
  let timer: NodeJS.Timeout | undefined;
  try {
    // Promise.race subscribes to the read, so one that fails after the
    // deadline is still handled (never an unhandled rejection).
    const read = fn();
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new PageLoadTimeoutError(deadlineMs)),
        deadlineMs,
      );
      timer.unref();
    });
    return { ok: true, value: await Promise.race([read, deadline]) };
  } catch (error) {
    logger.warn(
      `Dashboard ${what} read failed: ${error instanceof Error ? error.name : 'Error'}`,
    );
    return { ok: false };
  } finally {
    clearTimeout(timer);
  }
}

/** loadOptional, rendering the 503 page on failure or timeout. */
export async function load<T>(
  res: Response,
  what: string,
  fn: () => Promise<T>,
): Promise<{ ok: true; value: T } | { ok: false }> {
  const loaded = await loadOptional(what, fn);
  if (!loaded.ok) {
    unavailable(res, what);
  }
  return loaded;
}

/** A route's :period: parsePeriodKey only, never before the group's first month and never after the current Pacific month. */
export function parseRouteMonth(value: unknown, now: Date): Period | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const period = parsePeriodKey(value);
  if (
    period === undefined ||
    comparePeriods(period, GROUP_FIRST_PERIOD) < 0 ||
    comparePeriods(period, periodOf(now)) > 0
  ) {
    return undefined;
  }
  return period;
}

/** parseRouteMonth plus the workspace range (WORKSPACE_FIRST_PERIOD through the current Pacific month). */
export function parseWorkspaceMonth(
  value: unknown,
  now: Date,
): Period | undefined {
  const period = parseRouteMonth(value, now);
  return period !== undefined && isWorkspaceMonth(period, now)
    ? period
    : undefined;
}

/** A workspace row id route param: 1-9 digits, no leading zero (so never 0). */
export function parseRowId(value: unknown): number | undefined {
  if (typeof value !== 'string' || !/^[1-9][0-9]{0,8}$/.test(value)) {
    return undefined;
  }
  return Number(value);
}

/** 'Sep 3, 2026 7:00 PM' in the group's timezone. */
export const pacificDateTime = (value: Date | string): string =>
  pacificFormat(value, 'MMM D, YYYY h:mm A');

/** 'Sep 3, 2026' in the group's timezone. */
export const pacificDate = (value: Date | string): string =>
  pacificFormat(value, 'MMM D, YYYY');

/**
 * Only a non-empty string or a Date that parses: dayjs(undefined) is "now",
 * so a missing stored date would otherwise render as the current time.
 */
function pacificFormat(value: unknown, format: string): string {
  if (!(value instanceof Date) && (typeof value !== 'string' || value === '')) {
    return '';
  }
  const parsed = dayjs(value);
  return parsed.isValid() ? tz(parsed).format(format) : '';
}

export function builtByHtml(builtBy: string): SafeHtml {
  if (builtBy === 'job') {
    return html`the daily job`;
  }
  if (builtBy === 'backfill') {
    return html`the backfill`;
  }
  return discordProfileUrl(builtBy)
    ? html`a staff member (${discordUserLink(builtBy, 'profile')})`
    : html`a staff member`;
}

/** Only for finished months: past events had RSVPs, nobody was marked a no-show. Never says "incomplete". */
export function zeroNoShowNote(
  period: Period,
  attendance: AttendanceEvidence | null | undefined,
  now: Date,
): SafeHtml | '' {
  if (!attendance || !isFinished(period, now) || !noShowsMissing(attendance)) {
    return '';
  }
  return html`<p class="note attn">
    No no-shows were recorded for ${monthLabel(period)} across
    ${attendance.pastEventsWithRsvps} past events with RSVPs. Check that
    attendance was taken.
  </p>`;
}

/** A list row's month: linked to its page, or plain text when the month has no page (see linkableMonthPath). */
export function monthCell(
  template: MonthPathTemplate,
  period: Period,
): SafeHtml {
  const path = linkableMonthPath(template, period);
  return path === undefined
    ? html`${monthLabel(period)}`
    : html`<a href="${localUrl(path)}">${monthLabel(period)}</a>`;
}
