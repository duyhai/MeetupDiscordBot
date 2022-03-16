import {
  ButtonInteraction,
  MessageActionRow,
  MessageContextMenuInteraction,
  MessageSelectMenu,
  SelectMenuInteraction,
} from 'discord.js';
import {
  ButtonComponent, ContextMenu, Discord, Permission, SelectMenuComponent,
} from 'discordx';
import {
  DISCUSSION_CATEGORY_ID,
  DISCUSSION_JOIN_CHANNEL_ID,
  INTEREST_CATEGORY_ID,
  INTEREST_JOIN_CHANNEL_ID,
  LADIES_LOUNGE_ROLE_ID,
  MODERATOR_ROLE_ID,
} from '../../constants';
import { createCustomIdRegexp, createMessageActionRow } from '../../util/createMessageActionRow';

// Onboarding
// - Check their intro and verify by checking their Meetup profile
// - Check that they are members of 1.5 Gen Asian group. If the groups are hidden due to privacy settings, try looking them up in the members list
// - Change nickname to their first name and last name initial if they haven't done so. Eg: Bob M. If they use their full name in the intro, then you can put the full name.
// - Remove Onboarding role from new user
// - Add LadiesLounge role to give access to 👩🏼ladies-lounge if applicable
// - If someone asks to be added to 🌈lgbtq , add them directly. We don't have a role for the channel in order to preserve anonymity.

const PRE_CHECK_BUTTON_ID = 'pre-check-btn';
const LADIES_LOUNGE_BUTTON_ID = 'ladies-lounge-btn';
const CHANNEL_RECOMMENDATION_MENU_ID = 'channel-rec-menu';

@Discord()
export class OnboardUser {
  bomb = undefined;

  @Permission({ id: MODERATOR_ROLE_ID, type: 'ROLE', permission: true })
  @ContextMenu('MESSAGE', 'Onboard')
  async onboardHandler(interaction: MessageContextMenuInteraction) {
    await interaction.reply({
      ephemeral: true,
      content: 'Have you checked the user\'s intro and Meetup profile? Does it check out?',
      components: [createMessageActionRow([{
        label: 'Yes',
        emoji: '✅',
        style: 'PRIMARY',
      },
      {
        label: 'No',
        emoji: '❌',
        style: 'PRIMARY',
      }], PRE_CHECK_BUTTON_ID)],
    });
    console.log(this.bomb);
    this.bomb = interaction.targetMessage.id;
    await (await interaction.channel.messages.fetch(interaction.targetMessage.id)).reply({ content: 'huh?' });
  }

  @ButtonComponent(createCustomIdRegexp(PRE_CHECK_BUTTON_ID))
  async preCheckButton(interaction: ButtonInteraction) {
    switch (interaction.component.label) {
      case 'No':
        await interaction.reply({ ephemeral: true, content: 'Please check and then try onboarding again' });
        break;
      case 'Yes':
        await interaction.reply({
          ephemeral: true,
          content: 'Is the user female? Should we add them to the LadiesLounge?',
          components: [createMessageActionRow([{
            label: 'Yes',
            emoji: '🧔🏼‍♀️',
            style: 'PRIMARY',
          },
          {
            label: 'No',
            emoji: '👨🏼‍🦲',
            style: 'PRIMARY',
          }], LADIES_LOUNGE_BUTTON_ID)],
        });
        break;
      default:
        await interaction.reply({ ephemeral: true, content: 'Invalid answer' });
    }
    console.log(this.bomb);
  }

  @ButtonComponent(createCustomIdRegexp(LADIES_LOUNGE_BUTTON_ID))
  async ladiesLoungeBtn(interaction: ButtonInteraction) {
    const { guild, user: cachedUser } = interaction;
    const user = await guild.members.fetch(cachedUser.id);
    const ladiesRole = await guild.roles.fetch(LADIES_LOUNGE_ROLE_ID);

    if (interaction.component.label === 'Yes') {
      await user.roles.add(ladiesRole);
    }

    const channels = guild.channels.cache.filter(
      (channel) => [DISCUSSION_CATEGORY_ID, INTEREST_CATEGORY_ID].includes(channel.parentId)
                && ![DISCUSSION_JOIN_CHANNEL_ID, INTEREST_JOIN_CHANNEL_ID].includes(channel.id),
    ).map((channel) => ({ label: channel.name, value: channel.id })).slice(0, 24);

    await interaction.reply({
      ephemeral: true,
      content: 'Please select a few channels to recommend to the user!',
      components: [new MessageActionRow().addComponents(new MessageSelectMenu()
        .addOptions(channels)
        .setCustomId(CHANNEL_RECOMMENDATION_MENU_ID))],
    });
  }

  @SelectMenuComponent(CHANNEL_RECOMMENDATION_MENU_ID)
  async channelRecMenu(interaction: SelectMenuInteraction) {
    const channelIds = interaction.values ?? [];
    const recommendations = channelIds.map(
      (id) => interaction.guild.channels.cache.get(id).toString(),
    );
    let welcomeString = 'Welcome to the server!';
    if (recommendations.length > 0) {
      welcomeString += ` Check out some of our interest channels! ${recommendations.join(' ')}`;
    }

    await interaction.deferReply();
    await interaction.followUp({
      content: welcomeString,
    });
  }
}
