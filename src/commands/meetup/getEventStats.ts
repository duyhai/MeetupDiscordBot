import dayjs from 'dayjs';
import { ApplicationCommandOptionType, CommandInteraction } from 'discord.js';
import { Discord, Slash, SlashOption } from 'discordx';
import { Logger } from 'tslog';
import { getPaginatedData } from '../../lib/client/meetup/paginationHelper';

import {
  discordCommandWrapper,
  withDiscordFileAttachment,
} from '../../util/discord';
import { withMeetupClient } from '../../util/meetup';

const logger = new Logger({ name: 'MeetupGetStatsCommands' });

@Discord()
export class MeetupGetEventStatsCommands {
  @Slash({
    name: 'meetup_get_event_stats',
    description: `Getting event stats from Meetup`,
  })
  async meetupGetStatsHandler(
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
    interaction: CommandInteraction
  ) {
    await discordCommandWrapper(interaction, async () => {
      await withMeetupClient(interaction, async (meetupClient) => {
        logger.info('Fetching data');
        await interaction.editReply({
          content: 'Sit tight! Fetching data.',
        });

        let startDate = dayjs().set('year', year).startOf('year');
        let endDate = startDate.endOf('year');
        if (month !== 0) {
          startDate = startDate.set('month', month - 1);
          startDate = startDate.startOf('month');
          endDate = startDate.endOf('month');
        }

        const pastEvents = await getPaginatedData(async (paginationInput) => {
          const result = await meetupClient.getGroupEvents(paginationInput, {
            status: ['PAST', 'ACTIVE', 'AUTOSCHED'],
            afterDateTime: startDate.toISOString(),
            beforeDateTime: endDate.toISOString(),
          });
          return result.groupByUrlname.events;
        });

        let total = 0;
        const hostEvents = new Map<string, Array<string>>();
        pastEvents.forEach((event) => {
          const { eventHosts, title, rsvps, maxTickets } = event;

          if (title.includes('[Open House]')) {
            logger.info(`Skipping ${title}. Open House`);
            return;
          }

          total += 1;
          eventHosts.forEach((host) => {
            const key = `${host.member.id}-${host.member.name}`;
            if (!hostEvents.has(key)) {
              hostEvents.set(key, []);
            }
            hostEvents
              .get(key)
              .push(`${title} (${rsvps.yesCount}/${maxTickets})`);
          });
        });

        const formattedResult = Array.from(hostEvents.entries())
          .sort(
            (entry1: [string, string[]], entry2: [string, string[]]) =>
              entry1[1].length - entry2[1].length
          )
          .reverse()
          .map((entry: [string, string[]], index: number) => {
            const [idName, events] = entry;
            const header = `**#${index + 1}: ${events.length} ${idName}**\n`;
            const body = events.map((event) => `    ${event}`).join('\n');
            return header + body;
          })
          .join('\n');
        const header = `**Hosting stats for ${startDate.format('YYYY MMMM')}**`;
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
