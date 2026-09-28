import {
  ApplicationCommandOptionType,
  CommandInteraction,
  PermissionFlagsBits,
} from 'discord.js';
import { Discord, Slash, SlashOption } from 'discordx';
import { Logger } from 'tslog';

import { logActivity } from '../../lib/helpers/discordLogger.js';
import { utcDateOnly } from '../../lib/helpers/suspensionList.js';
import { voidSuspension } from '../../lib/helpers/voidSuspension.js';
import { PostgresSuspensionRepository } from '../../lib/repositories/postgresSuspensionRepository.js';
import {
  discordCommandWrapper,
  markActivityLogged,
  requireModOrOrganizer,
} from '../../util/discord.js';

const logger = new Logger({ name: 'MeetupVoidSuspensionCommands' });

@Discord()
export class MeetupVoidSuspensionCommands {
  @Slash({
    name: 'meetup_void_suspension',
    description:
      'Void a wrongly recorded suspension by its #ID. The record is kept for audit. Output is private.',
    // Hides the command from members without mod permissions; the role check
    // inside the handler stays authoritative.
    defaultMemberPermissions: PermissionFlagsBits.ModerateMembers,
  })
  async voidSuspensionHandler(
    @SlashOption({
      name: 'id',
      description: 'The record ID shown as #ID in /meetup_list_suspensions.',
      type: ApplicationCommandOptionType.Integer,
      required: true,
      minValue: 1,
    })
    id: number,
    @SlashOption({
      name: 'reason',
      description: 'Why the record is being voided. Kept with the record.',
      type: ApplicationCommandOptionType.String,
      required: true,
      // Fits an embed field value (1024) in the activity log with room to spare.
      maxLength: 500,
    })
    reason: string,
    interaction: CommandInteraction,
  ) {
    await discordCommandWrapper(interaction, async () => {
      await requireModOrOrganizer(
        interaction,
        'Only moderators and organizers can void suspensions.',
      );
      const repo = await PostgresSuspensionRepository.instance();
      const { record, reply } = await voidSuspension(
        repo,
        id,
        interaction.user.id,
        reason,
      );
      logger.info(
        `${interaction.user.username} voided suspension #${record.id} (member ${record.memberId}): ${record.voidReason}`,
      );
      await logActivity(interaction.client, {
        title: 'Suspension record voided',
        description: `${interaction.user.toString()} voided suspension #${record.id}.`,
        fields: [
          {
            name: 'Member',
            value: `${record.memberId}${
              record.memberName ? ` (${record.memberName})` : ''
            }`,
          },
          {
            name: 'Suspension',
            value: `${record.durationDays} days from ${utcDateOnly(
              record.suspendedAt,
            )}`,
          },
          { name: 'Reason', value: record.voidReason },
        ],
      });
      markActivityLogged(interaction);
      await interaction.followUp({ content: reply, ephemeral: true });
    });
  }
}
