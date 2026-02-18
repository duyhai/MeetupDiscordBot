import dayjs from 'dayjs';
import { ApplicationCommandOptionType, CommandInteraction } from 'discord.js';
import { Discord, Slash, SlashOption } from 'discordx';
import { Logger } from 'tslog';
import { GqlMeetupClient } from '../../lib/client/meetup/gqlClient';
import { getPaginatedData } from '../../lib/client/meetup/paginationHelper';

import { BaseUserInfo, Event } from '../../lib/client/meetup/types';
import {
  discordCommandWrapper,
  linkStr,
  withDiscordFileAttachment,
} from '../../util/discord';
import { withMeetupClient } from '../../util/meetup';
import { tz } from '../../util/timezone';

const logger = new Logger({ name: 'MeetupGetStatsCommands' });

async function getEventsYearMonth(
  meetupClient: GqlMeetupClient,
  year: number,
  month: number
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
    interaction: CommandInteraction
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
        const hostEvents = new Map<string, Array<string>>();
        const hosts = new Map<string, BaseUserInfo>();
        // eslint-disable-next-line no-restricted-syntax
        for (const event of pastEvents) {
          const { id, eventHosts, title, maxTickets, eventUrl, dateTime } =
            event;

          if (title.includes('[Open House]')) {
            logger.info(`Skipping ${title}. Open House`);
            // eslint-disable-next-line no-continue
            continue;
          }

          // eslint-disable-next-line no-await-in-loop
          const rsvps = await getPaginatedData(async (paginationInput) => {
            const result = await meetupClient.getEventRsvps(
              id,
              paginationInput,
              {
                rsvpStatus: ['ATTENDED', 'YES'],
              }
            );
            return result.event.rsvps;
          });

          total += 1;
          eventHosts.forEach((host) => {
            const key = host.member.id;
            if (!hostEvents.has(key)) {
              hostEvents.set(key, []);
            }

            hosts.set(key, host.member);
            const titleStr = `${title} (${rsvps.length}/${maxTickets})`;
            hostEvents
              .get(key)
              .push(
                `${
                  shouldIncludeLinks ? linkStr(titleStr, eventUrl) : titleStr
                } ${shouldShowDates ? tz(dayjs(dateTime)).format('LLL') : ''}`
              );
          });
        }

        const formattedResult = Array.from(hostEvents.entries())
          .sort(
            (entry1: [string, string[]], entry2: [string, string[]]) =>
              entry1[1].length - entry2[1].length
          )
          .reverse()
          .map((entry: [string, string[]], index: number) => {
            const [id, events] = entry;
            const hostInfo = hosts.get(id);
            const header = `**#${index + 1}: ${events.length} ${
              shouldIncludeLinks
                ? linkStr(hostInfo.name, hostInfo.memberUrl)
                : hostInfo.name
            } ID: ${id}**\n`;
            const body = events.map((event) => `    ${event}`).join('\n');
            return header + body;
          })
          .join('\n');

        const header = `**Hosting stats for ${year} ${
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
          }
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
    interaction: CommandInteraction
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
              }
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
                  }`
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
          }
        );
      });
    });
  }
}
