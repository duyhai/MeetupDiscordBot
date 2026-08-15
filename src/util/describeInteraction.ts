import {
  ButtonInteraction,
  CommandInteraction,
  ModalSubmitInteraction,
} from 'discord.js';

export function describeInteraction(
  interaction: ButtonInteraction | CommandInteraction | ModalSubmitInteraction,
): string {
  if (interaction.isChatInputCommand?.()) {
    return `/${interaction.commandName}`;
  }
  if ('commandName' in interaction) {
    return `/${interaction.commandName}`;
  }
  if (interaction.isButton?.()) {
    return `button:${interaction.customId}`;
  }
  return `modal:${interaction.customId}`;
}
