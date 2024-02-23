import {
  APIApplicationRoleConnectionMetadata,
  ApplicationRoleConnectionMetadataType,
  CommandInteraction,
} from 'discord.js';
import { Discord, Slash } from 'discordx';

import Configuration from '../../configuration';
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
      /**
       * Register the metadata to be stored by Discord. This should be a one time action.
       * Note: uses a Bot token for authentication, not a user token.
       */
      const url = `https://discord.com/api/v10/applications/${Configuration.discord.oauthClientId}/role-connections/metadata`;
      const body: APIApplicationRoleConnectionMetadata[] = [
        {
          key: '15member',
          name: '1.5 Member',
          description: 'Is 1.5 Member',
          type: ApplicationRoleConnectionMetadataType.BooleanEqual,
        },
        {
          key: 'organizer',
          name: 'Organizer',
          description: 'Is Organizer',
          type: ApplicationRoleConnectionMetadataType.BooleanEqual,
        },
        {
          key: 'membersince',
          name: 'Member Since',
          description: 'Days since joined 1.5',
          type: ApplicationRoleConnectionMetadataType.DatetimeGreaterThanOrEqual,
        },
        {
          key: 'eventsattended',
          name: 'Events Attended',
          description: 'Number of events attended',
          type: ApplicationRoleConnectionMetadataType.IntegerGreaterThanOrEqual,
        },
      ];

      const response = await fetch(url, {
        method: 'PUT',
        body: JSON.stringify(body),
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bot ${Configuration.discord.apiKey}`,
        },
      });
      if (response.ok) {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        const data: string = await response.json();
        await interaction.followUp({
          ephemeral: true,
          content: JSON.stringify(data),
        });
      } else {
        // throw new Error(`Error pushing discord metadata schema: [${response.status}] ${response.statusText}`);
        const data = await response.text();
        await interaction.followUp({ ephemeral: true, content: data });
      }
    });
  }
}
