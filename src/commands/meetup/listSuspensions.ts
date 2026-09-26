import dayjs from 'dayjs';
import { CommandInteraction } from 'discord.js';
import { Discord, Slash } from 'discordx';
import { Logger } from 'tslog';

import { formatSuspensionList } from '../../lib/helpers/suspensionList.js';
import { PostgresSuspensionRepository } from '../../lib/repositories/postgresSuspensionRepository.js';
import {
  discordCommandWrapper,
  requireModOrOrganizer,
  withDiscordFileAttachment,
} from '../../util/discord.js';
import { ApplicationMemberRepository } from '../../util/memberRepository.js';
import { withMeetupClient } from '../../util/meetup.js';

const logger = new Logger({ name: 'MeetupListSuspensionsCommands' });

@Discord()
export class MeetupListSuspensionsCommands {
  @Slash({
    name: 'meetup_list_suspensions',
    description:
      'List all recorded no-show suspensions, split into active and past. Output is private.',
  })
  async listSuspensionsHandler(interaction: CommandInteraction) {
    await discordCommandWrapper(interaction, async () => {
      await requireModOrOrganizer(
        interaction,
        'Only moderators and organizers can list suspensions.',
      );
      const repo = await PostgresSuspensionRepository.instance();
      const records = await repo.listAll();
      logger.info(`Listing ${records.length} suspension record(s)`);

      // Display-time fallback for rows recorded without a name: linked
      // members' stored names first, overwritten by a live group-membership
      // lookup (current names, works for unlinked members too). Both are
      // nice-to-haves — the list renders without them.
      const memberRepo = await ApplicationMemberRepository();
      const linkedMembers = await memberRepo.listAll();
      const fallbackNames = new Map(
        linkedMembers
          .filter((m) => m.meetupId !== null && m.meetupName !== null)
          .map((m) => [m.meetupId, m.meetupName]),
      );
      const namelessIds = [
        ...new Set(
          records
            .filter((record) => record.memberName === null)
            .map((record) => record.memberId),
        ),
      ];
      if (namelessIds.length > 0) {
        try {
          await withMeetupClient(interaction, async (meetupClient) => {
            const liveMembers =
              await meetupClient.getGroupMembersByIds(namelessIds);
            liveMembers.forEach((liveMember) =>
              fallbackNames.set(liveMember.id, liveMember.name),
            );
          });
        } catch (error) {
          logger.warn(`Live member-name lookup failed: ${String(error)}`);
        }
      }

      const list = formatSuspensionList(records, dayjs(), fallbackNames);
      await withDiscordFileAttachment(
        'Suspensions.txt',
        list,
        async (attachmentArgs) => {
          await interaction.followUp({
            ...attachmentArgs,
            content: `${records.length} suspension record(s) on file.`,
            ephemeral: true,
          });
        },
      );
    });
  }
}
