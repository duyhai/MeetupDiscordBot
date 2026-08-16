import dayjs from 'dayjs';
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

import { generateOAuthUrl, RewardRoleLevels } from '../../constants.js';
import { Tokens } from '../../lib/client/discord/types.js';
import { DiscordUserClient } from '../../lib/client/discord/userClient.js';
import { GqlMeetupClient } from '../../lib/client/meetup/gqlClient.js';
import { createOAuthState } from '../../lib/client/oauth/state.js';
import { getBadgeCounts } from '../../lib/helpers/badgeCounts.js';
import { recordMeetupLink } from '../../lib/helpers/memberLink.js';
import {
  addRewardRole,
  onboardUserCommon,
  removeRewardRole,
} from '../../lib/helpers/onboardUser.js';
import { logActivity } from '../../lib/helpers/discordLogger.js';
import { waitForOAuthTokens } from '../../lib/helpers/oauthWait.js';
import { ApplicationCache } from '../../util/cache.js';
import { discordCommandWrapper } from '../../util/discord.js';

const logger = new Logger({ name: 'MeetupSyncAccount' });

const SYNC_ACCOUNT_BUTTON_ID = 'sync_meetup_account_v2';

const OAUTH_HOP_TIMEOUT_MS = 3 * 60 * 1000;

const strings = {
  notFinished: (hop: string) =>
    `You haven't finished connecting yet — you still need to authorize ` +
    `**${hop}**. Once you've done both, press **Link Meetup Account** again ` +
    `and it'll pick up right where you left off (your authorizations are ` +
    `remembered for hours).`,
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
        syncAccountButton,
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
          `Tokens are not present for ${interaction.user.username} at ${meetupTokenKey} or ${discordTokenKey}. Getting token through OAuth`,
        );
        // Discord-first flow: the Meetup hop stays locked until the Discord
        // callback proves this state's owner is the one walking the flow.
        const state = await createOAuthState(interaction.user.id, {
          requiresDiscordVerification: true,
        });
        const oauthUrl = generateOAuthUrl('discord', { state });
        const connectButton = new ButtonBuilder()
          .setLabel('Connect Discord + Meetup')
          .setEmoji('🧲')
          .setStyle(ButtonStyle.Link)
          .setURL(oauthUrl);
        const row =
          new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
            connectButton,
          );
        await interaction.editReply({
          content: 'Please connect your Discord and Meetup accounts:',
          components: [row],
        });
        // Generous window: on iOS the flow hands off from Discord's in-app
        // browser to Safari, where the user may have to sign in to Discord,
        // consent, then sign in to Meetup. The interaction token lasts ~15
        // minutes, so this fits well inside the budget.
        const waitResult = await waitForOAuthTokens(
          (key) => cache.get(key),
          { discordKey: discordTokenKey, meetupKey: meetupTokenKey },
          { timeoutMs: OAUTH_HOP_TIMEOUT_MS, intervalMs: 1000 },
        );
        if (waitResult.status === 'pending') {
          // Not a failure: the tokens outlive this interaction, so pressing
          // the button again after authorizing completes instantly. Reported
          // as activity so the alerts channel stays reserved for faults.
          logger.info(
            `${interaction.user.username} has not finished the ${waitResult.pendingHop} hop yet`,
          );
          await logActivity(interaction.client, {
            title: 'Onboarding not finished yet',
            description: `${interaction.user.toString()} still needs to authorize **${waitResult.pendingHop}**.`,
          });
          await interaction.editReply({
            content: strings.notFinished(waitResult.pendingHop),
            components: [],
          });
          return;
        }
        rawDiscordTokens = waitResult.rawDiscordTokens;
        rawMeetupTokens = waitResult.rawMeetupTokens;
      }
      const discordTokens = JSON.parse(rawDiscordTokens) as Tokens;
      const meetupTokens = JSON.parse(rawMeetupTokens) as Tokens;
      const discordClient = new DiscordUserClient(discordTokens);
      const meetupClient = new GqlMeetupClient(meetupTokens.accessToken);

      const userInfo = await meetupClient.getUserInfo();
      const membershipInfo = await meetupClient.getUserMembershipInfo();

      const isMeetupGroupMember = membershipInfo.groupByUrlname.isMember;

      if (!isMeetupGroupMember) {
        await cache.remove(discordTokenKey);
        await cache.remove(meetupTokenKey);
        logger.warn(
          `Non-member user failed to onboard: ${interaction.user.username}. 
            Membership info: ${JSON.stringify(membershipInfo)}`,
        );
        throw new Error(
          `You're not a member on Meetup. Please join the group and try onboarding again`,
        );
      }

      await recordMeetupLink(
        interaction,
        {
          meetupId: userInfo.self.id,
          meetupName: userInfo.self.name,
          meetupMemberUrl: userInfo.self.memberUrl,
        },
        'sync_v2',
      );

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

      const { user: cachedUser, guild } = interaction;

      await onboardUserCommon(
        interaction,
        cachedUser.id,
        userInfo.self.gender,
        cleanedName,
      );

      logger.info(`Getting badges for ${interaction.user.username}`);
      await interaction.editReply({
        content: 'Sit tight! Fetching data.',
      });

      const { hostedCount, attendedCount } = await getBadgeCounts(meetupClient);
      logger.info(JSON.stringify({ hostedCount, attendedCount }));

      const levels: RewardRoleLevels[] = [500, 100, 50, 20, 5, 1];
      const hostingRewards = levels.find((num) => hostedCount >= num);
      const attendanceRewards = levels.find((num) => attendedCount >= num);
      logger.info(JSON.stringify({ hostingRewards, attendanceRewards }));

      await removeRewardRole(guild, cachedUser.id, 'hosting');
      await removeRewardRole(guild, cachedUser.id, 'attendance');

      await addRewardRole(guild, cachedUser.id, 'hosting', hostingRewards);
      await addRewardRole(
        guild,
        cachedUser.id,
        'attendance',
        attendanceRewards,
      );

      await discordClient.pushMetadata({
        platform_name: '1.5 Meetup Bot',
        platform_username: `${userInfo.self.name}`,
        metadata: {
          is_member: membershipInfo.groupByUrlname.isMember ? '1' : '0',
          is_organizer:
            membershipInfo.groupByUrlname.membershipMetadata.status === 'LEADER'
              ? '1'
              : '0',
          member_since: dayjs(
            membershipInfo.groupByUrlname.membershipMetadata.joinTime,
          ).format('YYYY-MM-DD'),
          events_attended: attendedCount.toString(),
          events_hosted: hostedCount.toString(),
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
        `Creating sync account button on behalf of ${interaction.user.username}`,
      );

      const replyContent = [
        `__**Gaining full access to the server with Meetup verification**__\n`,
        `We are restricting access to most of our chat rooms by default. \
Those are only available for verified Meetup group members. Please read the verification instructions carefully below :slight_smile:\n`,
        `We integrated our Discord bot with the Meetup API in order to automatically verify member status with Meetup.`,
        `Please click the button below to link your Meetup account. This will:\n`,
        `- Onboard you to the Discord server if you're part of the 1.5 Gen Asian Meetup group.`,
        `- Assign you special roles if applicable (eg: Guest Host, Organizer, etc)`,
        `- Adds you to the Ladies or Gents Lounge based on the gender in your Meetup profile`,
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
