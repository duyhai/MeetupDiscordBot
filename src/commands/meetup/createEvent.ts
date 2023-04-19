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

import { discordCommandWrapper } from '../../util/discord';
import { withMeetupClient } from '../../util/meetup';

const logger = new Logger({ name: 'MeetupCreateEventCommands' });

@Discord()
export class MeetupCreateEventCommands {
  getRequestEventButtons() {
    const approveButton = new ButtonBuilder()
      .setLabel('Approve')
      .setStyle(ButtonStyle.Success)
      .setCustomId('approve');

    const denyButton = new ButtonBuilder()
      .setLabel('Deny')
      .setStyle(ButtonStyle.Danger)
      .setCustomId('deny');

    const buttonRow =
      new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
        approveButton,
        denyButton
      );
    return buttonRow;
  }

  @ButtonComponent({ id: 'approve' })
  async meetupRequestApproveEventHandler(interaction: ButtonInteraction) {
    const newButtons = this.getRequestEventButtons();
    newButtons.components.forEach((btn) => btn.setDisabled(true));
    await interaction.message.edit({ components: [newButtons] });
    await interaction.reply({ ephemeral: true, content: ':+1:' });
  }

  @ButtonComponent({ id: 'deny' })
  async meetupRequestDenyEventHandler(interaction: ButtonInteraction) {
    const newButtons = this.getRequestEventButtons();
    newButtons.components.forEach((btn) => btn.setDisabled(true));
    await interaction.message.edit({ components: [newButtons] });
    await interaction.reply({ ephemeral: true, content: ':-1:' });
  }

  @Slash({
    name: 'meetup_request_event',
    description: `Requesting the creation of a Meetup event from the Leadership Team. Output is public.`,
  })
  async meetupRequestEventHandler(interaction: CommandInteraction) {
    await discordCommandWrapper(interaction, async () => {
      await withMeetupClient(interaction, async (_meetupClient) => {
        logger.info(`User requested event: ${interaction.user.username}`);

        await interaction.editReply({
          components: [this.getRequestEventButtons()],
        });
      });
    });
  }
}
