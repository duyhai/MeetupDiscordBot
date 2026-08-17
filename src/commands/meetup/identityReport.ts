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
  estimateReportBytesFromCounts,
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

/**
 * Refusal text for a range too large to build. Names a concrete narrower
 * window rather than just saying no: the organizer asked a question and
 * should not have to bisect their way to an answer.
 */
export function tooLargeMessage(
  estimatedBytes: number,
  windowDays: number,
): string {
  const suggested = Math.max(
    1,
    Math.floor((windowDays * MAX_REPORT_BYTES) / estimatedBytes),
  );
  return `That range needs about ${Math.round(
    estimatedBytes / 1_000_000,
  )} MB, more than this bot can assemble at once. Try a narrower window -- about ${suggested} day${
    suggested === 1 ? '' : 's'
  } should fit.`;
}

export function buildReportAttachment(
  changes: IdentityChangeRecord[],
  days: number,
): ReportAttachment {
  const to = new Date();
  const from = new Date(to.getTime() - days * 24 * 60 * 60 * 1000);

  const estimated = estimateReportBytes(changes);
  if (estimated > MAX_REPORT_BYTES) {
    return { ok: false, reason: tooLargeMessage(estimated, days) };
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
      // Not 365: a year of avatar changes is far more than this dyno can hold
      // in memory while assembling one self-contained document, and the guard
      // below refuses those ranges anyway. Offering the option only invites a
      // refusal.
      maxValue: 90,
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
      // Measure BEFORE fetching. The rows carry both BYTEA thumbs, base64
      // adds a third on top, then an intermediate array, then one mega-string,
      // then writeFileSync copies it again -- roughly 3-4x the raw bytes live
      // at once. Checking the size only after all of that is resident is a
      // guard that fires after the damage. This costs one aggregate query.
      const measured = await repo.measureChangesBetween(from, to);
      const projected = estimateReportBytesFromCounts(
        measured.changeCount,
        measured.thumbBytes,
      );
      if (projected > MAX_REPORT_BYTES) {
        throw new Error(tooLargeMessage(projected, windowDays));
      }

      const changes = await repo.listChangesBetween(from, to);

      // Backstop only: the pre-fetch measurement above is the real guard.
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
          // followUp, not editReply: editReply targets the progress reply that
          // discordCommandWrapper deletes on success, so the organizer would
          // watch the file appear and then vanish. Every other attachment
          // command in this project follows up for the same reason.
          await interaction.followUp({
            ...attachmentArgs,
            content: `Identity report: ${changes.length} change${
              changes.length === 1 ? '' : 's'
            } over the last ${windowDays} day${windowDays === 1 ? '' : 's'}.`,
            ephemeral: true,
          });
        },
      );
      logger.info(
        `Identity report generated: ${changes.length} changes over ${windowDays}d`,
      );
    });
  }
}
