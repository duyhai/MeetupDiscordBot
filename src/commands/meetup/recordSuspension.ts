import dayjs from 'dayjs';
import {
  ApplicationCommandOptionType,
  Attachment,
  CommandInteraction,
  PermissionFlagsBits,
} from 'discord.js';
import { Discord, Slash, SlashOption } from 'discordx';
import { Logger } from 'tslog';

import {
  formatRecordSummary,
  recordCsvRows,
} from '../../lib/helpers/recordSuspensions.js';
import { parseSuspensionCsv } from '../../lib/helpers/suspensionCsv.js';
import { PostgresSuspensionRepository } from '../../lib/repositories/postgresSuspensionRepository.js';
import {
  discordCommandWrapper,
  keepReplyVisible,
  logModerationAction,
  requireModOrOrganizer,
  withDiscordFileAttachment,
} from '../../util/discord.js';
import { withMeetupClient } from '../../util/meetup.js';
import { tz } from '../../util/timezone.js';

const logger = new Logger({ name: 'MeetupRecordSuspensionCommands' });

@Discord()
export class MeetupRecordSuspensionCommands {
  @Slash({
    name: 'meetup_record_suspension',
    description:
      'Record no-show suspensions from a CSV (the No Show report suggests one). Output is private.',
    // Hides the command from members without mod permissions; the role check
    // inside the handler stays authoritative.
    defaultMemberPermissions: PermissionFlagsBits.ModerateMembers,
  })
  async recordSuspensionHandler(
    @SlashOption({
      name: 'csv',
      description:
        'CSV with header member_id,member_name,duration_days,suspended_at,notes.',
      type: ApplicationCommandOptionType.Attachment,
      required: true,
    })
    csv: Attachment,
    interaction: CommandInteraction,
  ) {
    await discordCommandWrapper(interaction, async () => {
      await requireModOrOrganizer(
        interaction,
        'Only moderators and organizers can record suspensions.',
      );
      // Parse the file before asking for Meetup authorization, so a
      // malformed file fails straight away.
      const response = await fetch(csv.url);
      if (!response.ok) {
        throw new Error(`Could not download attachment: ${response.status}`);
      }
      const csvRows = parseSuspensionCsv(await response.text());
      if (csvRows.length === 0) {
        throw new Error('The CSV contained no data rows.');
      }
      const repo = await PostgresSuspensionRepository.instance();

      // Everything that writes happens inside the client callback. If the
      // moderator doesn't finish Meetup authorization, withMeetupClient
      // returns without calling it and nothing is recorded. A failed lookup
      // throws out of here too, so a Meetup outage can't flag every row as
      // "not a current member".
      await withMeetupClient(interaction, async (meetupClient) => {
        const memberIds = [...new Set(csvRows.map((row) => row.memberId))];
        const knownMembers = new Map(
          (await meetupClient.getGroupMembersByIds(memberIds)).map((member) => [
            member.id,
            member.name,
          ]),
        );
        const outcome = await recordCsvRows(repo, csvRows, knownMembers);

        logger.info(
          `Recorded ${outcome.recorded.length} suspension(s) (${
            outcome.duplicates.length
          } already on file, ${outcome.notInGroup.length} not a current member, ${
            outcome.durationMismatches.length
          } duration(s) to check)`,
        );
        const summary = formatRecordSummary(outcome);
        keepReplyVisible(interaction);
        await withDiscordFileAttachment(
          `Suspensions recorded ${tz(dayjs()).format('YYYY-MM-DD')}.txt`,
          summary.body,
          async (attachmentArgs) => {
            await interaction.editReply({
              ...attachmentArgs,
              content: summary.content,
            });
          },
        );
        await logModerationAction(interaction, {
          title: 'Suspensions recorded',
          description: `${interaction.user.toString()} uploaded ${csv.name}.`,
          fields: [{ name: 'Result', value: summary.result }],
        });
      });
    });
  }
}
