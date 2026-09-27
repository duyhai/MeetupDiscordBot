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
  RecordOutcome,
  formatRecordSummary,
  recordBulk,
  recordCsvRows,
} from '../../lib/helpers/recordSuspensions.js';
import {
  ParsedSuspensionRow,
  parseSuspensionCsv,
  parseUtcDateStrict,
} from '../../lib/helpers/suspensionCsv.js';
import { PostgresSuspensionRepository } from '../../lib/repositories/postgresSuspensionRepository.js';
import {
  discordCommandWrapper,
  keepReplyVisible,
  requireModOrOrganizer,
  withDiscordFileAttachment,
} from '../../util/discord.js';
import { withMeetupClient } from '../../util/meetup.js';
import { tz } from '../../util/timezone.js';

const logger = new Logger({ name: 'MeetupRecordSuspensionCommands' });

const MEMBER_ID_FORMAT = /^\d+$/;

/**
 * Splits and validates the `members` option into a deduped list of numeric
 * IDs. Throws (naming the offending token) if any entry isn't purely
 * digits -- e.g. "123 456" without a comma becomes a single bogus ID, and a
 * pasted name or URL fragment should fail loudly rather than silently
 * getting recorded as a suspension. Dedupes keeping the first occurrence so
 * a member listed twice isn't penalized twice.
 */
export function parseAndDedupeMemberIds(membersOption: string): {
  memberIds: string[];
  dedupedCount: number;
} {
  const rawMemberIds = membersOption
    .split(',')
    .map((id) => id.trim())
    .filter((id) => id.length > 0);
  if (rawMemberIds.length === 0) {
    throw new Error('`members` contained no member IDs.');
  }
  for (const id of rawMemberIds) {
    if (!MEMBER_ID_FORMAT.test(id)) {
      throw new Error(
        `\`members\` contains an invalid member ID: "${id}". Expected a comma-separated list of numeric IDs.`,
      );
    }
  }
  const memberIds = [...new Set(rawMemberIds)];
  return { memberIds, dedupedCount: rawMemberIds.length - memberIds.length };
}

@Discord()
export class MeetupRecordSuspensionCommands {
  @Slash({
    name: 'meetup_record_suspension',
    description:
      'Record no-show suspensions. Pass member IDs (auto duration) OR a CSV. Output is private.',
    // Hides the command from members without mod permissions; the role check
    // inside the handler stays authoritative.
    defaultMemberPermissions: PermissionFlagsBits.ModerateMembers,
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
      let parsedDate: Date | undefined;
      if (date !== undefined) {
        parsedDate = parseUtcDateStrict(date);
        if (parsedDate === undefined) {
          throw new Error('`date` must be a valid calendar date, YYYY-MM-DD.');
        }
      }
      // Parse the input before asking for Meetup authorization, so a
      // malformed file or ID list fails straight away.
      let csvRows: ParsedSuspensionRow[] | undefined;
      let bulk: ReturnType<typeof parseAndDedupeMemberIds> | undefined;
      if (csv !== undefined) {
        const response = await fetch(csv.url);
        if (!response.ok) {
          throw new Error(`Could not download attachment: ${response.status}`);
        }
        csvRows = parseSuspensionCsv(await response.text());
        if (csvRows.length === 0) {
          throw new Error('The CSV contained no data rows.');
        }
      } else {
        bulk = parseAndDedupeMemberIds(members);
      }
      const repo = await PostgresSuspensionRepository.instance();

      // Everything that writes happens inside the client callback. If the
      // moderator doesn't finish Meetup authorization, withMeetupClient
      // returns without calling it and nothing is recorded -- rather than
      // every ID looking unknown and being skipped. A failed lookup throws
      // out of here too, so a Meetup outage can't be mistaken for "nobody
      // is a member".
      await withMeetupClient(interaction, async (meetupClient) => {
        const memberIds = csvRows
          ? [...new Set(csvRows.map((row) => row.memberId))]
          : bulk.memberIds;
        const knownMembers = new Map(
          (await meetupClient.getGroupMembersByIds(memberIds)).map((member) => [
            member.id,
            member.name,
          ]),
        );

        let outcome: RecordOutcome;
        if (csvRows) {
          outcome = await recordCsvRows(repo, csvRows, knownMembers);
        } else {
          const suspendedAt =
            parsedDate ??
            new Date(`${tz(dayjs()).format('YYYY-MM-DD')}T00:00:00Z`);
          outcome = await recordBulk(
            repo,
            bulk.memberIds,
            knownMembers,
            suspendedAt,
          );
        }

        logger.info(
          `Recorded ${outcome.recorded.length} suspension(s) via ${
            csvRows ? 'csv' : 'members'
          } mode (${outcome.duplicates.length} already on file, ${
            outcome.unknown.length
          } not in the group)`,
        );
        const summary = formatRecordSummary(outcome, bulk?.dedupedCount ?? 0);
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
      });
    });
  }
}
