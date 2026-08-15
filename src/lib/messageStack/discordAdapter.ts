import {
  ActionRowBuilder,
  ButtonInteraction,
  CommandInteraction,
  EmbedBuilder,
  Message,
  MessageActionRowComponentBuilder,
  ModalSubmitInteraction,
} from 'discord.js';
import { Logger } from 'tslog';

import { EMBED_COLORS } from '../../constants.js';
import { describeInteraction } from '../../util/describeInteraction.js';
import { EntryStatus, Flusher, RenderedMessage } from './types.js';

const logger = new Logger({ name: 'DiscordStackAdapter' });

const MAX_CONTENT = 2000;
const MAX_EMBEDS = 10;
const MAX_ROWS = 5;

// The user dismissed the message, or it was deleted.
const UNKNOWN_MESSAGE = 10008;
// The interaction token is dead; nothing can be written for this interaction.
const DEAD_TOKEN_CODES = [50027, 10062];

const STATUS_COLORS: Record<EntryStatus, number> = {
  success: EMBED_COLORS.activity,
  error: EMBED_COLORS.alert,
  pending: EMBED_COLORS.pending,
  attention: EMBED_COLORS.attention,
};

const STATUS_LABELS: Record<EntryStatus, string> = {
  success: 'Finished',
  error: 'Error',
  pending: 'In progress',
  attention: 'Needs attention',
};

type StackInteraction =
  ButtonInteraction | CommandInteraction | ModalSubmitInteraction;

type Embed = EmbedBuilder;
type Row = ActionRowBuilder<MessageActionRowComponentBuilder>;

interface DiscordPayload {
  components: Row[];
  content: string;
  embeds: Embed[];
}

function errorCode(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') {
    return undefined;
  }
  const code = (error as { code?: unknown }).code;
  return typeof code === 'number' ? code : undefined;
}

function clampContent(content: string | undefined): string {
  if (!content) {
    return '';
  }
  if (content.length <= MAX_CONTENT) {
    return content;
  }
  logger.warn(`Stack content ${content.length} chars; truncating`);
  return `${content.slice(0, MAX_CONTENT - 1)}…`;
}

/**
 * Turns a rendered stack into a Discord message payload: text stays in the
 * content (so mentions notify) and the status becomes a small banner embed
 * beneath it.
 */
export function toDiscordPayload(
  rendered: RenderedMessage<Embed, Row>,
  action: string,
): DiscordPayload {
  // Reserve a slot for the banner up front: slicing content embeds down to 9
  // first (rather than pushing the banner then slicing to 10) guarantees a
  // status-bearing surface always shows its banner instead of losing it to a
  // full content-embed array.
  const contentEmbeds = rendered.status
    ? rendered.embeds.slice(0, MAX_EMBEDS - 1)
    : rendered.embeds;
  const embeds = [...contentEmbeds];
  if (rendered.status) {
    embeds.push(
      new EmbedBuilder()
        .setColor(STATUS_COLORS[rendered.status])
        .setTitle(STATUS_LABELS[rendered.status])
        .setFooter({ text: action }),
    );
  }
  if (rendered.embeds.length > MAX_EMBEDS) {
    logger.warn(`Stack produced ${rendered.embeds.length} embeds; truncating`);
  }
  if (rendered.components.length > MAX_ROWS) {
    logger.warn(
      `Stack produced ${rendered.components.length} rows; truncating`,
    );
  }
  return {
    content: clampContent(rendered.content),
    embeds: embeds.slice(0, MAX_EMBEDS),
    components: rendered.components.slice(0, MAX_ROWS),
  };
}

function createEphemeralFlusher(
  interaction: StackInteraction,
  action: string,
): Flusher<Embed, Row> {
  // Undefined until a dismissal forces a followUp, since editReply targets
  // the original deferred reply and recreated targets the new message.
  let recreated: Message | undefined;

  return async (rendered) => {
    if (!rendered) {
      // RULING 2: the command wrapper defers the reply before any output
      // exists, so an unresolved deferred reply must always be cleared here
      // -- not only after a publish -- or it would sit showing "thinking..."
      // forever. Unlike the public flusher, this is not gated on `published`.
      // Discord does not allow deleting an ephemeral message through the
      // channel-message route (Message#delete()); only the interaction
      // webhook's deleteMessage route applies to it. `deleteReply` given a
      // message id delegates to exactly that (`this.webhook.deleteMessage`),
      // so it is what removes a recreated ephemeral followUp, too.
      await interaction
        .deleteReply(recreated ? recreated.id : undefined)
        .catch((error) => {
          logger.warn(`Could not remove empty stack message: ${String(error)}`);
        });
      recreated = undefined;
      return;
    }

    const payload = toDiscordPayload(rendered, action);
    try {
      if (recreated) {
        await recreated.edit(payload);
      } else {
        await interaction.editReply(payload);
      }
    } catch (error) {
      const code = errorCode(error);
      if (code === UNKNOWN_MESSAGE) {
        // Dismissed: re-send the whole stack and keep going in the new message.
        recreated = await interaction.followUp({
          ...payload,
          ephemeral: true,
        });
        return;
      }
      if (code !== undefined && DEAD_TOKEN_CODES.includes(code)) {
        logger.info('Interaction token expired; dropping stack output');
        return;
      }
      throw error;
    }
  };
}

function createPublicFlusher(
  interaction: StackInteraction,
  action: string,
): Flusher<Embed, Row> {
  let message: Message | undefined;

  return async (rendered) => {
    if (!rendered) {
      if (message) {
        await message.delete().catch((error) => {
          logger.warn(`Could not remove public message: ${String(error)}`);
        });
        message = undefined;
      }
      return;
    }

    const payload = toDiscordPayload(rendered, action);
    if (!message) {
      // A webhook message on the interaction token: works even where the bot
      // lacks SEND_MESSAGES in the channel, and does not require
      // interaction.channel to be resolved (unlike channel.send).
      message = await interaction.followUp({ ...payload, ephemeral: false });
      return;
    }
    try {
      await message.edit(payload);
    } catch (error) {
      if (errorCode(error) === UNKNOWN_MESSAGE) {
        message = undefined;
        logger.warn('Public stack message vanished; will re-send next flush');
        return;
      }
      throw error;
    }
  };
}

export function createDiscordFlushers(interaction: StackInteraction): {
  ephemeral: Flusher<Embed, Row>;
  public: Flusher<Embed, Row>;
} {
  const action = describeInteraction(interaction);
  return {
    ephemeral: createEphemeralFlusher(interaction, action),
    public: createPublicFlusher(interaction, action),
  };
}
