import {
  ApplicationCommandType,
  MessageContextMenuCommandInteraction,
} from 'discord.js';
import { ContextMenu, Discord } from 'discordx';
import { Logger } from 'tslog';

import { discordCommandWrapper } from '../../util/discord';
import { withMeetupClient } from '../../util/meetup';

const logger = new Logger({ name: 'MeetupAnnounceEventContextCommands' });

function getMeetupEventId(text: string): string | null {
  const pattern = /meetup\.com\/[^/]+\/events\/(\d+)/;
  const match = text.match(pattern);
  return match ? match[1] : null;
}

@Discord()
export class MeetupAnnounceEventContextCommands {
  @ContextMenu({
    name: 'meetup_announce_event',
    type: ApplicationCommandType.Message,
  })
  async meetupAnnounceEventHandler(
    interaction: MessageContextMenuCommandInteraction
  ) {
    await discordCommandWrapper(interaction, async () => {
      await withMeetupClient(interaction, async (meetupClient) => {
        const { targetMessage } = interaction;
        const { content } = targetMessage;

        const eventId = getMeetupEventId(content);
        if (!eventId) {
          logger.error('No event link found in message');
          throw new Error('No event link found in message');
        }

        await meetupClient.announceEvent({ eventId });
        logger.info(`Announced event ${eventId}`);

        await interaction.followUp({
          content: `Announced event! ✅`,
          ephemeral: true,
        });
        await targetMessage.react('✅');
      });
    });
  }
}
