import dayjs from 'dayjs';
import {
  ApplicationCommandOptionType,
  ButtonInteraction,
  CommandInteraction,
} from 'discord.js';
import { ButtonComponent, Discord, Slash, SlashOption } from 'discordx';

import { SHARE_BUTTON_ID_PATTERN } from '../../lib/wrapped/format.js';
import { runShare, runWrapped } from '../../lib/wrapped/handlers.js';
import { discordCommandWrapper, keepReplyVisible } from '../../util/discord.js';
import { tz } from '../../util/timezone.js';

/** The group's first year on Meetup; nothing to wrap before it. */
const FIRST_WRAPPED_YEAR = 2015;

/** The calendar year in the group's timezone. */
export function currentWrappedYear(now: Date = new Date()): number {
  return tz(dayjs(now)).year();
}

/**
 * /wrapped: a linked member's year with the group, privately, with a Share
 * button. Member-facing, so it needs the one-time @everyone override in
 * Server Settings → Integrations after it first registers (this app's
 * commands register mods-only by default).
 */
@Discord()
export class WrappedCommands {
  @Slash({
    name: 'wrapped',
    description:
      'Your 1.5 Gen Wrapped: your year with the group. Output is private.',
  })
  async wrappedHandler(
    @SlashOption({
      name: 'year',
      description: 'Which year to wrap. Defaults to this year.',
      type: ApplicationCommandOptionType.Integer,
      required: false,
      minValue: FIRST_WRAPPED_YEAR,
    })
    year: number | undefined,
    @SlashOption({
      name: 'refresh',
      description: 'Rebuild from Meetup instead of showing the saved one.',
      type: ApplicationCommandOptionType.Boolean,
      required: false,
    })
    refresh: boolean | undefined,
    interaction: CommandInteraction,
  ) {
    await discordCommandWrapper(interaction, async () => {
      const thisYear = currentWrappedYear();
      const chosen = year ?? thisYear;
      if (chosen < FIRST_WRAPPED_YEAR || chosen > thisYear) {
        // A typo, not a failure: no alert to staff.
        await interaction.editReply({
          content: `Pick a year between ${FIRST_WRAPPED_YEAR} and ${thisYear}.`,
        });
        keepReplyVisible(interaction);
        return;
      }
      await runWrapped(interaction, {
        year: chosen,
        refresh: refresh ?? false,
      });
    });
  }

  @ButtonComponent({ id: SHARE_BUTTON_ID_PATTERN })
  async shareHandler(interaction: ButtonInteraction) {
    await discordCommandWrapper(interaction, async () => {
      await runShare(interaction);
    });
  }
}
