import {
  ActionRowBuilder,
  ApplicationCommandOptionType,
  ButtonBuilder,
  ButtonInteraction,
  ButtonStyle,
  CommandInteraction,
  MessageActionRowComponentBuilder,
} from 'discord.js';
import { ButtonComponent, Discord, Slash, SlashOption } from 'discordx';
import { Logger } from 'tslog';

import { discordCommandWrapper } from '../../util/discord';
import { withMeetupClient } from '../../util/meetup';
import { dateChecker, stringToDate } from '../../util/strings';

const logger = new Logger({ name: 'MeetupCreateEventCommands' });

const TITLE_MAX_LENGTH = 80;
const GUEST_HOST_PREFIX = '[Guest Host] ';

interface EventRequest {
  eventDate: Date;
  eventTitle: string;
  meetupUserId: string;
}

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
    await discordCommandWrapper(interaction, async () => {
      await withMeetupClient(interaction, async (meetupClient) => {
        const membershipInfo = await meetupClient.getUserMembershipInfo();
        if (!membershipInfo.groupByUrlname.isOrganizer) {
          throw new Error(
            `You don't have permission to do this, silly. You're not an organizer`
          );
        }

        const message = await interaction.message.fetch();
        const newButtons = this.getRequestEventButtons();
        newButtons.components.forEach((btn) => btn.setDisabled(true));
        await message.edit({
          content: `${interaction.message.content}\nApproved request.`,
          components: [newButtons],
        });

        await interaction.editReply(
          'Successfully connected to Meetup. You can dismiss this message.'
        );
      });
    });
  }

  @ButtonComponent({ id: 'deny' })
  async meetupRequestDenyEventHandler(interaction: ButtonInteraction) {
    await discordCommandWrapper(interaction, async () => {
      await withMeetupClient(interaction, async (meetupClient) => {
        const membershipInfo = await meetupClient.getUserMembershipInfo();
        if (!membershipInfo.groupByUrlname.isOrganizer) {
          throw new Error(
            `You don't have permission to do this, silly. You're not an organizer`
          );
        }

        const message = await interaction.message.fetch();
        const newButtons = this.getRequestEventButtons();
        newButtons.components.forEach((btn) => btn.setDisabled(true));
        await message.edit({
          content: `${interaction.message.content}\nDenied request.`,
          components: [newButtons],
        });
        await interaction.reply({ ephemeral: true, content: ':-1:' });
      });
    });
  }

  @Slash({
    name: 'meetup_request_event',
    description: `Requesting the creation of a Meetup event from the Leadership Team. Output is public.`,
  })
  async meetupRequestEventHandler(
    @SlashOption({
      name: 'date',
      description: 'Date in the format of 2023/12/01',
      type: ApplicationCommandOptionType.String,
      required: true,
    })
    date: string,
    @SlashOption({
      name: 'title',
      description: 'Title for the event you want to host',
      type: ApplicationCommandOptionType.String,
      required: true,
      maxLength: TITLE_MAX_LENGTH - GUEST_HOST_PREFIX.length,
    })
    title: string,
    interaction: CommandInteraction
  ) {
    await discordCommandWrapper(interaction, async () => {
      if (!dateChecker(date)) {
        throw new Error(
          'Invalid date. Please make sure your date has the format of YYYY/MM/DD and has valid values before trying again.'
        );
      }
      if (title.includes('\n')) {
        throw new Error(
          'Invalid title. Please make sure it has no new line characters before trying again.'
        );
      }

      await withMeetupClient(interaction, async (meetupClient) => {
        logger.info(`User requested event: ${interaction.user.username}`);

        const userInfo = await meetupClient.getUserInfo();
        const eventRequestInfo: EventRequest = {
          meetupUserId: userInfo.self.id,
          eventDate: stringToDate(date),
          eventTitle: title,
        };

        await interaction.editReply(
          'Successfully connected to Meetup. You can dismiss this message.'
        );
        await interaction.followUp({
          content: `${interaction.user.toString()} is requesting the creation of a new Meetup event`,
        });
        await interaction.followUp({
          content: JSON.stringify(eventRequestInfo),
          components: [this.getRequestEventButtons()],
        });
      });
    });
  }
}
