import {
  ApplicationCommandOptionType,
  CommandInteraction,
  PermissionFlagsBits,
  User,
} from 'discord.js';
import { Discord, Slash, SlashOption } from 'discordx';
import { Logger } from 'tslog';

import { SERVER_ROLES } from '../../constants.js';
import {
  REVERIFY_ROLE_NAME,
  ensureReverifyRole,
  fetchAllMembers,
  findReverifyRole,
  moveToOnboardingIfStillUnlinked,
  selectEnforceTargets,
  selectReverifyTargets,
  startRoleJob,
  tagIfStillUnlinked,
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

const memberOption = {
  name: 'member',
  description:
    'Only this member, e.g. a test account. Default: everyone eligible.',
  type: ApplicationCommandOptionType.User,
  required: false,
} as const;

const busyMessage =
  'Another Reverify job is still running. Its result will post in the staff moderation channel.';

/** Every server member plus the members table, read fresh for each run. */
async function loadMembersAndRecords(interaction: CommandInteraction) {
  const repo = await ApplicationMemberRepository();
  const [guildMembers, rows] = await Promise.all([
    fetchAllMembers(interaction.guild),
    repo.listAll(),
  ]);
  return { candidates: guildMembers.map(toCandidate), rows, repo };
}

/** A one-account test run: the named member still has to pass the rules. */
function onlyMember(targets: string[], member: User | undefined): string[] {
  return member ? targets.filter((id) => id === member.id) : targets;
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
    @SlashOption(memberOption) member: User | undefined,
    interaction: CommandInteraction,
  ) {
    await discordCommandWrapper(interaction, async () => {
      await requireModOrOrganizer(
        interaction,
        'Only moderators and organizers can run the Reverify migration.',
      );
      const { guild, client, user } = interaction;
      const { candidates, rows, repo } =
        await loadMembersAndRecords(interaction);
      const existingReverifyRole = await findReverifyRole(guild);
      // Re-running after a partial or interrupted job only tags the rest.
      const alreadyTagged = new Set(
        existingReverifyRole
          ? candidates
              .filter((candidate) =>
                candidate.roleIds.includes(existingReverifyRole.id),
              )
              .map((candidate) => candidate.id)
          : [],
      );
      const targets = onlyMember(
        selectReverifyTargets(candidates, rows).filter(
          (id) => !alreadyTagged.has(id),
        ),
        member,
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
        (memberId) => tagIfStillUnlinked(guild, repo, role, memberId),
      );
      await interaction.followUp({
        content: started
          ? `Tagging ${targets.length} member(s) with ${role.toString()} in the background. ` +
            'The result posts in the staff moderation channel.'
          : busyMessage,
        ephemeral: true,
      });
      if (started) {
        logger.info(`Reverify tagging started for ${targets.length} member(s)`);
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
    @SlashOption(memberOption) member: User | undefined,
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
      const { candidates, rows, repo } =
        await loadMembersAndRecords(interaction);
      const targets = onlyMember(
        selectEnforceTargets(candidates, rows, role.id),
        member,
      );

      if (!confirm) {
        const targetIds = new Set(targets);
        const alreadyInOnboarding = candidates.filter(
          (candidate) =>
            targetIds.has(candidate.id) &&
            candidate.roleIds.includes(SERVER_ROLES.onboarding),
        ).length;
        await interaction.followUp({
          content:
            `Preview: ${targets.length} member(s) still holding ${REVERIFY_ROLE_NAME} ` +
            'would be moved to Onboarding and lose channel access' +
            (alreadyInOnboarding
              ? ` (${alreadyInOnboarding} already in Onboarding would just lose the tag)`
              : '') +
            '. Nothing changed. Run again with confirm:true on deadline day.',
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
        (memberId) =>
          moveToOnboardingIfStillUnlinked(guild, repo, role.id, memberId),
      );
      await interaction.followUp({
        content: started
          ? `Moving ${targets.length} member(s) to Onboarding in the background. The result posts in the staff moderation channel.`
          : busyMessage,
        ephemeral: true,
      });
      if (started) {
        logger.info(
          `Reverify enforcement started for ${targets.length} member(s)`,
        );
        await logModerationAction(interaction, {
          title: 'Reverify enforcement started',
          description: `${user.toString()} started moving ${targets.length} member(s) to Onboarding.`,
        });
      }
    });
  }
}
