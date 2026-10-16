import dayjs from 'dayjs';

import { GqlMeetupClient } from '../client/meetup/gqlClient.js';
import { mapWithConcurrency } from '../client/meetup/paginationHelper.js';
import {
  collectHostStats,
  formatHallOfFamePost,
  isCountableEvent,
} from '../helpers/hallOfFame.js';
import { linkStr } from '../../util/discord.js';
import { tz } from '../../util/timezone.js';
import {
  MonthData,
  RSVP_FETCH_CONCURRENCY,
  ReportWindow,
  attendanceCount,
  windowKey,
  windowStart,
} from './meetupMonth.js';
import {
  HallOfFamePayload,
  PAYLOAD_VERSION,
  toEventRef,
  toMemberRef,
} from './types.js';

/**
 * A host is "new" when the group has no PAST event of theirs before the
 * report window. One first:1 totalCount query per host, run in parallel.
 * Live-schema introspection (2026-09-25) confirmed GroupEventFilter accepts
 * hostId + beforeDateTime + status; see the design spec for the fallback if
 * the resolver ignores the combination.
 */
export async function findNewHostIds(
  meetupClient: Pick<GqlMeetupClient, 'getGroupEventsCount'>,
  hostIds: string[],
  beforeIso: string,
): Promise<Set<string>> {
  const checks = await mapWithConcurrency(
    hostIds,
    RSVP_FETCH_CONCURRENCY,
    async (hostId) => {
      const priorCount = await meetupClient.getGroupEventsCount({
        hostId,
        beforeDateTime: beforeIso,
        status: ['PAST'],
      });
      return { hostId, priorCount };
    },
  );
  return new Set(
    checks.filter((check) => check.priorCount === 0).map((c) => c.hostId),
  );
}

export async function buildHallOfFameReport(
  meetupClient: Pick<GqlMeetupClient, 'getGroupEventsCount'>,
  window: ReportWindow,
  data: MonthData,
  asOf: Date,
): Promise<HallOfFamePayload> {
  const { hostStats, totalEvents } = collectHostStats(
    data.events.filter(isCountableEvent),
  );
  const newHostIds = await findNewHostIds(
    meetupClient,
    hostStats.map((stats) => stats.host.id),
    windowStart(window).toISOString(),
  );
  const hosts = hostStats.map(({ host, events }) => ({
    host: toMemberRef(host),
    isNew: newHostIds.has(host.id),
    events: events.map((event) => ({
      ...toEventRef(event),
      maxTickets: event.maxTickets,
      attendance: attendanceCount(data.rsvps.get(event.id) ?? []),
      eventHosts: event.eventHosts.map(({ member }) => ({
        member: toMemberRef(member),
      })),
    })),
  }));
  return {
    version: PAYLOAD_VERSION,
    reportType: 'hall_of_fame',
    period: windowKey(window),
    asOf: asOf.toISOString(),
    summary: {
      events: totalEvents,
      hosts: hosts.length,
      newHosts: hosts.filter((h) => h.isNew).length,
    },
    totalEvents,
    hosts,
  };
}

/** The command's attachment text, byte for byte. */
export function formatHostingStatsText(
  payload: HallOfFamePayload,
  options: { periodLabel: string; showDates: boolean; includeLinks: boolean },
): string {
  const { periodLabel, showDates, includeLinks } = options;
  const detailedResult = payload.hosts
    .map(({ host, events, isNew }, index) => {
      const header = `**#${index + 1}: ${events.length} ${
        includeLinks ? linkStr(host.name, host.memberUrl) : host.name
      } ID: ${host.id}**${isNew ? ' 🆕' : ''}\n`;
      const body = events
        .map((event) => {
          const titleStr = `${event.title} (${event.attendance}/${event.maxTickets})`;
          return `    ${includeLinks ? linkStr(titleStr, event.eventUrl) : titleStr} ${
            showDates ? tz(dayjs(event.dateTime)).format('LLL') : ''
          }`;
        })
        .join('\n');
      return header + body;
    })
    .join('\n');
  const header = `**Hosting stats for ${periodLabel}**`;
  const readyToPost = formatHallOfFamePost({
    periodLabel,
    hostStats: payload.hosts,
    totalEvents: payload.totalEvents,
    newHostIds: new Set(
      payload.hosts.filter((h) => h.isNew).map((h) => h.host.id),
    ),
  });
  return `
${header}

${detailedResult}

**Total: ${payload.totalEvents}**

----- READY TO POST -----

${readyToPost}`;
}
