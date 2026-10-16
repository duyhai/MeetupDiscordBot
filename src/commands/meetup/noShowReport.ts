import dayjs from 'dayjs';
import {
  ApplicationCommandOptionType,
  CommandInteraction,
  PermissionFlagsBits,
} from 'discord.js';
import { Discord, Slash, SlashOption } from 'discordx';
import { Logger } from 'tslog';

import { GqlMeetupClient } from '../../lib/client/meetup/gqlClient.js';
import { mapWithConcurrency } from '../../lib/client/meetup/paginationHelper.js';
import { EventSummary } from '../../lib/client/meetup/types.js';
import {
  NoShowCase,
  NoShowCases,
  actByDate,
  formatNoShowReport,
  formatSuspensionCsv,
  upcomingEvents,
} from '../../lib/helpers/noShowReport.js';
import { PostgresSuspensionRepository } from '../../lib/repositories/postgresSuspensionRepository.js';
import {
  discordCommandWrapper,
  logModerationAction,
  requireModOrOrganizer,
  withDiscordFileAttachment,
} from '../../util/discord.js';
import { withMeetupClient } from '../../util/meetup.js';
import { fetchMonthData } from '../../lib/reports/meetupMonth.js';
import {
  buildNoShowReport,
  toNoShowCases,
} from '../../lib/reports/noShowReport.js';

const logger = new Logger({ name: 'MeetupNoShowReportCommands' });

// Bounds parallel Meetup requests (one per event or per member) so a busy
// month doesn't fire dozens of paginated requests at once.
const MEETUP_CONCURRENCY = 5;

/** Each member's own RSVPs with the given statuses; undefined if they left. */
async function getRsvpEventsByMember(
  meetupClient: GqlMeetupClient,
  groupId: string,
  memberIds: string[],
  filter: Parameters<GqlMeetupClient['getMemberRsvpEvents']>[2],
  options?: Parameters<GqlMeetupClient['getMemberRsvpEvents']>[3],
): Promise<Map<string, EventSummary[] | undefined>> {
  const events = await mapWithConcurrency(
    memberIds,
    MEETUP_CONCURRENCY,
    (memberId) =>
      meetupClient.getMemberRsvpEvents(memberId, groupId, filter, options),
  );
  return new Map(memberIds.map((memberId, i) => [memberId, events[i]]));
}

/**
 * Adds every upcoming RSVP to each suspension candidate, plus the act-by day
 * from the earliest one.
 */
async function withUpcomingRsvps(
  meetupClient: GqlMeetupClient,
  groupId: string,
  cases: NoShowCase[],
  now: dayjs.Dayjs,
): Promise<NoShowCase[]> {
  const candidateIds = cases
    .filter((c) => c.classification === 'suspension')
    .map((c) => c.member.id);
  const upcoming = await getRsvpEventsByMember(
    meetupClient,
    groupId,
    candidateIds,
    { rsvpStatus: ['YES'], eventStatus: ['UPCOMING'] },
    { withPaymentInfo: true },
  );
  return cases.map((c) => {
    const upcomingRsvps = upcomingEvents(upcoming.get(c.member.id) ?? [], now);
    const next = upcomingRsvps.at(0);
    return next ? { ...c, upcomingRsvps, ...actByDate(next.dateTime, now) } : c;
  });
}

async function sendReport(
  interaction: CommandInteraction,
  year: number,
  month: number,
  result: NoShowCases,
) {
  const periodLabel = `${year} ${dayjs()
    .month(month - 1)
    .format('MMMM')}`;
  await withDiscordFileAttachment(
    `No Show report ${year}-${month}.txt`,
    formatNoShowReport(periodLabel, result),
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

  const suspensionCsv = formatSuspensionCsv(result.cases);
  if (suspensionCsv !== undefined) {
    await withDiscordFileAttachment(
      `suggested_suspensions_${year}-${month}.csv`,
      suspensionCsv,
      async (attachmentArgs) => {
        await interaction.followUp({
          ...attachmentArgs,
          content:
            'Suggested suspensions as an editable CSV. Delete the rows ' +
            'Melissa didn’t act on, fill in `suspended_at` with the day she ' +
            'applied each one, then upload it via /meetup_record_suspension.',
          ephemeral: true,
        });
      },
    );
  }
}

@Discord()
export class MeetupNoShowReportCommands {
  @Slash({
    name: 'meetup_run_noshow_report',
    description:
      'Monthly no-show report: warning/suspension recs, penalties, act-by dates. Output is private.',
    // Hides the command from members without mod permissions; the role check
    // inside the handler stays authoritative.
    defaultMemberPermissions: PermissionFlagsBits.ModerateMembers,
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
      // Connect before the Meetup reads, so a database problem fails
      // straight away rather than after them.
      const repo = await PostgresSuspensionRepository.instance();
      await withMeetupClient(interaction, async (meetupClient) => {
        logger.info(`Running no-show report for ${year}-${month}`);
        await interaction.editReply({
          content: 'Sit tight! Checking attendance.',
        });

        const now = dayjs();
        let groupId: string | undefined;
        const resolveGroupId = async () => {
          groupId ??= (await meetupClient.getUserMembershipInfo())
            .groupByUrlname.id;
          return groupId;
        };
        const data = await fetchMonthData(meetupClient, { year, month });
        const report = await buildNoShowReport(
          meetupClient,
          { year, month },
          data,
          {
            asOf: now.toDate(),
            // The command has always read every live record.
            suspensionCutoff: undefined,
            resolveGroupId,
            suspensions: repo,
          },
        );
        if (report.summary.members === 0) {
          await interaction.followUp({
            content: `No no-shows recorded for ${year}-${month}. 🎉`,
            ephemeral: true,
          });
          await logModerationAction(interaction, {
            title: 'No Show report run',
            description: `${interaction.user.toString()} ran the ${year}-${month} report: no no-shows.`,
          });
          return;
        }

        const result = toNoShowCases(report);
        result.cases = await withUpcomingRsvps(
          meetupClient,
          await resolveGroupId(),
          result.cases,
          now,
        );

        await sendReport(interaction, year, month, result);
        const count = (classification: 'warning' | 'suspension') =>
          String(
            result.cases.filter((c) => c.classification === classification)
              .length,
          );
        await logModerationAction(interaction, {
          title: 'No Show report run',
          description: `${interaction.user.toString()} ran the ${year}-${month} report.`,
          fields: [
            { name: 'Warnings', value: count('warning'), inline: true },
            {
              name: 'Suspension candidates',
              value: count('suspension'),
              inline: true,
            },
            {
              name: 'No action needed',
              value: String(result.cleared.length),
              inline: true,
            },
            {
              name: 'No longer in the group',
              value: String(result.departed.length),
              inline: true,
            },
          ],
        });
      });
    });
  }
}
