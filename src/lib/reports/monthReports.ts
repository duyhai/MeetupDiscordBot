import { GqlMeetupClient } from '../client/meetup/gqlClient.js';
import { buildHallOfFameReport } from './hallOfFameReport.js';
import { fetchMonthData } from './meetupMonth.js';
import { SuspensionHistorySource, buildNoShowReport } from './noShowReport.js';
import { Period } from './period.js';
import { HallOfFamePayload, NoShowPayload } from './types.js';

export interface MonthReports {
  hallOfFame: HallOfFamePayload;
  noShow: NoShowPayload;
  /** Built from a complete Meetup read; attendance is never inferred. */
  sourceComplete: boolean;
}

/** Both reports for one month from a single events-and-RSVPs fetch. */
export async function buildMonthReports(
  meetupClient: GqlMeetupClient,
  period: Period,
  options: {
    asOf: Date;
    suspensionCutoff: Date | undefined;
    groupId: string;
    suspensions: SuspensionHistorySource;
  },
): Promise<MonthReports> {
  const data = await fetchMonthData(meetupClient, period);
  const hallOfFame = await buildHallOfFameReport(
    meetupClient,
    period,
    data,
    options.asOf,
  );
  const noShow = await buildNoShowReport(meetupClient, period, data, {
    asOf: options.asOf,
    suspensionCutoff: options.suspensionCutoff,
    resolveGroupId: () => Promise.resolve(options.groupId),
    suspensions: options.suspensions,
  });
  return {
    hallOfFame,
    noShow,
    sourceComplete: true,
  };
}
