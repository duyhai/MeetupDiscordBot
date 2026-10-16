import dayjs from 'dayjs';
import {
  ApplicationCommandOptionType,
  CommandInteraction,
  PermissionFlagsBits,
} from 'discord.js';
import { Discord, Slash, SlashOption } from 'discordx';
import { Logger } from 'tslog';
import {
  getPaginatedData,
  mapWithConcurrency,
} from '../../lib/client/meetup/paginationHelper.js';

import { BaseUserInfo, Event } from '../../lib/client/meetup/types.js';
import {
  buildHallOfFameReport,
  formatHostingStatsText,
} from '../../lib/reports/hallOfFameReport.js';
import {
  RSVP_FETCH_CONCURRENCY,
  fetchMonthData,
  getEventsYearMonth,
} from '../../lib/reports/meetupMonth.js';
import {
  discordCommandWrapper,
  logModerationAction,
  requireModOrOrganizer,
  linkStr,
  withDiscordFileAttachment,
} from '../../util/discord.js';
import { withMeetupClient } from '../../util/meetup.js';
import { tz } from '../../util/timezone.js';

const logger = new Logger({ name: 'MeetupGetStatsCommands' });

export { getEventsYearMonth } from '../../lib/reports/meetupMonth.js';

@Discord()
export class MeetupGetEventStatsCommands {
  @Slash({
    name: 'meetup_get_host_event_stats',
    description: `Getting host event stats from Meetup`,
  })
  async meetupGetHostEventStatsHandler(
    @SlashOption({
      name: 'year',
      description: 'The year to filter to',
      type: ApplicationCommandOptionType.Number,
      required: true,
    })
    year: number,
    @SlashOption({
      name: 'month',
      description:
        'The month to filter to. Set it to 0 in order to disable filtering by month. Output is private.',
      type: ApplicationCommandOptionType.Number,
      minValue: 0,
      maxValue: 12,
      required: true,
    })
    month: number,
    @SlashOption({
      name: 'show_dates',
      description: 'Toggle whether to show event dates. Default is true.',
      type: ApplicationCommandOptionType.Boolean,
      required: false,
    })
    showDates: boolean | undefined,
    @SlashOption({
      name: 'include_links',
      description: 'Toggle whether to include Meetup links. Default is true.',
      type: ApplicationCommandOptionType.Boolean,
      required: false,
    })
    includeLinks: boolean | undefined,
    interaction: CommandInteraction,
  ) {
    // Need to handle defaults here, because interaction param needs to be last
    const shouldShowDates = showDates ?? true;
    const shouldIncludeLinks = includeLinks ?? true;
    await discordCommandWrapper(interaction, async () => {
      // Its run is logged to the staff channel, so it is gated like the
      // no-show stats: a refused member reads nothing and logs nothing there.
      await requireModOrOrganizer(
        interaction,
        'Only moderators and organizers can view hosting stats.',
      );
      await withMeetupClient(interaction, async (meetupClient) => {
        logger.info('Fetching data');
        await interaction.editReply({ content: 'Sit tight! Fetching data.' });

        const data = await fetchMonthData(meetupClient, { year, month });
        const report = await buildHallOfFameReport(
          meetupClient,
          { year, month },
          data,
          new Date(),
        );

        const periodLabel = `${year}${
          month > 0
            ? ` ${dayjs()
                .month(month - 1)
                .format('MMMM')}`
            : ''
        }`;
        const header = `**Hosting stats for ${periodLabel}**`;
        const result = formatHostingStatsText(report, {
          periodLabel,
          showDates: shouldShowDates,
          includeLinks: shouldIncludeLinks,
        });
        await withDiscordFileAttachment(
          `${header}.txt`,
          result,
          async (attachmentArgs) => {
            await interaction.followUp({
              ...attachmentArgs,
              content: 'Check the results in the attachment!',
              ephemeral: true,
            });
          },
        );
        // Logged with the other monthly report commands in the staff
        // channel, where moderators look for them, rather than the general
        // activity log.
        await logModerationAction(interaction, {
          title: 'Hosting stats run',
          description: `${interaction.user.toString()} ran /meetup_get_host_event_stats for ${year}${
            month > 0 ? `-${month}` : ' (whole year)'
          }.`,
          fields: [
            { name: 'Events', value: String(report.totalEvents), inline: true },
            { name: 'Hosts', value: String(report.hosts.length), inline: true },
          ],
        });
      });
    });
  }

