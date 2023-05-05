import dayjs from 'dayjs';
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

import { DRAFT_EVENT_TEMPLATE_ID } from '../../constants';
import { createEventTemplate } from '../../templates/createEventTemplate';
import { discordCommandWrapper } from '../../util/discord';
import { withMeetupClient } from '../../util/meetup';

const logger = new Logger({ name: 'MeetupCreateEventCommands' });

const DEFAULT_START_TIME = 19;
const DATE_FORMAT = 'YYYY-MM-DD';
const TITLE_MAX_LENGTH = 80;
const GUEST_HOST_PREFIX = '[Guest Host] ';

@Discord()
export class MeetupCreateEventCommands {
  getRequestEventButtons() {
    const approveButton = new ButtonBuilder()
      .setLabel('Approve')
      .setEmoji('✅')
      .setStyle(ButtonStyle.Success)
      .setCustomId('approve');

    const denyButton = new ButtonBuilder()
      .setLabel('Deny')
      .setEmoji('✖️')
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

        const [, ...requestInfo] = interaction.message.content.split('\n');
        requestInfo.pop();

        const [meetupUserId, eventDate, eventTitle] = requestInfo.map(
          (line) => {
            const key = line.split(': ')[0];
            return line.slice(key.length + 2);
          }
        );

        const draftEventTemplate = await meetupClient.getEvent(
          DRAFT_EVENT_TEMPLATE_ID
        );

        const newEvent = await meetupClient.createEvent({
          ...createEventTemplate,
          description: draftEventTemplate.event.description,
          title: `${GUEST_HOST_PREFIX}${eventTitle}`,
          startDateTime: `${eventDate}T${DEFAULT_START_TIME}:00`,
          eventHosts: [Number(meetupUserId)],
        });

        const eventId = newEvent.createEvent.event.id;
        await meetupClient.closeEventRsvps({ eventId });
        // Have to set this again because close RSVP wipes it out...
        await meetupClient.editEvent({
          eventId,
          rsvpSettings: createEventTemplate.rsvpSettings,
        });

        const message = await interaction.message.fetch();
        const newButtons = this.getRequestEventButtons();
        newButtons.components.forEach((btn) => btn.setDisabled(true));
        await message.edit({
          content: `${
            interaction.message.content
          }\n✅ Request approved by ${interaction.user.toString()}.\nLink to event: <${
            newEvent.createEvent.event.eventUrl
          }>`,
          components: [newButtons],
        });

        await interaction.editReply('✅ Event request approved!');
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
          content: `${
            interaction.message.content
          }\n❌ Request denied by ${interaction.user.toString()}.`,
          components: [newButtons],
        });

        await interaction.editReply('❌ Event request denied!');
      });
    });
  }

  @Slash({
    name: 'meetup_request_event',
    description: `Requesting the creation of a Meetup event from the Leadership Team. Output is public.`,
  })
  async meetupRequestEventHandler(
    @SlashOption({
      name: 'year',
      description: 'Specifiy the year for the event',
      type: ApplicationCommandOptionType.Number,
      required: true,
      minValue: dayjs().year(),
    })
    year: number,
    @SlashOption({
      name: 'month',
      description: 'Specifiy the month for the event',
      type: ApplicationCommandOptionType.Number,
      required: true,
      minValue: 1,
      maxValue: 12,
    })
    month: number,
    @SlashOption({
      name: 'day',
      description: 'Specifiy the day for the event',
      type: ApplicationCommandOptionType.Number,
      required: true,
      minValue: 1,
      maxValue: 31,
    })
    day: number,
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
      const dateObj = dayjs(new Date(year, month - 1, day));
      if (dateObj.isBefore(new Date())) {
        throw new Error('Invalid date. Date cannot be in the past.');
      }
      if (title.includes('\n')) {
        throw new Error(
          'Invalid title. Please make sure it has no new line characters before trying again.'
        );
      }

      await withMeetupClient(interaction, async (meetupClient) => {
        logger.info(`User requested event: ${interaction.user.username}`);

        const userInfo = await meetupClient.getUserInfo();

        await interaction.deleteReply();
        const replyContent = [
          `❗${interaction.user.toString()} is requesting the creation of a new Meetup event.❗`,
          `Meetup User ID: ${userInfo.self.id}`,
          `Event Date: ${dateObj.format(DATE_FORMAT)}`,
          `Event Title: ${title}`,
          `Organizers, please approve or deny below:`,
        ];
        await interaction.followUp({
          content: replyContent.join('\n'),
          components: [this.getRequestEventButtons()],
        });
      });
    });
  }
}
