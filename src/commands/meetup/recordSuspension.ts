import dayjs from 'dayjs';
import {
  ApplicationCommandOptionType,
  Attachment,
  CommandInteraction,
} from 'discord.js';
import { Discord, Slash, SlashOption } from 'discordx';
import { Logger } from 'tslog';

import { recommendedSuspensionDays } from '../../lib/helpers/noShowReport.js';
import { parseSuspensionCsv } from '../../lib/helpers/suspensionCsv.js';
import { PostgresSuspensionRepository } from '../../lib/repositories/postgresSuspensionRepository.js';
import {
  discordCommandWrapper,
  keepReplyVisible,
  requireModOrOrganizer,
} from '../../util/discord.js';

const logger = new Logger({ name: 'MeetupRecordSuspensionCommands' });

const DATE_FORMAT = /^\d{4}-\d{2}-\d{2}$/;

@Discord()
export class MeetupRecordSuspensionCommands {
  @Slash({
    name: 'meetup_record_suspension',
    description:
      'Record no-show suspensions. Pass member IDs (auto duration) OR a CSV. Output is private.',
  })
  async recordSuspensionHandler(
    @SlashOption({
      name: 'members',
      description:
        'Comma-separated Meetup member IDs. Duration auto-computed: 30 days × 2^(prior suspensions).',
      type: ApplicationCommandOptionType.String,
      required: false,
    })
    members: string | undefined,
    @SlashOption({
      name: 'date',
      description: 'Suspension date as YYYY-MM-DD. Default: today.',
      type: ApplicationCommandOptionType.String,
      required: false,
    })
    date: string | undefined,
    @SlashOption({
      name: 'csv',
      description:
        'CSV with header member_id,duration_days,suspended_at,notes — for exceptions and backfill.',
      type: ApplicationCommandOptionType.Attachment,
      required: false,
    })
    csv: Attachment | undefined,
    interaction: CommandInteraction,
  ) {
    await discordCommandWrapper(interaction, async () => {
      await requireModOrOrganizer(
        interaction,
        'Only moderators and organizers can record suspensions.',
      );
      if ((members === undefined) === (csv === undefined)) {
        throw new Error('Provide exactly one of `members` or `csv`.');
      }
      if (date !== undefined && !DATE_FORMAT.test(date)) {
        throw new Error('`date` must be YYYY-MM-DD.');
      }
      const repo = await PostgresSuspensionRepository.instance();

      let summaryLines: string[];
      if (csv !== undefined) {
        const response = await fetch(csv.url);
        if (!response.ok) {
          throw new Error(`Could not download attachment: ${response.status}`);
        }
        const rows = parseSuspensionCsv(await response.text());
        if (rows.length === 0) {
          throw new Error('The CSV contained no data rows.');
        }
        const inserted = await repo.insertMany(rows);
        summaryLines = inserted.map(
          (row) =>
            `- ${row.memberId}: ${row.durationDays} days from ${dayjs(
              row.suspendedAt,
            ).format('YYYY-MM-DD')}${row.notes ? ` (${row.notes})` : ''}`,
        );
      } else {
        const memberIds = members
          .split(',')
          .map((id) => id.trim())
          .filter((id) => id.length > 0);
        if (memberIds.length === 0) {
          throw new Error('`members` contained no member IDs.');
        }
        const suspendedAt = new Date(
          `${date ?? dayjs().format('YYYY-MM-DD')}T00:00:00Z`,
        );
        summaryLines = [];
        // Sequential on purpose: each member's duration depends on their
        // prior count, and a moderator may list the same member twice.
        for (const memberId of memberIds) {
          // eslint-disable-next-line no-await-in-loop
          const priorCount = await repo.countByMemberId(memberId);
          const durationDays = recommendedSuspensionDays(priorCount);
          // eslint-disable-next-line no-await-in-loop
          await repo.insert({
            memberId,
            memberName: null,
            suspendedAt,
            durationDays,
            notes: null,
          });
          summaryLines.push(
            `- ${memberId}: prior suspensions ${priorCount} → **${durationDays} days**`,
          );
        }
      }

      logger.info(
        `Recorded ${summaryLines.length} suspension(s) via ${
          csv ? 'csv' : 'members'
        } mode`,
      );
      keepReplyVisible(interaction);
      await interaction.editReply({
        content: `Recorded ${summaryLines.length} suspension(s):\n${summaryLines.join(
          '\n',
        )}`,
      });
    });
  }
}