  @Slash({
    name: 'meetup_get_noshow_event_stats',
    description: `Getting no show event stats from Meetup`,
    // Lists members' no-shows: mods only. Hides the command from everyone
    // else; the role check inside the handler stays authoritative.
    defaultMemberPermissions: PermissionFlagsBits.ModerateMembers,
  })
  async meetupGetNoShowEventStatsHandler(
    @SlashOption({
      name: 'year',
      description: 'The year to filter to',
      type: ApplicationCommandOptionType.Number,
      required: true,
    })
    year: number,
    @SlashOption({
      name: 'month',
      description:
        'The month to filter to. Set it to 0 in order to disable filtering by month. Output is private.',
      type: ApplicationCommandOptionType.Number,
      minValue: 0,
      maxValue: 12,
      required: true,
    })
    month: number,
    @SlashOption({
      name: 'show_dates',
      description: 'Toggle whether to show event dates. Default is true.',
      type: ApplicationCommandOptionType.Boolean,
      required: false,
    })
    showDates: boolean | undefined,
    @SlashOption({
      name: 'include_links',
      description: 'Toggle whether to include Meetup links. Default is true.',
      type: ApplicationCommandOptionType.Boolean,
      required: false,
    })
    includeLinks: boolean | undefined,
    interaction: CommandInteraction,
  ) {
    // Need to handle defaults here, because interaction param needs to be last
    const shouldShowDates = showDates ?? true;
    const shouldIncludeLinks = includeLinks ?? true;
    await discordCommandWrapper(interaction, async () => {
      await requireModOrOrganizer(
        interaction,
        'Only moderators and organizers can view no-show stats.',
      );
      await withMeetupClient(interaction, async (meetupClient) => {
        logger.info('Fetching data');
        await interaction.editReply({
          content: 'Sit tight! Fetching data.',
        });

        const pastEvents = await getEventsYearMonth(meetupClient, year, month);

        let total = 0;
        const noShowMembers = new Map<string, BaseUserInfo>();
        const noShowEventsPerMember = new Map<string, Event[]>();

        // Fetch each event's no-show RSVPs, bounded to a small number of
        // concurrent requests.
        const results = await mapWithConcurrency(
          pastEvents,
          RSVP_FETCH_CONCURRENCY,
          async (event) => {
            const rsvps = await getPaginatedData(async (paginationInput) => {
              const result = await meetupClient.getEventRsvps(
                event.id,
                paginationInput,
                {
                  rsvpStatus: ['NO_SHOW'],
                },
              );
              return result.event.rsvps;
            });
            // Return an object containing the event and its no-show rsvps
            return { event, rsvps };
          },
        );

        // Now iterate over the results and process the data
        results.forEach(({ event, rsvps }) => {
          total += rsvps.length;
          rsvps.forEach((rsvp) => {
            const key = rsvp.member.id;
            noShowMembers.set(key, rsvp.member);
            if (!noShowEventsPerMember.has(key)) {
              noShowEventsPerMember.set(key, []);
            }
            noShowEventsPerMember.get(key).push(event);
          });
        });

        const formattedResult = Array.from(noShowMembers.keys())
          .map((id: string) => {
            const memberInfo = noShowMembers.get(id);
            const noShows = noShowEventsPerMember.get(id);
            const header = `**${noShows.length} ${
              shouldIncludeLinks
                ? linkStr(memberInfo.name, memberInfo.memberUrl)
                : memberInfo.name
            } ID: ${memberInfo.id}**\n`;
            const body = noShows
              .map(
                (event) =>
                  `    ${
                    shouldIncludeLinks
                      ? linkStr(event.title, event.eventUrl)
                      : event.title
                  } ${
                    shouldShowDates
                      ? tz(dayjs(event.dateTime)).format('LLL')
                      : ''
                  }`,
              )
              .join('\n');
            return header + body;
          })
          .join('\n');

        const header = `**No Show stats for ${year} ${
          month > 0
            ? dayjs()
                .month(month - 1)
                .format('MMMM')
            : ''
        }**`;
        const result = `
${header}
          
${formattedResult}

**Total: ${total}**`;
        await withDiscordFileAttachment(
          `${header}.txt`,
          result,
          async (attachmentArgs) => {
            await interaction.followUp({
              ...attachmentArgs,
              content: 'Check the results in the attachment!',
              ephemeral: true,
            });
          },
        );
        // Lists members' no-shows, so it's logged with the other moderation
        // commands in the staff channel rather than the general activity log.
        await logModerationAction(interaction, {
          title: 'No-show stats run',
          description: `${interaction.user.toString()} ran /meetup_get_noshow_event_stats for ${year}${
            month > 0 ? `-${month}` : ' (whole year)'
          }.`,
          fields: [
            { name: 'No-shows', value: String(total), inline: true },
            {
              name: 'Members',
              value: String(noShowMembers.size),
              inline: true,
            },
          ],
        });
      });
    });
  }
}
