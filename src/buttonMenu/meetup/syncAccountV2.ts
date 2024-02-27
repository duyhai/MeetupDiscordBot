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

import { DISCORD_BOT_URL, RewardRoleLevels } from '../../constants';
import { DiscordRestClient } from '../../lib/client/discord/client';
import { Tokens } from '../../lib/client/discord/types';
import { GqlMeetupClient } from '../../lib/client/meetup/gqlClient';
import { getPaginatedData } from '../../lib/client/meetup/paginationHelper';
import {
  addRewardRole,
  addServerRole,
  removeRewardRole,
  removeServerRole,
} from '../../lib/helpers/onboardUser';
import { ApplicationCache } from '../../util/cache';
import { discordCommandWrapper, isAdmin } from '../../util/discord';
import { spinWait } from '../../util/spinWait';

const logger = new Logger({ name: 'MeetupSyncAccount' });

const SYNC_ACCOUNT_BUTTON_ID = 'sync_meetup_account';

const strings = {
  invisibleCharacter: ' ',
};

@Discord()
export class MeetupSyncAccountCommandsV2 {
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
      const cache = await ApplicationCache();
      const discordTokenKey = `${interaction.user.id}-discord-tokens`;
      const meetupTokenKey = `${interaction.user.id}-meetup-tokens`;
      let rawDiscordTokens = await cache.get(discordTokenKey);
      let rawMeetupTokens = await cache.get(meetupTokenKey);
      if (!rawMeetupTokens || !rawDiscordTokens) {
        logger.info(
          `Tokens are not present for ${interaction.user.username} at ${meetupTokenKey} or ${discordTokenKey}. Getting token through OAuth`
        );
        await interaction.editReply({
          content: `Please click on this link to connect your Discord and Meetup account: <${DISCORD_BOT_URL}/discord-meetup-connect>`,
        });
        rawDiscordTokens = await spinWait(() => cache.get(discordTokenKey), {
          timeoutMs: 60 * 1000,
          message:
            'Timeout waiting for Discord authentication. Please try again',
          intervalMs: 1000,
        });
        rawMeetupTokens = await spinWait(() => cache.get(meetupTokenKey), {
          timeoutMs: 60 * 1000,
          message:
            'Timeout waiting for Meetup authentication. Please try again',
          intervalMs: 1000,
        });
      }
      const discordTokens = JSON.parse(rawDiscordTokens) as Tokens;
      const meetupTokens = JSON.parse(rawMeetupTokens) as Tokens;
      const discordClient = new DiscordRestClient(discordTokens);
      const meetupClient = new GqlMeetupClient(meetupTokens.accessToken);

      const userInfo = await meetupClient.getUserInfo();
      const membershipInfo = await meetupClient.getUserMembershipInfo();

      const isMeetupGroupMember = membershipInfo.groupByUrlname.isMember;

      if (!isMeetupGroupMember) {
        logger.warn(
          `Non-member user failed to onboard: ${interaction.user.username}. 
            Membership info: ${JSON.stringify(membershipInfo)}`
        );
        throw new Error(
          `You're not a member on Meetup. Please join the group and try onboarding again`
        );
      }

      const { name } = userInfo.self;
      const cleanedName = name
        .split(' ')
        .map((namePart, index) => {
          if (index === 0) {
            return namePart;
          }
          return `${namePart.at(0)}.`;
        })
        .join(' ');

      const { user: cachedUser, guild, client } = interaction;
      const user = await client.users.fetch(cachedUser.id);
      const fullUsername = user.tag;

      logger.info(`User ${fullUsername} is getting onboarded`);

      const guildMember = await guild.members.fetch(cachedUser.id);
      if (!isAdmin(guildMember)) {
        let targetNickName = cleanedName || guildMember.nickname;
        if (!targetNickName) {
          const { username } = user;
          // Ugly hack because of this:
          // https://github.com/discord/discord-api-docs/issues/667
          targetNickName = Array.from(username).join(
            strings.invisibleCharacter
          );
        }
        await guildMember.setNickname(targetNickName);
        logger.info(
          `Explicitly set ${fullUsername}'s nickname to ${targetNickName}`
        );
      }

      const isFemale = userInfo.self.gender === 'FEMALE';
      if (isFemale) {
        await addServerRole(guild, user.id, 'ladies_lounge');
        logger.info(`User ${fullUsername} added to LadiesLounge`);
      }
      await removeServerRole(guild, user.id, 'onboarding');
      logger.info(`User ${fullUsername} onboarded!`);

      logger.info(`Getting badges for ${interaction.user.username}`);
      await interaction.editReply({
        content: 'Sit tight! Fetching data.',
      });

      const pastEvents = await getPaginatedData(async (paginationInput) => {
        const result = await meetupClient.getPastGroupEvents(paginationInput);
        return result.groupByUrlname.pastEvents;
      });

      const getUserHostedEvents = pastEvents.filter(({ hosts }) =>
        hosts.some(({ id }) => id === userInfo.self.id)
      );
      const getUserAttendedEvents = pastEvents.filter(({ tickets }) =>
        tickets.edges.some(
          ({ node }) =>
            ['YES', 'ATTENDED'].includes(node.status) &&
            node.user.id === userInfo.self.id
        )
      );

      const hostedCount = getUserHostedEvents.length;
      const attendedCount = getUserAttendedEvents.length;
      logger.info(JSON.stringify({ hostedCount, attendedCount }));

      const levels: RewardRoleLevels[] = [500, 100, 50, 20, 5, 1];
      const hostingRewards = levels.find((num) => hostedCount >= num);
      const attendanceRewards = levels.find((num) => attendedCount >= num);
      logger.info(JSON.stringify({ hostingRewards, attendanceRewards }));

      await removeRewardRole(guild, user.id, 'hosting');
      await removeRewardRole(guild, user.id, 'attendance');

      await addRewardRole(guild, user.id, 'hosting', hostingRewards);
      await addRewardRole(guild, user.id, 'attendance', attendanceRewards);

      await discordClient.pushMetadata({
        platform_name: '1.5 Meetup Bot',
        platform_username: `https://www.meetup.com/members/${userInfo.self.id}`,
        metadata: {
          '15member': 'true',
          organizer: 'true',
          membersince:
            membershipInfo.groupByUrlname.membershipMetadata.joinedDate,
          eventsattended: attendedCount,
          eventshosted: hostedCount,
        },
      });

      await interaction.followUp({
        content: `Done`,
        ephemeral: true,
      });
    });
  }

  @Slash({
    name: 'create_sync_account_button_v2',
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
