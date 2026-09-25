import dayjs from 'dayjs';
import { ApplicationCommandOptionType, CommandInteraction } from 'discord.js';
import { Discord, Slash, SlashOption } from 'discordx';
import { Logger } from 'tslog';
import { GqlMeetupClient } from '../../lib/client/meetup/gqlClient.js';
import { getPaginatedData } from '../../lib/client/meetup/paginationHelper.js';

import { BaseUserInfo, Event } from '../../lib/client/meetup/types.js';
import {
  collectHostStats,
  formatHallOfFamePost,
  isCancelledEvent,
} from '../../lib/helpers/hallOfFame.js';
import {
  discordCommandWrapper,
  linkStr,
  withDiscordFileAttachment,
} from '../../util/discord.js';
import { withMeetupClient } from '../../util/meetup.js';
import { tz } from '../../util/timezone.js';

const logger = new Logger({ name: 'MeetupGetStatsCommands' });

export async function getEventsYearMonth(
  meetupClient: GqlMeetupClient,
  year: number,
  month: number,
) {
  let startDate = tz(dayjs()).set('year', year).startOf('year');
  let endDate = startDate.endOf('year');
  if (month !== 0) {
    startDate = startDate.set('month', month - 1).startOf('month');
    endDate = startDate.endOf('month');
  }

  return getPaginatedData(async (paginationInput) => {
    const result = await meetupClient.getGroupEvents(paginationInput, {
      status: ['PAST', 'ACTIVE', 'AUTOSCHED'],
      afterDateTime: startDate.toISOString(),
      beforeDateTime: endDate.toISOString(),
    });
    return result.groupByUrlname.events;
  });
}

/**
 * A host is "new" when the group has no PAST event of theirs before the
 * report window. One first:1 totalCount query per host, run in parallel.
 * Live-schema introspection (2026-09-25) confirmed GroupEventFilter accepts
 * hostId + beforeDateTime + status; see the design spec for the fallback if
 * the resolver ignores the combination.
 */
export async function findNewHostIds(
  meetupClient: GqlMeetupClient,
  hostIds: string[],
  beforeIso: string,
): Promise<Set<string>> {
  const checks = await Promise.all(
    hostIds.map(async (hostId) => {
      const result = await meetupClient.getGroupEvents(
        { first: 1 },
        { hostId, beforeDateTime: beforeIso, status: ['PAST'] },
      );
      return { hostId, priorCount: result.groupByUrlname.events.totalCount };
    }),
  );
  return new Set(
    checks.filter((check) => check.priorCount === 0).map((c) => c.hostId),
  );
}

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
      await withMeetupClient(interaction, async (meetupClient) => {
        logger.info('Fetching data');
        await interaction.editReply({ content: 'Sit tight! Fetching data.' });

        const pastEvents = await getEventsYearMonth(meetupClient, year, month);
        const countableEvents = pastEvents.filter(
          (event) => !isCancelledEvent(event),
        );

        // Attendance counts for the detailed attachment (unchanged data, but only
        // for countable events).
        const rsvpCounts = new Map<string, number>();
        await Promise.all(
          countableEvents
            .filter((event) => !event.title.includes('[Open House]'))
            .map(async (event) => {
              const rsvps = await getPaginatedData(async (paginationInput) => {
                const result = await meetupClient.getEventRsvps(
                  event.id,
                  paginationInput,
                  { rsvpStatus: ['ATTENDED', 'YES'] },
                );
                return result.event.rsvps;
              });
              rsvpCounts.set(event.id, rsvps.length);
            }),
        );

        const { hostStats, totalEvents } = collectHostStats(pastEvents);

        const monthStart = tz(dayjs())
          .set('year', year)
          .set('month', month === 0 ? 0 : month - 1)
          .startOf(month === 0 ? 'year' : 'month');
        const newHostIds = await findNewHostIds(
          meetupClient,
          hostStats.map((stats) => stats.host.id),
          monthStart.toISOString(),
        );

        const detailedResult = hostStats
          .map((stats, index) => {
            const { host, events } = stats;
            const header = `**#${index + 1}: ${events.length} ${
              shouldIncludeLinks
                ? linkStr(host.name, host.memberUrl)
                : host.name
            } ID: ${host.id}**${newHostIds.has(host.id) ? ' 🆕' : ''}\n`;
            const body = events
              .map((event) => {
                const titleStr = `${event.title} (${
                  rsvpCounts.get(event.id) ?? 0
                }/${event.maxTickets})`;
                return `    ${
                  shouldIncludeLinks
                    ? linkStr(titleStr, event.eventUrl)
                    : titleStr
                } ${shouldShowDates ? tz(dayjs(event.dateTime)).format('LLL') : ''}`;
              })
              .join('\n');
            return header + body;
          })
          .join('\n');

        const periodLabel = `${year}${
          month > 0
            ? ` ${dayjs()
                .month(month - 1)
                .format('MMMM')}`
            : ''
        }`;
        const header = `**Hosting stats for ${periodLabel}**`;
        const readyToPost = formatHallOfFamePost({
          periodLabel,
          hostStats,
          totalEvents,
          newHostIds,
        });
        const result = `
${header}

${detailedResult}

**Total: ${totalEvents}**

----- READY TO POST -----

${readyToPost}`;
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
      });
    });
  }

  @Slash({
    name: 'meetup_get_noshow_event_stats',
    description: `Getting no show event stats from Meetup`,
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
      await withMeetupClient(interaction, async (meetupClient) => {
        logger.info('Fetching data');
        await interaction.editReply({
          content: 'Sit tight! Fetching data.',
        });

        const pastEvents = await getEventsYearMonth(meetupClient, year, month);

        let total = 0;
        const noShowMembers = new Map<string, BaseUserInfo>();
        const noShowEventsPerMember = new Map<string, Event[]>();

        // Create an array of promises, one for each event's RSVP fetch
        const rsvpPromises = pastEvents.map(async (event) => {
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
        });

        // Await all promises to resolve in parallel
        const results = await Promise.all(rsvpPromises);

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
      });
    });
  }
}
