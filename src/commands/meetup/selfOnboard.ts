import {
  ApplicationRoleConnectionMetadataType,
  CommandInteraction,
} from 'discord.js';
import { Discord, Slash } from 'discordx';

import Configuration from '../../configuration';
import { DiscordBotClient } from '../../lib/client/discord/botClient';
import { selfOnboardUser } from '../../lib/helpers/onboardUser';
import { discordCommandWrapper } from '../../util/discord';
import { withMeetupClient } from '../../util/meetup';

@Discord()
export class MeetupSelfOnboardCommands {
  @Slash({
    name: 'meetup_self_onboard',
    description: `Self-service onboarding through the Meetup Bot. Output is private.`,
  })
  async meetupSelfOnboardHandler(interaction: CommandInteraction) {
    await discordCommandWrapper(interaction, async () => {
      await withMeetupClient(interaction, async (meetupClient) => {
        await selfOnboardUser(meetupClient, interaction);
      });
    });
  }

  @Slash({
    name: 'register_linked_role',
    description: `Register Meetup Linked Role with Discord`,
  })
  async registerLinkedRoleHandler(interaction: CommandInteraction) {
    await discordCommandWrapper(interaction, async () => {
      const discordClient = new DiscordBotClient(Configuration.discord.apiKey);
      await discordClient.registerMetadata([
        {
          key: 'is_member',
          name: '1.5 Member',
          description: 'Is 1.5 Member',
          type: ApplicationRoleConnectionMetadataType.BooleanEqual,
        },
        {
          key: 'is_organizer',
          name: '1.5 Organizer',
          description: 'Is Organizer',
          type: ApplicationRoleConnectionMetadataType.BooleanEqual,
        },
        {
          key: 'member_since',
          name: 'Member Since',
          description: 'Days since joined 1.5',
          type: ApplicationRoleConnectionMetadataType.DatetimeGreaterThanOrEqual,
        },
        {
          key: 'events_attended',
          name: 'Events Attended',
          description: 'Number of events attended',
          type: ApplicationRoleConnectionMetadataType.IntegerGreaterThanOrEqual,
        },
        {
          key: 'events_hosted',
          name: 'Events Hosted',
          description: 'Number of events hosted',
          type: ApplicationRoleConnectionMetadataType.IntegerGreaterThanOrEqual,
        },
      ]);
      await interaction.followUp({
        ephemeral: true,
        content: 'Success',
      });
    });
  }
}
