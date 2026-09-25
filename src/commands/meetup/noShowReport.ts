import dayjs from 'dayjs';
import { ApplicationCommandOptionType, CommandInteraction } from 'discord.js';
import { Discord, Slash, SlashOption } from 'discordx';
import { Logger } from 'tslog';

import { GqlMeetupClient } from '../../lib/client/meetup/gqlClient.js';
import { getPaginatedData } from '../../lib/client/meetup/paginationHelper.js';
import { Event } from '../../lib/client/meetup/types.js';
import {
  NoShowCase,
  actByDate,
  classifyNoShowCount,
  formatNoShowReport,
  recommendedSuspensionDays,
  tallyNoShows,
} from '../../lib/helpers/noShowReport.js';
import { PostgresSuspensionRepository } from '../../lib/repositories/postgresSuspensionRepository.js';
import {
  discordCommandWrapper,
  requireModOrOrganizer,
  withDiscordFileAttachment,
} from '../../util/discord.js';
import { withMeetupClient } from '../../util/meetup.js';
import { tz } from '../../util/timezone.js';
import { getEventsYearMonth } from './getEventStats.js';

const logger = new Logger({ name: 'MeetupNoShowReportCommands' });

/** NO_SHOW rsvps per event, fetched in parallel (existing pattern). */
async function getNoShowsPerEvent(
  meetupClient: GqlMeetupClient,
  events: Event[],
) {
  return Promise.all(
    events.map(async (event) => {
      const rsvps = await getPaginatedData(async (paginationInput) => {
        const result = await meetupClient.getEventRsvps(
          event.id,
          paginationInput,
          { rsvpStatus: ['NO_SHOW'] },
        );
        return result.event.rsvps;
      });
      return { event, rsvps };
    }),
  );
}

@Discord()
export class MeetupNoShowReportCommands {
  @Slash({
    name: 'meetup_run_noshow_report',
    description:
      'Monthly no-show report: 12-month counts, warning/suspension recs, act-by dates. Output is private.',
  })
  async runNoShowReportHandler(
    @SlashOption({
      name: 'year',
      description: 'The report year',
      type: ApplicationCommandOptionType.Number,
      required: true,
    })
    year: number,
    @SlashOption({
      name: 'month',
      description: 'The report month (1-12)',
      type: ApplicationCommandOptionType.Number,
      minValue: 1,
      maxValue: 12,
      required: true,
    })
    month: number,
    interaction: CommandInteraction,
  ) {
    await discordCommandWrapper(interaction, async () => {
      await requireModOrOrganizer(
        interaction,
        'Only moderators and organizers can run the no-show report.',
      );
      await withMeetupClient(interaction, async (meetupClient) => {
        logger.info(`Running no-show report for ${year}-${month}`);
        await interaction.editReply({
          content: 'Sit tight! Crunching 12 months of attendance.',
        });

        // 1. This month's no-shows.
        const monthEvents = await getEventsYearMonth(meetupClient, year, month);
        const monthTally = tallyNoShows(
          await getNoShowsPerEvent(meetupClient, monthEvents),
        );
        if (monthTally.size === 0) {
          await interaction.followUp({
            content: `No no-shows recorded for ${year}-${month}. 🎉`,
            ephemeral: true,
          });
          return;
        }

        // 2. Trailing 12-month tally (window ends at the report month's end).
        const monthEnd = tz(dayjs())
          .set('year', year)
          .set('month', month - 1)
          .endOf('month');
        const windowStart = monthEnd.subtract(12, 'month');
        const windowEvents = await getPaginatedData(async (paginationInput) => {
          const result = await meetupClient.getGroupEvents(paginationInput, {
            status: ['PAST'],
            afterDateTime: windowStart.toISOString(),
            beforeDateTime: monthEnd.toISOString(),
          });
          return result.groupByUrlname.events;
        });
        const windowTally = tallyNoShows(
          await getNoShowsPerEvent(meetupClient, windowEvents),
        );

        // 3. Upcoming YES rsvps, fetched once, mapped member -> next event.
        const upcomingEvents = await getPaginatedData(
          async (paginationInput) => {
            const result = await meetupClient.getGroupEvents(paginationInput, {
              status: ['ACTIVE', 'AUTOSCHED'],
              afterDateTime: dayjs().toISOString(),
            });
            return result.groupByUrlname.events;
          },
        );
        const sortedUpcoming = [...upcomingEvents].sort((a, b) =>
          a.dateTime.localeCompare(b.dateTime),
        );
        const nextEventByMember = new Map<string, Event>();
        const upcomingRsvps = await Promise.all(
          sortedUpcoming.map(async (event) => {
            const rsvps = await getPaginatedData(async (paginationInput) => {
              const result = await meetupClient.getEventRsvps(
                event.id,
                paginationInput,
                { rsvpStatus: ['YES'] },
              );
              return result.event.rsvps;
            });
            return { event, rsvps };
          }),
        );
        for (const { event, rsvps } of upcomingRsvps) {
          for (const { member } of rsvps) {
            if (!nextEventByMember.has(member.id)) {
              nextEventByMember.set(member.id, event);
            }
          }
        }

        // 4. Build cases.
        const repo = await PostgresSuspensionRepository.instance();
        const now = dayjs();
        const cases: NoShowCase[] = [];
        for (const [memberId, monthEntry] of monthTally) {
          const twelveMonthCount =
            windowTally.get(memberId)?.events.length ??
            monthEntry.events.length;
          const classification = classifyNoShowCount(twelveMonthCount);
          const noShowCase: NoShowCase = {
            member: monthEntry.member,
            monthEvents: monthEntry.events,
            twelveMonthCount,
            classification,
          };
          if (classification === 'suspension') {
            // eslint-disable-next-line no-await-in-loop
            const priorSuspensions = await repo.countByMemberId(memberId);
            noShowCase.priorSuspensions = priorSuspensions;
            noShowCase.recommendedDays =
              recommendedSuspensionDays(priorSuspensions);
            const nextEvent = nextEventByMember.get(memberId);
            if (nextEvent) {
              const { actBy, actNow } = actByDate(nextEvent.dateTime, now);
              noShowCase.nextRsvpEvent = nextEvent;
              noShowCase.actBy = tz(actBy).format('LLL');
              noShowCase.actNow = actNow;
            }
          }
          cases.push(noShowCase);
        }

        const periodLabel = `${year} ${dayjs()
          .month(month - 1)
          .format('MMMM')}`;
        const report = formatNoShowReport(periodLabel, cases);
        await withDiscordFileAttachment(
          `No Show report ${year}-${month}.txt`,
          report,
          async (attachmentArgs) => {
            await interaction.followUp({
              ...attachmentArgs,
              content:
                'Report ready — hand this to Melissa. She sends warnings and ' +
                'applies suspensions; record outcomes with /meetup_record_suspension.',
              ephemeral: true,
            });
          },
        );
      });
    });
  }
}
