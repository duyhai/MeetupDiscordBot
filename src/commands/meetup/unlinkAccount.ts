import {
  ApplicationCommandOptionType,
  CommandInteraction,
  PermissionFlagsBits,
  User,
} from 'discord.js';
import { Discord, Slash, SlashOption } from 'discordx';
import { Logger } from 'tslog';

import { logActivity } from '../../lib/helpers/discordLogger.js';
import {
  discordCommandWrapper,
  hasAnyServerRole,
  isAdmin,
} from '../../util/discord.js';
import { ApplicationMemberRepository } from '../../util/memberRepository.js';

const logger = new Logger({ name: 'UnlinkAccountCommands' });

const strings = {
  notAllowed: 'Only moderators and organizers can unlink accounts.',
  noRow: (user: User) => `${user.toString()} has no member record to unlink.`,
  done: (user: User) =>
    `Unlinked ${user.toString()}. They can re-link via the Get Verified button.`,
};

@Discord()
export class UnlinkAccountCommands {
  @Slash({
    name: 'meetup_unlink',
    description: "Remove a member's stored Meetup link (mods/organizers only)",
    // Hides the command from members without mod permissions; the role check
    // inside the handler stays authoritative. Guild admins can re-grant
    // visibility per role under Server Settings → Integrations.
    defaultMemberPermissions: PermissionFlagsBits.ModerateMembers,
  })
  async meetupUnlinkHandler(
    @SlashOption({
      name: 'user',
      description: 'The Discord user to unlink',
      type: ApplicationCommandOptionType.User,
      required: true,
    })
    user: User,
    interaction: CommandInteraction,
  ) {
    await discordCommandWrapper(interaction, async () => {
      const member = await interaction.guild.members.fetch(interaction.user.id);
      if (
        !isAdmin(member) &&
        !hasAnyServerRole(member, ['moderator', 'organizer'])
      ) {
        throw new Error(strings.notAllowed);
      }

      const repo = await ApplicationMemberRepository();
      const row = await repo.findByDiscordId(user.id);
      if (!row) {
        await interaction.followUp({
          content: strings.noRow(user),
          ephemeral: true,
        });
        return;
      }

      await repo.remove(user.id);
      logger.info(
        `${interaction.user.username} unlinked member record for ${user.username}`,
      );
      await logActivity(interaction.client, {
        title: 'Member record unlinked',
        description: `${interaction.user.toString()} removed the stored link for ${user.toString()}.`,
        fields: [
          { name: 'Meetup ID', value: row.meetupId ?? 'none (manual row)' },
        ],
      });
      await interaction.followUp({
        content: strings.done(user),
        ephemeral: true,
      });
    });
  }
}
