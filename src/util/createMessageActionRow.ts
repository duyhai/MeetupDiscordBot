import {
  EmojiIdentifierResolvable, MessageActionRow, MessageButton, MessageButtonStyleResolvable,
} from 'discord.js';

interface MessageButtonOptions {
  emoji?: EmojiIdentifierResolvable;
  label: string;
  style?: MessageButtonStyleResolvable;
}

export function createMessageActionRow(buttonOptions: MessageButtonOptions[], customId: string) {
  return new MessageActionRow().setComponents(
    buttonOptions.map((option, index) => {
      const button = new MessageButton();
      button.setLabel(option.label);
      button.setCustomId(`${customId}-${index}`);
      if (option.emoji) button.setEmoji(option.emoji);
      if (option.style) button.setStyle(option.style);
      return button;
    }),
  );
}

export function createCustomIdRegexp(customId: string) {
  return new RegExp(`${customId}-\\d+`, 'g');
}
