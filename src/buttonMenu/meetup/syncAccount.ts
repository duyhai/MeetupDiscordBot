import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonInteraction,
  ButtonStyle,
  CommandInteraction,
  MessageActionRowComponentBuilder,
} from 'discord.js';
import { ButtonComponent, Discord, Slash } from 'discordx';
import { Logger } from 'tslog';

import { getBadges } from '../../lib/helpers/getBadges';
import { getUserRoles } from '../../lib/helpers/getUserRoles';
import { selfOnboardUser } from '../../lib/helpers/onboardUser';
import { discordCommandWrapper } from '../../util/discord';
import { withMeetupClient } from '../../util/meetup';

const logger = new Logger({ name: 'MeetupSyncAccount' });

const SYNC_ACCOUNT_BUTTON_ID = 'sync_meetup_account';

@Discord()
export class MeetupSyncAccountCommands {
  syncAccountButton() {
    const syncAccountButton = new ButtonBuilder()
      .setLabel('Link Meetup Account')
      .setEmoji('🔗')
      .setStyle(ButtonStyle.Danger)
      .setCustomId(SYNC_ACCOUNT_BUTTON_ID);

    const buttonRow =
      new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
        syncAccountButton
      );
    return buttonRow;
  }

  @ButtonComponent({ id: SYNC_ACCOUNT_BUTTON_ID })
  async meetupRequestApproveEventHandler(interaction: ButtonInteraction) {
    await discordCommandWrapper(interaction, async () => {
      await withMeetupClient(interaction, async (meetupClient) => {
        await selfOnboardUser(meetupClient, interaction);
        await getUserRoles(meetupClient, interaction);
        await getBadges(meetupClient, interaction);
      });
    });
  }

  @Slash({
    name: 'create_sync_account_button',
    description: `Creates a button that users can use to sync Meetup account`,
  })
  async createSyncAccountButtonHandler(interaction: CommandInteraction) {
    await discordCommandWrapper(interaction, async () => {
      logger.info(
        `Creating sync account button on behalf of ${interaction.user.username}`
      );

      const replyContent = [
        `__**Gaining full access with verification**__\n`,
        `We are restricting access to most of our chat rooms by default. \
Those are only available for verified Meetup group members. Please read the verification instructions carefully below :slight_smile:\n`,
        `We integrated our Discord bot with the Meetup API in order to automatically verify member status with Meetup.`,
        `Please click the button below to link your Meetup account. This will:\n`,
        `- Onboard you to the Discord server if you're part of the 1.5 Gen Asian Meetup group.`,
        `- Assign you special roles if applicable (eg: Guest Host, Organizer, etc)`,
        `- Rewards you with Discord badges based on your Meetup activity\n`,
        `You can use this button to refresh your data in the future as well (eg: to get better badges).`,
      ];
      await interaction.channel.send({
        content: replyContent.join('\n'),
        components: [this.syncAccountButton()],
      });
      logger.info(`Created sync account button`);
    });
  }
}
