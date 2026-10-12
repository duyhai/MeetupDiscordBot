import {
  ButtonInteraction,
  Channel,
  CommandInteraction,
  NonThreadGuildBasedChannel,
} from 'discord.js';
import { Logger } from 'tslog';

import { GET_VERIFIED_CHANNEL_ID, SERVER_ROLES } from '../../constants.js';

const logger = new Logger({ name: 'channelHelper' });

const strings = {
  replyAddedToChannel: (channel: Channel) =>
    `You have been added to ${channel.toString()}. Have fun!`,
  replyFinishVerifyingFirst:
    `This is for verified members only. Please link your Meetup account in ` +
    `<#${GET_VERIFIED_CHANNEL_ID}> first, then try again.`,
};

/**
 * Opts the member into a channel with a per-user ViewChannel overwrite.
 *
 * Verified members only. A per-user allow beats the Onboarding role's
 * channel denies, so granting one to someone still in Onboarding lets them
 * into a private channel before they have verified (happened 2026-10-12).
 * "Verified" is the same test the rest of the bot uses: not holding the
 * Onboarding role. Reverify-tagged members pass until enforcement moves them
 * into Onboarding.
 */
export async function addToChannel(
  interaction: CommandInteraction | ButtonInteraction,
  channelId: string,
) {
  const { user, guild } = interaction;
  logger.info(
    `User ${user.username} is being added to channel with ID: ${channelId}`,
  );

  // Fetched fresh: the gate must not pass on a cached member whose roles
  // have changed. A failed fetch throws, so nobody is added unchecked.
  const member = await guild.members.fetch({ user: user.id, force: true });
  if (member.roles.cache.has(SERVER_ROLES.onboarding)) {
    logger.warn(
      `User ${user.username} is still onboarding; not added to channel with ID: ${channelId}`,
    );
    await interaction.followUp({
      content: strings.replyFinishVerifyingFirst,
      ephemeral: true,
    });
    return;
  }

  const channel = (await guild.channels.fetch(
    channelId,
  )) as NonThreadGuildBasedChannel;

  await channel.permissionOverwrites.create(user.id, {
    ViewChannel: true,
  });

  logger.info(`User ${user.username} is added to ${channel.name}`);
  await interaction.followUp({
    content: strings.replyAddedToChannel(channel),
    ephemeral: true,
  });
}
