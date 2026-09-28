import dayjs from 'dayjs';
import {
  ApplicationCommandOptionType,
  CommandInteraction,
  PermissionFlagsBits,
} from 'discord.js';
import { Discord, Slash, SlashOption } from 'discordx';
import { Logger } from 'tslog';

import { GqlMeetupClient } from '../../lib/client/meetup/gqlClient.js';
import {
  getPaginatedData,
  mapWithConcurrency,
} from '../../lib/client/meetup/paginationHelper.js';
import { EventSummary } from '../../lib/client/meetup/types.js';
import {
  NoShowCase,
  NoShowCases,
  NoShowTally,
  SuspensionHistory,
  actByDate,
  buildNoShowCases,
  formatNoShowReport,
  formatSuspensionCsv,
  nextEvent,
  suspensionHistory,
  tallyNoShows,
} from '../../lib/helpers/noShowReport.js';
import { PostgresSuspensionRepository } from '../../lib/repositories/postgresSuspensionRepository.js';
import {
  discordCommandWrapper,
  requireModOrOrganizer,
  withDiscordFileAttachment,
} from '../../util/discord.js';
import { withMeetupClient } from '../../util/meetup.js';
import { getEventsYearMonth } from './getEventStats.js';

const logger = new Logger({ name: 'MeetupNoShowReportCommands' });

// Bounds parallel Meetup requests (one per event or per member) so a busy
// month doesn't fire dozens of paginated requests at once.
const MEETUP_CONCURRENCY = 5;

/**
 * Who no-showed in the report month. Meetup has no group-wide "no-shows"
 * query, so this reads each of the month's events.
 */
async function getMonthNoShows(
  meetupClient: GqlMeetupClient,
  year: number,
  month: number,
): Promise<NoShowTally> {
  const events = await getEventsYearMonth(meetupClient, year, month);
  const perEvent = await mapWithConcurrency(
    events,
    MEETUP_CONCURRENCY,
    async (event) => {
      const rsvps = await getPaginatedData(async (paginationInput) => {
        const result = await meetupClient.getEventRsvps(
          event.id,
          paginationInput,
          { rsvpStatus: ['NO_SHOW'] },
        );
        return result.event.rsvps;
      });
      return { event, rsvps };
    },
  );
  return tallyNoShows(perEvent);
}

/** Each member's own RSVPs with the given statuses; undefined if they left. */
async function getRsvpEventsByMember(
  meetupClient: GqlMeetupClient,
  groupId: string,
  memberIds: string[],
  filter: Parameters<GqlMeetupClient['getMemberRsvpEvents']>[2],
): Promise<Map<string, EventSummary[] | undefined>> {
  const events = await mapWithConcurrency(
    memberIds,
    MEETUP_CONCURRENCY,
    (memberId) => meetupClient.getMemberRsvpEvents(memberId, groupId, filter),
  );
  return new Map(memberIds.map((memberId, i) => [memberId, events[i]]));
}

async function getSuspensionHistories(
  repo: PostgresSuspensionRepository,
  memberIds: string[],
): Promise<Map<string, SuspensionHistory>> {
  const histories = await Promise.all(
    memberIds.map(async (memberId) =>
      suspensionHistory(await repo.listByMemberId(memberId)),
    ),
  );
  return new Map(memberIds.map((memberId, i) => [memberId, histories[i]]));
}

/** Adds the next RSVP'd event and act-by day to each suspension candidate. */
async function withNextEvents(
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
  );
  return cases.map((c) => {
    const next = nextEvent(upcoming.get(c.member.id) ?? [], now);
    return next
      ? { ...c, nextRsvpEvent: next, ...actByDate(next.dateTime, now) }
      : c;
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

        const monthTally = await getMonthNoShows(meetupClient, year, month);
        if (monthTally.size === 0) {
          await interaction.followUp({
            content: `No no-shows recorded for ${year}-${month}. 🎉`,
            ephemeral: true,
          });
          return;
        }

        const now = dayjs();
        const groupId = (await meetupClient.getUserMembershipInfo())
          .groupByUrlname.id;
        const memberIds = [...monthTally.keys()];
        const [noShowsByMember, historyByMember] = await Promise.all([
          getRsvpEventsByMember(meetupClient, groupId, memberIds, {
            rsvpStatus: ['NO_SHOW'],
            eventStatus: ['PAST'],
          }),
          getSuspensionHistories(repo, memberIds),
        ]);
        const result = buildNoShowCases({
          monthTally,
          noShowsByMember,
          historyByMember,
          now,
        });
        result.cases = await withNextEvents(
          meetupClient,
          groupId,
          result.cases,
          now,
        );

        await sendReport(interaction, year, month, result);
      });
    });
  }
}
