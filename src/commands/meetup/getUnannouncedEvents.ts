import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonInteraction,
  ButtonStyle,
  CommandInteraction,
  MessageActionRowComponentBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuInteraction,
} from 'discord.js';
import { ButtonComponent, Discord, SelectMenuComponent, Slash } from 'discordx';
import { Logger } from 'tslog';
import Configuration from '../../configuration';
import { getPaginatedData } from '../../lib/client/meetup/paginationHelper';

import { discordCommandWrapper } from '../../util/discord';
import { withMeetupClient } from '../../util/meetup';

const logger = new Logger({ name: 'MeetupGetUnannouncedEventsCommands' });

const EVENT_LINK_PREFIX = 'Event link: ';

@Discord()
export class MeetupGetUnannouncedEventsCommands {
  @ButtonComponent({ id: 'request-announcement-button' })
  async requestAnnouncementButtonHandler(interaction: ButtonInteraction) {
    await discordCommandWrapper(interaction, async () => {
      if (!interaction.message.content.includes(EVENT_LINK_PREFIX)) {
        await interaction.editReply({
          content: `This message doesn't contain an event link`,
        });
        logger.info(
          `No event link found in message of ${interaction.user.id}. Message: ${interaction.message.content}`
        );
        return;
      }

      const [, ...requestInfo] = interaction.message.content.split('\n');
      const eventUrl = requestInfo[0].replace(EVENT_LINK_PREFIX, '');
      logger.info(
        `Requesting announcement for event ${eventUrl} by ${interaction.user.id}`
      );

      await interaction.followUp({
        content: `Requesting announcement for event ${eventUrl} by ${interaction.user.toString()}`,
      });
      await interaction.deleteReply();
    });
  }

  @SelectMenuComponent({ id: 'unannounced-menu' })
  async unannouncedEventSelectHandler(
    interaction: StringSelectMenuInteraction
  ): Promise<void> {
    // extract selected value
    const eventUrl = interaction.values?.[0];
    logger.info(`Selected event by ${interaction.user.id}: ${eventUrl}`);

    const messageContentWithoutLink = interaction.message.content
      .split('\n')
      .filter((line) => !line.includes(EVENT_LINK_PREFIX));

    const messageContent = messageContentWithoutLink;
    if (eventUrl !== 'none') {
      messageContent.push(EVENT_LINK_PREFIX + eventUrl);
    }

    // update message
    const message = await interaction.message.fetch();
    await message.edit({
      content: messageContent.join('\n'),
      components: message.components,
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
          label: `#${index + 1}: ${event.dateTime}`,
          description: event.title.slice(0, 20),
          value: event.eventUrl,
        }));

        const selectMenu = new StringSelectMenuBuilder()
          .addOptions(selectMenuOptions)
          .setCustomId('unannounced-menu');

        const requestAnnounceButton = new ButtonBuilder()
          .setLabel('Request Announcement')
          .setEmoji('📢')
          .setStyle(ButtonStyle.Primary)
          .setCustomId('request-announcement-button');

        const buttonRow =
          new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
            selectMenu
            // requestAnnounceButton
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
