import dayjs from 'dayjs';

import { GqlMeetupClient } from '../client/meetup/gqlClient.js';
import { mapWithConcurrency } from '../client/meetup/paginationHelper.js';
import {
  NoShowCases,
  SuspensionHistory,
  buildNoShowCases,
  recommendedSuspensionDays,
  suspensionHistory,
  tallyNoShows,
} from '../helpers/noShowReport.js';
import { PostgresSuspensionRepository } from '../repositories/postgresSuspensionRepository.js';
import {
  MonthData,
  ReportWindow,
  attendanceEvidence,
  windowKey,
} from './meetupMonth.js';
import {
  NoShowCasePayload,
  NoShowPayload,
  PAYLOAD_VERSION,
  toEventRef,
  toMemberRef,
} from './types.js';

// Bounds parallel Meetup requests (one per member) so a busy month doesn't
// fire dozens of paginated requests at once.
const MEETUP_CONCURRENCY = 5;

export type SuspensionHistorySource = Pick<
  PostgresSuspensionRepository,
  'listByMemberIds'
>;
export type NoShowMeetup = Pick<
  GqlMeetupClient,
  'getMemberRsvpEvents' | 'getGroupEventsCount'
>;

export interface NoShowBuildOptions {
  asOf: Date;
  /**
   * Count only suspensions with suspended_at before this (finished months:
   * suspensionCutoff(period)). Undefined: every live record.
   */
  suspensionCutoff: Date | undefined;
  /** Called only when the month has no-shows. */
  resolveGroupId: () => Promise<string>;
  suspensions: SuspensionHistorySource;
  /**
   * Look up whether each case has hosted a past event (one Meetup call per
   * case). Default true; the slash command passes false, as it never shows
   * the flag. When false, every case has hostedPastEvent: false.
   */
  includeHostFlag?: boolean;
}

/**
 * Classifies everyone with a no-show in the window as of `asOf`. No-shows are
 * cut by instant (an event on asOf's calendar day but after it does not
 * count); suspensions are cut by `suspensionCutoff`, which is a calendar day
 * because suspended_at is stored as UTC midnight. The payload holds nothing
 * live: no upcoming RSVPs, act-by dates, payment marks or descriptions.
 */
export async function buildNoShowReport(
  meetupClient: NoShowMeetup,
  window: ReportWindow,
  data: MonthData,
  options: NoShowBuildOptions,
): Promise<NoShowPayload> {
  const asOfMs = options.asOf.getTime();
  const beforeAsOf = (event: { dateTime: string }) =>
    Date.parse(event.dateTime) < asOfMs;

  const monthTally = tallyNoShows(
    data.events.filter(beforeAsOf).map((event) => ({
      event,
      rsvps: (data.rsvps.get(event.id) ?? []).filter(
        (rsvp) => rsvp.status === 'NO_SHOW',
      ),
    })),
  );
  const attendance = attendanceEvidence(data, options.asOf);
  const noShows = [...monthTally.values()].reduce(
    (sum, entry) => sum + entry.events.length,
    0,
  );

  let result: NoShowCases = { cases: [], cleared: [], departed: [] };
  let historyByMember = new Map<string, SuspensionHistory>();
  let hosted = new Set<string>();
  if (monthTally.size > 0) {
    const groupId = await options.resolveGroupId();
    const memberIds = [...monthTally.keys()];
    const [histories, records] = await Promise.all([
      mapWithConcurrency(memberIds, MEETUP_CONCURRENCY, (memberId) =>
        meetupClient.getMemberRsvpEvents(memberId, groupId, {
          rsvpStatus: ['NO_SHOW'],
          eventStatus: ['PAST'],
        }),
      ),
      options.suspensions.listByMemberIds(memberIds, options.suspensionCutoff),
    ]);
    // undefined (left the group) stays undefined; otherwise only no-shows
    // before asOf.
    const noShowsByMember = new Map(
      memberIds.map((id, i) => [id, histories[i]?.filter(beforeAsOf)]),
    );
    historyByMember = new Map(
      memberIds.map((id) => [
        id,
        suspensionHistory(records.filter((record) => record.memberId === id)),
      ]),
    );
    result = buildNoShowCases({
      monthTally,
      noShowsByMember,
      historyByMember,
      now: dayjs(options.asOf),
    });
    const caseIds =
      (options.includeHostFlag ?? true)
        ? result.cases.map((c) => c.member.id)
        : [];
    const hostedCounts = await mapWithConcurrency(
      caseIds,
      MEETUP_CONCURRENCY,
      (hostId) =>
        meetupClient.getGroupEventsCount({
          hostId,
          status: ['PAST'],
          beforeDateTime: options.asOf.toISOString(),
        }),
    );
    hosted = new Set(caseIds.filter((_, i) => hostedCounts[i] > 0));
  }

  const cases = result.cases.map((c): NoShowCasePayload => {
    const prior = historyByMember.get(c.member.id)?.priorCount ?? 0;
    return {
      member: toMemberRef(c.member),
      classification: c.classification,
      counted: c.counted.map(toEventRef),
      since: { day: c.since.day, reason: c.since.reason },
      priorSuspensions: prior,
      recommendedDays: recommendedSuspensionDays(prior),
      hostedPastEvent: hosted.has(c.member.id),
    };
  });
  return {
    version: PAYLOAD_VERSION,
    reportType: 'no_show',
    period: windowKey(window),
    asOf: options.asOf.toISOString(),
    summary: {
      noShows,
      members: monthTally.size,
      warnings: cases.filter((c) => c.classification === 'warning').length,
      suspensionCandidates: cases.filter(
        (c) => c.classification === 'suspension',
      ).length,
      cleared: result.cleared.length,
      departed: result.departed.length,
    },
    attendance,
    cases,
    cleared: result.cleared.map(({ member, lastSuspendedDay }) => ({
      member: toMemberRef(member),
      ...(lastSuspendedDay !== undefined && { lastSuspendedDay }),
    })),
    departed: result.departed.map(toMemberRef),
  };
}

/**
 * Back to the shape formatNoShowReport/formatSuspensionCsv read (no upcoming
 * RSVPs: the command adds those live).
 */
export function toNoShowCases(payload: NoShowPayload): NoShowCases {
  return {
    cases: payload.cases.map((c) => ({
      member: c.member,
      counted: c.counted,
      since: c.since,
      classification: c.classification,
      // As buildNoShowCases sets them: suspension candidates only.
      ...(c.classification === 'suspension' && {
        priorSuspensions: c.priorSuspensions,
        recommendedDays: c.recommendedDays,
      }),
    })),
    cleared: payload.cleared.map(({ member, lastSuspendedDay }) => ({
      member,
      lastSuspendedDay,
    })),
    departed: payload.departed,
  };
}
