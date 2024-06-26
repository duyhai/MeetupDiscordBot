import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonInteraction,
  ButtonStyle,
  CommandInteraction,
  MessageActionRowComponentBuilder,
} from 'discord.js';
import { ButtonComponent, Discord, Slash } from 'discordx';
import { Logger } from 'tslog';
import { discordCommandWrapper } from '../util/discord';
import Flags from './flags.json';

const logger = new Logger({ name: 'AANHPIFlagsCommands' });

const DISCORD_ROW_SIZE = 5;
const FLAG_PAGE_SIZE = 10;
const FLAG_FAST_FORWARD_AMOUNT = 5;
const MAX_FLAGS = 3;
const AANHPI_FLAGS_BUTTON_ID = 'aanhpi_flags_buttons';

const FLAGS = Flags.map((entry) => ({
  name: entry.name.slice(5),
  emoji: entry.emoji,
})).sort((e1, e2) => {
  return e1.name < e2.name ? -1 : 1;
});
const FLAG_NUMBER_OF_PAGES = Math.ceil(FLAGS.length / FLAG_PAGE_SIZE);

const MEME_NAME_SUFFIXES: Record<string, string> = {
  buttholecat: 'Natural Liar 🧢', // David A.
  haitest: 'Test Account',
};

function parsePageFromMessage(message: string): number {
  const page = +message.split('\n').at(-1).split(' ')[1].split('/')[0];
  return page - 1; // The message was showing 1-based indexing for users
}

@Discord()
export class AANHPIFlagsCommands {
  @ButtonComponent({ id: `${AANHPI_FLAGS_BUTTON_ID}_clear` })
  @ButtonComponent({ id: `${AANHPI_FLAGS_BUTTON_ID}_choice_0_0` })
  @ButtonComponent({ id: `${AANHPI_FLAGS_BUTTON_ID}_choice_0_1` })
  @ButtonComponent({ id: `${AANHPI_FLAGS_BUTTON_ID}_choice_0_2` })
  @ButtonComponent({ id: `${AANHPI_FLAGS_BUTTON_ID}_choice_0_3` })
  @ButtonComponent({ id: `${AANHPI_FLAGS_BUTTON_ID}_choice_0_4` })
  @ButtonComponent({ id: `${AANHPI_FLAGS_BUTTON_ID}_choice_1_0` })
  @ButtonComponent({ id: `${AANHPI_FLAGS_BUTTON_ID}_choice_1_1` })
  @ButtonComponent({ id: `${AANHPI_FLAGS_BUTTON_ID}_choice_1_2` })
  @ButtonComponent({ id: `${AANHPI_FLAGS_BUTTON_ID}_choice_1_3` })
  @ButtonComponent({ id: `${AANHPI_FLAGS_BUTTON_ID}_choice_1_4` })
  async handleChoice(interaction: ButtonInteraction): Promise<void> {
    logger.info(
      `AANHPI Flags menu choice button pressed by ${interaction.user.toString()}! ${JSON.stringify(
        interaction.component
      )}`
    );

    const guildMember = await interaction.guild.members.fetch(
      interaction.user.id
    );

    const { nickname } = guildMember;
    const realName = nickname.split('|')[0].trim();
    let userFlags = FLAGS.filter((flag) => nickname.includes(flag.emoji))
      .map((flag) => ({
        pos: nickname.indexOf(flag.emoji),
        value: flag.emoji,
      }))
      .sort((e1, e2) => e1.pos - e2.pos)
      .map((flag) => flag.value);
    logger.info(`Flags present in name: ${userFlags.toString()}`);

    const buttonEmoji = interaction.component.emoji.name;
    const shouldClearFlags = buttonEmoji === '🏳️';
    const isFlagAlreadyPresent = userFlags.some((flag) => flag === buttonEmoji);
    if (shouldClearFlags) {
      logger.info(`Clearing flags from ${nickname}`);
      userFlags = [];
    } else if (isFlagAlreadyPresent) {
      logger.info(`Removing ${buttonEmoji} from ${nickname}`);
      userFlags = userFlags.filter((flag) => flag !== buttonEmoji);
    } else {
      logger.info(`Adding ${buttonEmoji} to ${nickname}`);
      userFlags.push(buttonEmoji);
      logger.info(`Flags present in new name: ${userFlags.toString()}`);
    }
    // Truncate to max MAX_FLAGS
    userFlags = userFlags.slice(
      Math.max(0, userFlags.length - MAX_FLAGS),
      userFlags.length
    );

    const newNameSuffixes = [];
    if (Object.keys(MEME_NAME_SUFFIXES).includes(interaction.user.username)) {
      logger.info(`Adding meme name suffixes ${userFlags.toString()}`);
      newNameSuffixes.push(MEME_NAME_SUFFIXES[interaction.user.username]);
    }
    if (userFlags.length) {
      logger.info(`Adding flags ${userFlags.toString()}`);
      newNameSuffixes.push(userFlags.join(''));
    }

    const newNickname = [realName];
    if (newNameSuffixes.length) {
      logger.info(`Adding newNameSuffixes ${newNameSuffixes.toString()}`);
      newNickname.push(newNameSuffixes.join(' '));
    }
    await guildMember.setNickname(newNickname.join(' | '));

    const page = parsePageFromMessage(interaction.message.content);
    let message = '';
    if (shouldClearFlags) {
      message = `Cleared all flags from your name!`;
    } else if (isFlagAlreadyPresent) {
      message = `The flag ${buttonEmoji} has been removed from your name! Your current flags are [${userFlags.toString()}]`;
    } else {
      message = `The flag ${buttonEmoji} has been added to your name! \
If you had ${MAX_FLAGS} flags in your name, the first one got replaced. Your current flags are [${userFlags.toString()}]`;
    }
    await interaction.update(await this.generateAANHPIFlagsNav(page, message));
  }

