import dayjs from 'dayjs';
import {
  ApplicationCommandOptionType,
  Attachment,
  CommandInteraction,
} from 'discord.js';
import { Discord, Slash, SlashOption } from 'discordx';
import { Logger } from 'tslog';

import { recommendedSuspensionDays } from '../../lib/helpers/noShowReport.js';
import {
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
import { ApplicationMemberRepository } from '../../util/memberRepository.js';
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
      const repo = await PostgresSuspensionRepository.instance();

      const summaryLines: string[] = [];
      let insertedCount = 0;
      let duplicateCount = 0;
      let dedupedCount = 0;
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
        insertedCount = inserted.length;
        duplicateCount = rows.length - inserted.length;
        summaryLines.push(
          ...inserted.map(
            (row) =>
              `- ${row.memberId}: ${row.durationDays} days from ${dayjs(
                row.suspendedAt,
              ).format('YYYY-MM-DD')}${row.notes ? ` (${row.notes})` : ''}`,
          ),
        );
      } else {
        const parsed = parseAndDedupeMemberIds(members);
        const memberIds = parsed.memberIds;
        dedupedCount = parsed.dedupedCount;
        const suspendedAt =
          parsedDate ??
          new Date(`${tz(dayjs()).format('YYYY-MM-DD')}T00:00:00Z`);
        // Names come from the bot's linked-members table when the member has
        // linked their Discord; unlinked members are recorded name-less.
        const memberRepo = await ApplicationMemberRepository();
        // Sequential on purpose: each member's duration depends on their
        // prior count.
        for (const memberId of memberIds) {
          // eslint-disable-next-line no-await-in-loop
          const priorCount = await repo.countByMemberId(memberId);
          const durationDays = recommendedSuspensionDays(priorCount);
          // eslint-disable-next-line no-await-in-loop
          const linkedMember = await memberRepo.findByMeetupId(memberId);
          const memberName = linkedMember?.meetupName ?? null;
          const nameStr = memberName ? ` (${memberName})` : '';
          // eslint-disable-next-line no-await-in-loop
          const inserted = await repo.insert({
            memberId,
            memberName,
            suspendedAt,
            durationDays,
            notes: null,
          });
          if (inserted === undefined) {
            duplicateCount += 1;
            summaryLines.push(
              `- ${memberId}${nameStr}: already recorded for ${dayjs(
                suspendedAt,
              ).format('YYYY-MM-DD')} — skipped as a duplicate`,
            );
          } else {
            insertedCount += 1;
            summaryLines.push(
              `- ${memberId}${nameStr}: prior suspensions ${priorCount} → **${durationDays} days**`,
            );
          }
        }
      }

      logger.info(
        `Recorded ${insertedCount} suspension(s) via ${
          csv ? 'csv' : 'members'
        } mode (${duplicateCount} duplicate(s), ${dedupedCount} deduped input ID(s))`,
      );
      keepReplyVisible(interaction);
      const noteLines: string[] = [];
      if (dedupedCount > 0) {
        noteLines.push(
          `_Removed ${dedupedCount} duplicate member ID(s) from the input list._`,
        );
      }
      const contentSuffix = [
        duplicateCount > 0 ? `${duplicateCount} duplicate(s) skipped` : '',
        dedupedCount > 0 ? `${dedupedCount} input ID(s) deduped` : '',
      ]
        .filter((part) => part.length > 0)
        .join(', ');
      // Discord caps message content at 2000 chars; a large backfill CSV can
      // easily exceed that if the summary is posted inline, and that would
      // throw *after* the rows already committed. Deliver the summary via
      // attachment instead, so the reply itself always stays well under the
      // limit regardless of row count.
      const body = [...noteLines, ...summaryLines].join('\n');
      await withDiscordFileAttachment(
        `Suspensions recorded ${dayjs().format('YYYY-MM-DD')}.txt`,
        body,
        async (attachmentArgs) => {
          await interaction.editReply({
            ...attachmentArgs,
            content: `Recorded ${insertedCount} suspension(s)${
              contentSuffix ? ` (${contentSuffix})` : ''
            }. Details in the attachment.`,
          });
        },
      );
    });
  }
}
