import {
  ActionRowBuilder,
  CommandInteraction,
  MessageActionRowComponentBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuInteraction,
} from 'discord.js';
import { Discord, SelectMenuComponent, Slash } from 'discordx';
import { Logger } from 'tslog';
import Configuration from '../../configuration';
import { getPaginatedData } from '../../lib/client/meetup/paginationHelper';

import { discordCommandWrapper } from '../../util/discord';
import { withMeetupClient } from '../../util/meetup';

const logger = new Logger({ name: 'MeetupGetUnannouncedEventsCommands' });

@Discord()
export class MeetupGetUnannouncedEventsCommands {
  @SelectMenuComponent({ id: 'unannounced-menu' })
  async unannouncedEventSelectHandler(
    interaction: StringSelectMenuInteraction
  ): Promise<void> {
    // extract selected value
    const eventUrl = interaction.values?.[0];
    logger.info(`Selected event by ${interaction.user.id}: ${eventUrl}`);

    await interaction.followUp({
      content: `Requesting announcement for event ${eventUrl} by ${interaction.user.toString()}`,
    });
  }

  @Slash({
    name: 'meetup_get_unannounced_events',
    description: `Getting list of unannounced events. Output is private.`,
  })
  async meetupGetUnannouncedEventsHandler(interaction: CommandInteraction) {
    await discordCommandWrapper(interaction, async () => {
      await withMeetupClient(interaction, async (meetupClient) => {
        await interaction.editReply({
          content: 'Sit tight! Fetching data.',
        });
        logger.info(`Getting unannounced events for: ${interaction.user.id}`);

        const getUserHostedEvents = await getPaginatedData(
          async (paginationInput) => {
            const result = await meetupClient.getUserHostedEvents(
              paginationInput
            );
            return result.self.hostedEvents;
          }
        );
        const filteredEvents = getUserHostedEvents
          .filter(
            (event) =>
              event.group.id === Configuration.meetup.groupId &&
              event.uiActions.canAnnounce
          )
          .slice(0, 5);
        const selectMenuOptions = filteredEvents.map((event, index) => ({
          label: `#${index + 1}: ${event.title}`,
          description: event.dateTime,
          value: event.eventUrl,
        }));

        const selectMenu = new StringSelectMenuBuilder()
          .addOptions(selectMenuOptions)
          .setCustomId('unannounced-menu');

        const buttonRow =
          new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
            selectMenu
          );

        logger.info(
          `Unannounced events for ${interaction.user.id} are: ${JSON.stringify(
            filteredEvents
          )}}`
        );

        if (filteredEvents.length === 0) {
          await interaction.editReply({
            content: 'You have no unannounced events.',
          });
          return;
        }
        await interaction.editReply({
          components: [buttonRow],
          content: 'Select the event you want to get announced:',
        });
      });
    });
  }
}