  @ButtonComponent({ id: `${AANHPI_FLAGS_BUTTON_ID}_nav_0` })
  @ButtonComponent({ id: `${AANHPI_FLAGS_BUTTON_ID}_nav_1` })
  @ButtonComponent({ id: `${AANHPI_FLAGS_BUTTON_ID}_nav_2` })
  @ButtonComponent({ id: `${AANHPI_FLAGS_BUTTON_ID}_nav_3` })
  async handleNav(interaction: ButtonInteraction): Promise<void> {
    logger.info(
      `AANHPI Flags menu nav button pressed by ${interaction.user.toString()}! ${JSON.stringify(
        interaction.component
      )}`
    );

    let page = parsePageFromMessage(interaction.message.content);

    const buttonEmoji = interaction.component.emoji;
    switch (buttonEmoji.name) {
      case '⏪':
        page = Math.max(0, page - FLAG_FAST_FORWARD_AMOUNT);
        break;
      case '◀️':
        page = Math.max(0, page - 1);
        break;
      case '▶️':
        page = Math.min(FLAG_NUMBER_OF_PAGES - 1, page + 1);
        break;
      case '⏩':
        page = Math.min(
          FLAG_NUMBER_OF_PAGES - 1,
          page + FLAG_FAST_FORWARD_AMOUNT
        );
        break;
      default:
        break;
    }

    await interaction.update(await this.generateAANHPIFlagsNav(page));
  }

  async generateAANHPIFlagsNav(
    page = 0,
    extraMessage = ''
  ): Promise<{
    components: ActionRowBuilder<MessageActionRowComponentBuilder>[];
    content: string;
  }> {
    logger.info(`Generating AANHPI Flags nav`);
    const sliceStartIndex = FLAG_PAGE_SIZE * page;
    const flagsSlice = FLAGS.slice(
      sliceStartIndex,
      sliceStartIndex + FLAG_PAGE_SIZE
    );

    const replyContent = [
      `Happy Asian, Native Hawaiian, Pacific Islander Heritage Month!
Select (at most ${MAX_FLAGS}) flags here that best represents your background and heritage ❤️`,
      ...(extraMessage ? ['', extraMessage] : []),
      ``,
      `Page: ${page + 1}/${FLAG_NUMBER_OF_PAGES}`,
    ];

    const choiceButtonRows: ActionRowBuilder<MessageActionRowComponentBuilder>[] =
      [];
    for (let i = 0; i < flagsSlice.length; i += DISCORD_ROW_SIZE) {
      const rowNumber = Math.ceil(i / DISCORD_ROW_SIZE);
      choiceButtonRows.push(
        new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
          flagsSlice
            .slice(i, Math.min(flagsSlice.length, i + DISCORD_ROW_SIZE))
            .map((entry, index) =>
              new ButtonBuilder()
                .setEmoji(entry.emoji)
                .setLabel(entry.name)
                .setStyle(ButtonStyle.Secondary)
                .setCustomId(
                  `${AANHPI_FLAGS_BUTTON_ID}_choice_${rowNumber}_${index}`
                )
            )
        )
      );
    }

    const navButtonRow =
      new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents([
        ...['⏪', '◀️', '▶️', '⏩'].map((dir, index) =>
          new ButtonBuilder()
            .setEmoji(dir)
            .setStyle(ButtonStyle.Primary)
            .setCustomId(`${AANHPI_FLAGS_BUTTON_ID}_nav_${index}`)
        ),
        new ButtonBuilder()
          .setEmoji('🏳️')
          .setLabel('Clear All Flags')
          .setStyle(ButtonStyle.Primary)
          .setCustomId(`${AANHPI_FLAGS_BUTTON_ID}_clear`),
      ]);
    return {
      content: replyContent.join('\n'),
      components: [...choiceButtonRows, navButtonRow],
    };
  }

  @ButtonComponent({ id: AANHPI_FLAGS_BUTTON_ID })
  async meetupRequestApproveEventHandler(interaction: ButtonInteraction) {
    await discordCommandWrapper(interaction, async () => {
      logger.info(
        `Creating AANHPI Flags menu on behalf of ${interaction.user.username}`
      );
      await interaction.followUp({
        ephemeral: true,
        ...(await this.generateAANHPIFlagsNav()),
      });
      logger.info(`Created AANHPI Flags menu`);
    });
  }

  @Slash({
    name: 'create_aanhpi_flags_button',
    description: `Creates a button that lets users go though the flow of choosing flags to display next to their names`,
  })
  async createAANHPIFlagsButtonHandler(interaction: CommandInteraction) {
    await discordCommandWrapper(interaction, async () => {
      logger.info(
        `Creating AANHPI Flags flow on behalf of ${interaction.user.username}`
      );
      await interaction.channel.send({
        content: 'Click on the button below to show off your heritage!',

        components: [
          new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
            new ButtonBuilder()
              .setEmoji('🏳️')
              .setLabel('Click Me')
              .setStyle(ButtonStyle.Primary)
              .setCustomId(AANHPI_FLAGS_BUTTON_ID)
          ),
        ],
      });
      logger.info(`Created AANHPI Flags flow`);
    });
  }
}
