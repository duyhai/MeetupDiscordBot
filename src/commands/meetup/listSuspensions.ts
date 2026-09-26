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

      const list = formatSuspensionList(records, dayjs());
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
