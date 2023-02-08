import dayjs from 'dayjs';
import { ApplicationCommandOptionType, CommandInteraction } from 'discord.js';
import { Discord, Slash, SlashOption } from 'discordx';
import { Logger } from 'tslog';
import { GetPastEventsResponse } from '../../lib/client/meetup/types';

import { discordCommandWrapper } from '../../util/discord';
import { withMeetupClient } from '../../util/meetup';

const logger = new Logger({ name: 'MeetupGetStatsCommands' });

const PAGINATION_SIZE = 100;

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
      description: 'The month to filter to',
      type: ApplicationCommandOptionType.Number,
      minValue: 1,
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
        const startOfMonth = dayjs()
          .set('year', year)
          .set('month', month - 1)
          .startOf('month');
        const endOfMonth = startOfMonth.endOf('month');
        let cursor: string | undefined;
        let pastEvents: GetPastEventsResponse | undefined;
        const counter = new Map<string, number>();
        do {
          // eslint-disable-next-line no-await-in-loop
          pastEvents = await meetupClient.getPastEvents({
            after: cursor,
            first: PAGINATION_SIZE,
          });
          cursor = pastEvents.groupByUrlname.pastEvents.pageInfo.endCursor;
          pastEvents.groupByUrlname.pastEvents.edges.forEach((event) => {
            const { host } = event.node;
            const eventDate = dayjs(event.node.dateTime);
            const wasEventLastMonth =
              startOfMonth.isBefore(eventDate) && endOfMonth.isAfter(eventDate);
            if (!host || !wasEventLastMonth) {
              logger.info(`Skipping ${JSON.stringify(event)}`);
              return;
            }
            const key = `${host.id}-${host.name}`;
            if (!counter.has(key)) {
              counter.set(key, 0);
            }
            counter.set(key, counter.get(key) + 1);
          });
        } while (pastEvents?.groupByUrlname.pastEvents.pageInfo.hasNextPage);

        const total = Array.from(counter.values()).reduce(
          (sum, current) => sum + current,
          0
        );
        const formattedResult = Array.from(counter.entries())
          .map((entry: [string, number]) => [entry[1], entry[0].split('-')[1]])
          .sort(
            (entry1: [number, string], entry2: [number, string]) =>
              entry1[0] - entry2[0]
          )
          .reverse()
          .map(
            (entry: [number, string], index: number) =>
              `${index + 1}: ${entry[1]} ${entry[0]}`
          )
          .join('\n');
        await interaction.editReply({
          content: `Hosting stats for ${startOfMonth.format('YYYY MMMM')}
          
${formattedResult}

Total: ${total}
          `,
        });
      });
    });
  }
}
