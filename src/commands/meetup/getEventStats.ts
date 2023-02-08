import dayjs from 'dayjs';
import { CommandInteraction } from 'discord.js';
import { Discord, Slash } from 'discordx';
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
  async meetupGetStatsHandler(interaction: CommandInteraction) {
    await discordCommandWrapper(interaction, async () => {
      await withMeetupClient(interaction, async (meetupClient) => {
        logger.info('Getting data');
        const startOfLastMonth = dayjs().subtract(1, 'month').startOf('month');
        const endOfLastMonth = startOfLastMonth.endOf('month');
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
              startOfLastMonth.isBefore(eventDate) &&
              endOfLastMonth.isAfter(eventDate);
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

        await interaction.editReply({
          content: JSON.stringify(Array.from(counter.entries())),
        });
      });
    });
  }
}
