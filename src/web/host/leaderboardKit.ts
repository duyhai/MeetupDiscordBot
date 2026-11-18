/**
 * Pieces shared by the Leaderboard and host profile pages: medal and streak
 * badges (each emoji with its words for screen readers), the "updated" line
 * and paths.
 */
import dayjs from 'dayjs';

import {
  HostStreaks,
  Medal,
  MedalPlace,
} from '../../lib/leaderboard/standings.js';
import { tz } from '../../util/timezone.js';
import { SafeHtml, SafeUrl, html, localUrl } from '../html.js';
import { HOST_BASE } from './hostSession.js';

export const LEADERBOARD_PATH = `${HOST_BASE}/leaderboard`;

export const MEDAL_ICON: Record<MedalPlace, string> = {
  1: '🥇',
  2: '🥈',
  3: '🥉',
};
export const MEDAL_NAME: Record<MedalPlace, string> = {
  1: 'Gold',
  2: 'Silver',
  3: 'Bronze',
};

export const plural = (n: number, one: string, many = `${one}s`) =>
  `${n} ${n === 1 ? one : many}`;

export const monthName = (month: string) =>
  dayjs(`${month}-01`).format('MMMM YYYY');

/** An emoji with its words for screen readers and on hover. */
export function emoji(icon: string, label: string): SafeHtml {
  return html`<span role="img" aria-label="${label}" title="${label}"
    >${icon}</span
  >`;
}

export function medalBadge(place: MedalPlace, month?: string): SafeHtml {
  const label = month
    ? `${MEDAL_NAME[place]} medal, ${monthName(month)}`
    : `${MEDAL_NAME[place]} medal`;
  return emoji(MEDAL_ICON[place], label);
}

/** Icons per Hai: weekly is the prestige streak (💎), daily is being on fire (🔥). */
export const WEEKLY_STREAK_ICON = '💎';
export const DAILY_STREAK_ICON = '🔥';

/**
 * Current streaks with their counts, weekly first (the more prestigious);
 * a broken streak is left out.
 */
export function streakBadges(streaks: HostStreaks): SafeHtml {
  const { daily, weekly } = streaks;
  const parts: SafeHtml[] = [];
  if (weekly.current > 0) {
    const label = `Weekly hosting streak: ${plural(weekly.current, 'week')}`;
    parts.push(
      html`<span class="streak"
        >${emoji(WEEKLY_STREAK_ICON, label)} ${weekly.current}</span
      >`,
    );
  }
  if (daily.current > 0) {
    const label = `Daily hosting streak: ${plural(daily.current, 'day')}`;
    parts.push(
      html`<span class="streak"
        >${emoji(DAILY_STREAK_ICON, label)} ${daily.current}</span
      >`,
    );
  }
  return parts.length === 0
    ? html`<span class="muted">None</span>`
    : html`${parts}`;
}

export function bestStreaks(streaks: HostStreaks): string {
  return `Best: ${plural(streaks.weekly.best, 'week')} in a row, ${plural(
    streaks.daily.best,
    'day',
  )} in a row`;
}

export function streakNote(): SafeHtml {
  return html`<p class="muted">
    ${emoji(WEEKLY_STREAK_ICON, 'Weekly streak')} counts weeks in a row (Monday
    to Sunday) with a hosted event; ${emoji(DAILY_STREAK_ICON, 'Daily streak')}
    counts days in a row. A streak keeps going until a whole week or day passes
    without one.
  </p>`;
}

export function medalTally(medals: Medal[]): SafeHtml {
  if (medals.length === 0) {
    return html`<span class="muted">None yet</span>`;
  }
  const parts = ([1, 2, 3] as const).flatMap((place) => {
    const n = medals.filter((m) => m.place === place).length;
    return n === 0
      ? []
      : [
          html`<span class="streak"
            >${emoji(MEDAL_ICON[place], `${plural(n, `${MEDAL_NAME[place].toLowerCase()} medal`)}`)}
            ×${n}</span
          >`,
        ];
  });
  return html`${parts}`;
}

export function updatedLine(data: { updatedAt: Date | undefined }): SafeHtml {
  return data.updatedAt
    ? html`<p class="muted">
        From Meetup as of ${tz(dayjs(data.updatedAt)).format('MMM D, h:mm A')}
        (updated about once a day). Cancelled events and Open Houses do not
        count, and every co-host of an event gets the event.
      </p>`
    : html``;
}

/** A host's profile page; only for an all-digit Meetup id. */
export function profileUrl(memberId: string): SafeUrl | undefined {
  return /^[0-9]{1,20}$/.test(memberId)
    ? localUrl(`${HOST_BASE}/hosts/${memberId}`)
    : undefined;
}
