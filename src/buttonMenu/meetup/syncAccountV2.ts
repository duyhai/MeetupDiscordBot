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
import { getPaginatedData } from '../../lib/client/meetup/paginationHelper.js';
import { createOAuthState } from '../../lib/client/oauth/state.js';
import {
  countAttendedEvents,
  countHostedEvents,
} from '../../lib/helpers/eventStats.js';
import { recordMeetupLink } from '../../lib/helpers/memberLink.js';
import {
  addRewardRole,
  onboardUserCommon,
  removeRewardRole,
} from '../../lib/helpers/onboardUser.js';
import { replyStack } from '../../lib/messageStack/registry.js';
import { EntryId } from '../../lib/messageStack/types.js';
import { ApplicationCache } from '../../util/cache.js';
import { discordCommandWrapper } from '../../util/discord.js';
import { spinWait } from '../../util/spinWait.js';

const logger = new Logger({ name: 'MeetupSyncAccount' });

const SYNC_ACCOUNT_BUTTON_ID = 'sync_meetup_account_v2';

const OAUTH_HOP_TIMEOUT_MS = 3 * 60 * 1000;

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
      // Tracks the single progress entry so later progress updates replace it
      // in place instead of stacking new lines onto the ephemeral message.
      let progressId: EntryId | undefined;
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
        progressId = replyStack(interaction).ephemeral.append({
          content: 'Please connect your Discord and Meetup accounts:',
          components: [row],
          status: 'pending',
        });
        // Generous windows: on iOS the flow hands off from Discord's in-app
        // browser to Safari, where the user may have to sign in to Discord,
        // consent, then sign in to Meetup. The interaction token lasts ~15
        // minutes, so these fit well inside the budget.
        rawDiscordTokens = await spinWait(() => cache.get(discordTokenKey), {
          timeoutMs: OAUTH_HOP_TIMEOUT_MS,
          message:
            'Timeout waiting for Discord authentication. Please try again',
          intervalMs: 1000,
        });
        rawMeetupTokens = await spinWait(() => cache.get(meetupTokenKey), {
          timeoutMs: OAUTH_HOP_TIMEOUT_MS,
          message:
            'Timeout waiting for Meetup authentication. Please try again',
          intervalMs: 1000,
        });
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
      if (progressId) {
        replyStack(interaction).ephemeral.update(progressId, {
          content: 'Sit tight! Fetching data.',
          status: 'pending',
        });
      } else {
        progressId = replyStack(interaction).ephemeral.append({
          content: 'Sit tight! Fetching data.',
          status: 'pending',
        });
      }

      const pastEvents = await getPaginatedData(async (paginationInput) => {
        const result = await meetupClient.getGroupEvents(paginationInput, {
          status: ['PAST'],
        });
        return result.groupByUrlname.events;
      });

      const rsvpsPerEvent = await Promise.all(
        pastEvents.map((event) =>
          getPaginatedData(async (paginationInput) => {
            const result = await meetupClient.getEventRsvps(
              event.id,
              paginationInput,
              {
                rsvpStatus: ['ATTENDED', 'YES'],
              },
            );
            return result.event.rsvps;
          }),
        ),
      );

      const hostedCount = countHostedEvents(pastEvents, userInfo.self.id);
      const attendedCount = countAttendedEvents(
        rsvpsPerEvent,
        userInfo.self.id,
      );
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

      replyStack(interaction).ephemeral.append({
        content: `Done`,
        status: 'success',
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
