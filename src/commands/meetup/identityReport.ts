import {
  ApplicationCommandOptionType,
  CommandInteraction,
  PermissionFlagsBits,
} from 'discord.js';
import { Discord, Slash, SlashOption } from 'discordx';
import { Logger } from 'tslog';

import {
  MAX_REPORT_BYTES,
  estimateReportBytes,
  renderIdentityReport,
} from '../../lib/helpers/identityReport.js';
import { IdentityChangeRecord } from '../../lib/repositories/identityTypes.js';
import {
  discordCommandWrapper,
  requireModOrOrganizer,
  withDiscordFileAttachment,
} from '../../util/discord.js';
import { ApplicationIdentityRepository } from '../../util/identityRepository.js';

const logger = new Logger({ name: 'IdentityReportCommands' });

const strings = {
  notAllowed: 'Only moderators and organizers can pull identity reports.',
  unavailable:
    'Identity monitoring is not configured (no database on this instance).',
};

export type ReportAttachment =
  { ok: true; fileName: string; html: string } | { ok: false; reason: string };

export function buildReportAttachment(
  changes: IdentityChangeRecord[],
  days: number,
): ReportAttachment {
  const to = new Date();
  const from = new Date(to.getTime() - days * 24 * 60 * 60 * 1000);

  const estimated = estimateReportBytes(changes);
  if (estimated > MAX_REPORT_BYTES) {
    return {
      ok: false,
      reason: `That range needs about ${Math.round(
        estimated / 1_000_000,
      )} MB, over Discord's upload limit. Try a narrower window.`,
    };
  }

  return {
    ok: true,
    fileName: `identity-report-${to.toISOString().slice(0, 10)}.html`,
    html: renderIdentityReport(changes, { from, to }),
  };
}

@Discord()
export class IdentityReportCommands {
  @Slash({
    name: 'meetup_identity_report',
    description:
      'Download a visual report of member photo and name changes (mods/organizers only)',
    // Hides the command from members without mod permissions; the role check
    // inside the handler stays authoritative. Guild admins can re-grant
    // visibility per role under Server Settings → Integrations.
    defaultMemberPermissions: PermissionFlagsBits.ModerateMembers,
  })
  async identityReportHandler(
    @SlashOption({
      name: 'days',
      description: 'How many days back to include (default 7)',
      type: ApplicationCommandOptionType.Integer,
      required: false,
      minValue: 1,
      maxValue: 365,
    })
    days: number | undefined,
    interaction: CommandInteraction,
  ) {
    await discordCommandWrapper(interaction, async () => {
      await requireModOrOrganizer(interaction, strings.notAllowed);

      const repo = await ApplicationIdentityRepository();
      if (!repo) {
        throw new Error(strings.unavailable);
      }

      const windowDays = days ?? 7;
      const to = new Date();
      const from = new Date(to.getTime() - windowDays * 24 * 60 * 60 * 1000);
      const changes = await repo.listChangesBetween(from, to);

      const built = buildReportAttachment(changes, windowDays);
      // `=== false` (not `!built.ok`): this project builds without
      // strictNullChecks, and without it plain truthy/falsy checks don't
      // reliably narrow a discriminated union — only literal equality does.
      if (built.ok === false) {
        throw new Error(built.reason);
      }

      await withDiscordFileAttachment(
        built.fileName,
        built.html,
        async (attachmentArgs) => {
          await interaction.editReply({
            content: `Identity report: ${changes.length} change${
              changes.length === 1 ? '' : 's'
            } over the last ${windowDays} day${windowDays === 1 ? '' : 's'}.`,
            ...attachmentArgs,
          });
        },
      );
      logger.info(
        `Identity report generated: ${changes.length} changes over ${windowDays}d`,
      );
    });
  }
}
