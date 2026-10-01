import {
  ApplicationCommandOptionType,
  CommandInteraction,
  PermissionFlagsBits,
} from 'discord.js';
import { Discord, Slash, SlashOption } from 'discordx';
import { Logger } from 'tslog';

import { SERVER_ROLES } from '../../constants.js';
import {
  REVERIFY_ROLE_NAME,
  ensureReverifyRole,
  findReverifyRole,
  selectEnforceTargets,
  selectReverifyTargets,
  startRoleJob,
  toCandidate,
} from '../../lib/helpers/reverify.js';
import {
  discordCommandWrapper,
  logModerationAction,
  requireModOrOrganizer,
} from '../../util/discord.js';
import { ApplicationMemberRepository } from '../../util/memberRepository.js';

const logger = new Logger({ name: 'ReverifyCommands' });

const confirmOption = {
  name: 'confirm',
  description:
    'Leave off to preview the count. Set to true to make the change.',
  type: ApplicationCommandOptionType.Boolean,
  required: false,
} as const;

const busyMessage =
  'Another Reverify job is still running. Its result will post in the staff moderation channel.';

/** Every server member plus the members table, read fresh for each run. */
async function loadMembersAndRecords(interaction: CommandInteraction) {
  const [guildMembers, rows] = await Promise.all([
    interaction.guild.members.fetch(),
    (await ApplicationMemberRepository()).listAll(),
  ]);
  return { candidates: guildMembers.map(toCandidate), rows };
}

@Discord()
export class ReverifyCommands {
  @Slash({
    name: 'meetup_reverify_tag',
    description:
      'Reverify migration: give the Reverify role to verified members with no Meetup link.',
    defaultMemberPermissions: PermissionFlagsBits.ModerateMembers,
  })
  async tagHandler(
    @SlashOption(confirmOption) confirm: boolean | undefined,
    interaction: CommandInteraction,
  ) {
    await discordCommandWrapper(interaction, async () => {
      await requireModOrOrganizer(
        interaction,
        'Only moderators and organizers can run the Reverify migration.',
      );
      const { guild, client, user } = interaction;
      const { candidates, rows } = await loadMembersAndRecords(interaction);
      const existingRole = await findReverifyRole(guild);
      // Re-running after a partial or interrupted job only tags the rest.
      const alreadyTagged = new Set(
        existingRole
          ? candidates
              .filter((candidate) =>
                candidate.roleIds.includes(existingRole.id),
              )
              .map((candidate) => candidate.id)
          : [],
      );
      const targets = selectReverifyTargets(candidates, rows).filter(
        (id) => !alreadyTagged.has(id),
      );

      if (!confirm) {
        await interaction.followUp({
          content:
            `Preview: ${targets.length} verified member(s) with no Meetup link would get the ${REVERIFY_ROLE_NAME} role. ` +
            'Nothing changed. Run again with confirm:true to tag them.',
          ephemeral: true,
        });
        await logModerationAction(interaction, {
          title: 'Reverify tag previewed',
          description: `${user.toString()} previewed tagging ${targets.length} member(s).`,
        });
        return;
      }

      const role = await ensureReverifyRole(guild);
      const started = startRoleJob(
        client,
        'Reverify tagging',
        targets,
        async (memberId) => {
          await guild.members.addRole({
            user: memberId,
            role,
            reason: 'Meetup linking migration: no Meetup link on record',
          });
        },
      );
      logger.info(`Reverify tagging started for ${targets.length} member(s)`);
      await interaction.followUp({
        content: started
          ? `Tagging ${targets.length} member(s) with ${role.toString()} in the background. ` +
            'The result posts in the staff moderation channel.'
          : busyMessage,
        ephemeral: true,
      });
      if (started) {
        await logModerationAction(interaction, {
          title: 'Reverify tagging started',
          description: `${user.toString()} started tagging ${
            targets.length
          } member(s) with ${REVERIFY_ROLE_NAME}.`,
        });
      }
    });
  }

  @Slash({
    name: 'meetup_reverify_enforce',
    description:
      'Reverify deadline: move everyone still holding Reverify back to Onboarding.',
    defaultMemberPermissions: PermissionFlagsBits.ModerateMembers,
  })
  async enforceHandler(
    @SlashOption(confirmOption) confirm: boolean | undefined,
    interaction: CommandInteraction,
  ) {
    await discordCommandWrapper(interaction, async () => {
      await requireModOrOrganizer(
        interaction,
        'Only moderators and organizers can run the Reverify migration.',
      );
      const { guild, client, user } = interaction;
      const role = await findReverifyRole(guild);
      if (!role) {
        throw new Error(
          `There's no ${REVERIFY_ROLE_NAME} role, so there's nobody to enforce on. Run /meetup_reverify_tag first.`,
        );
      }
      const { candidates, rows } = await loadMembersAndRecords(interaction);
      const targets = selectEnforceTargets(candidates, rows, role.id);

      if (!confirm) {
        await interaction.followUp({
          content:
            `Preview: ${targets.length} member(s) still holding ${REVERIFY_ROLE_NAME} would lose channel access ` +
            '(moved back to Onboarding). Nothing changed. Run again with confirm:true on deadline day.',
          ephemeral: true,
        });
        await logModerationAction(interaction, {
          title: 'Reverify enforcement previewed',
          description: `${user.toString()} previewed enforcement on ${targets.length} member(s).`,
        });
        return;
      }

      const started = startRoleJob(
        client,
        'Reverify enforcement',
        targets,
        async (memberId) => {
          await guild.members.addRole({
            user: memberId,
            role: SERVER_ROLES.onboarding,
            reason: 'Meetup linking deadline passed without a link',
          });
          await guild.members.removeRole({
            user: memberId,
            role,
            reason: 'Moved to Onboarding at the linking deadline',
          });
        },
      );
      logger.info(
        `Reverify enforcement started for ${targets.length} member(s)`,
      );
      await interaction.followUp({
        content: started
          ? `Moving ${targets.length} member(s) to Onboarding in the background. The result posts in the staff moderation channel.`
          : busyMessage,
        ephemeral: true,
      });
      if (started) {
        await logModerationAction(interaction, {
          title: 'Reverify enforcement started',
          description: `${user.toString()} started moving ${targets.length} member(s) to Onboarding.`,
        });
      }
    });
  }
}
