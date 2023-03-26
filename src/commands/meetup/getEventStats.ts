import dayjs from 'dayjs';
import { ApplicationCommandOptionType, CommandInteraction } from 'discord.js';
import { Discord, Slash, SlashOption } from 'discordx';
import { Logger } from 'tslog';
import { getPaginatedData } from '../../lib/client/meetup/paginationHelper';

import {
  discordCommandWrapper,
  withDiscordAttachment,
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
        'The month to filter to. Set it to 0 in order to disable filtering by month',
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
          content: 'Fetching data',
        });

        const pastEvents = await getPaginatedData(async (paginationInput) => {
          const result = await meetupClient.getPastEvents(paginationInput);
          return result.groupByUrlname.pastEvents;
        });

        let startDate = dayjs().set('year', year).startOf('year');
        let endDate = startDate.endOf('year');
        if (month !== 0) {
          startDate = startDate.set('month', month - 1);
          startDate = startDate.startOf('month');
          endDate = startDate.endOf('month');
        }

        const hostEvents = new Map<string, Array<string>>();
        pastEvents.forEach((event) => {
          const { hosts } = event;
          const eventDate = dayjs(event.dateTime);

          const isEventInRange =
            startDate.isBefore(eventDate) && endDate.isAfter(eventDate);
          if (!hosts.length || !isEventInRange) {
            logger.info(`Skipping ${JSON.stringify(event)}`);
            return;
          }

          hosts.forEach((host) => {
            const key = `${host.id}-${host.name}`;
            if (!hostEvents.has(key)) {
              hostEvents.set(key, []);
            }
            hostEvents
              .get(key)
              .push(`${event.title} (${event.going}/${event.maxTickets})`);
          });
        });

        const total = Array.from(hostEvents.values()).reduce(
          (sum, events) => sum + events.length,
          0
        );
        const formattedResult = Array.from(hostEvents.entries())
          .sort(
            (entry1: [string, string[]], entry2: [string, string[]]) =>
              entry1[1].length - entry2[1].length
          )
          .reverse()
          .map((entry: [string, string[]], index: number) => {
            const [idName, events] = entry;
            const name = idName.split('-')[1];
            const header = `${index + 1}: ${events.length} ${name}\n`;
            const body = events.join('\n');
            return header + body;
          })
          .join('\n');
        const header = `Hosting stats for ${startDate.format('YYYY MMMM')}`;
        const result = `${header}
          
        ${formattedResult}
        
        Total: ${total}
                  `;
        await withDiscordAttachment(header, result, async (attachmentArgs) => {
          await interaction.editReply({
            ...attachmentArgs,
            content: 'Check the results in the attachment!',
          });
        });
      });
    });
  }
}
