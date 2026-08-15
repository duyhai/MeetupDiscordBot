import {
  ActionRowBuilder,
  CommandInteraction,
  ModalBuilder,
  ModalSubmitInteraction,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';
import { Discord, ModalComponent, Slash } from 'discordx';
import { replyStack } from '../../lib/messageStack/registry.js';
import {
  discordCommandWrapper,
  withDiscordFileAttachment,
} from '../../util/discord.js';
import { withMeetupClient } from '../../util/meetup.js';

const TEST_GQL_MODAL_ID = 'TestGQLInputForm';
const TEST_GQL_MODAL_QUERY_ID = 'TestGQLInputQuery';
const TEST_GQL_MODAL_ARGS_ID = 'TestGQLInputArgs';

@Discord()
export class MeetupTestGqlCommands {
  @Slash({
    name: 'meetup_test_gql',
    description: 'Use this to test you GQL queries/mutations',
  })
  async inputGqlModal(interaction: CommandInteraction): Promise<void> {
    await interaction.showModal(
      new ModalBuilder()
        .setTitle('Test GraphQL Input form')
        .setCustomId(TEST_GQL_MODAL_ID)
        .addComponents(
          new ActionRowBuilder<TextInputBuilder>().addComponents(
            new TextInputBuilder()
              .setCustomId(TEST_GQL_MODAL_QUERY_ID)
              .setLabel('Query/Mutation string')
              .setStyle(TextInputStyle.Paragraph),
          ),
          new ActionRowBuilder<TextInputBuilder>().addComponents(
            new TextInputBuilder()
              .setCustomId(TEST_GQL_MODAL_ARGS_ID)
              .setLabel('Args (JSON string)')
              .setStyle(TextInputStyle.Paragraph),
          ),
        ),
    );
  }

  @ModalComponent({ id: TEST_GQL_MODAL_ID })
  async TestGQLInputForm(interaction: ModalSubmitInteraction): Promise<void> {
    const [query, args] = [TEST_GQL_MODAL_QUERY_ID, TEST_GQL_MODAL_ARGS_ID].map(
      (id) => interaction.fields.getTextInputValue(id),
    );

    await discordCommandWrapper(interaction, async () => {
      await withMeetupClient(interaction, async (meetupClient) => {
        const progressId = replyStack(interaction).ephemeral.append({
          content: 'Sit tight! Fetching data.',
          status: 'pending',
        });
        const result = await meetupClient.customRequest(query, args);
        // The result is delivered as a file attachment, not through the
        // stack, so the progress line has done its job -- drop it rather
        // than let it linger and pin the banner at pending.
        //
        // Not converted to the stack: withDiscordFileAttachment deletes its
        // temp file the moment this callback returns, but a stack flush is
        // debounced and would try to upload the file after it's gone.
        replyStack(interaction).ephemeral.remove(progressId);
        await withDiscordFileAttachment(
          `result.txt`,
          result,
          async (attachmentArgs) => {
            await interaction.followUp({
              ...attachmentArgs,
              content: 'Check the results in the attachment!',
              ephemeral: true,
            });
          },
        );
      });
    });
  }
}
