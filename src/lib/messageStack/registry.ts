import {
  ActionRowBuilder,
  ButtonInteraction,
  CommandInteraction,
  EmbedBuilder,
  MessageActionRowComponentBuilder,
  ModalSubmitInteraction,
} from 'discord.js';

import { createDiscordFlushers } from './discordAdapter.js';
import { StackManager } from './stackManager.js';

const DEBOUNCE_MS = 400;
// Discord interaction tokens live 15 minutes; past that every write fails.
const MAX_AGE_MS = 15 * 60 * 1000;

type StackInteraction =
  ButtonInteraction | CommandInteraction | ModalSubmitInteraction;

export type ReplyStack = StackManager<
  EmbedBuilder,
  ActionRowBuilder<MessageActionRowComponentBuilder>
>;

const registry = new Map<string, ReplyStack>();

/**
 * The interaction's output manager, created on first use. Every helper in
 * these flows already receives the interaction, so nothing needs a new
 * parameter. discordCommandWrapper disposes it when the command ends.
 */
export function replyStack(interaction: StackInteraction): ReplyStack {
  const existing = registry.get(interaction.id);
  if (existing) {
    return existing;
  }
  const manager: ReplyStack = new StackManager({
    flushers: createDiscordFlushers(interaction),
    debounceMs: DEBOUNCE_MS,
    maxAgeMs: MAX_AGE_MS,
  });
  registry.set(interaction.id, manager);
  return manager;
}

export function disposeReplyStack(interaction: StackInteraction): void {
  const manager = registry.get(interaction.id);
  if (!manager) {
    return;
  }
  manager.dispose();
  registry.delete(interaction.id);
}

/** Test seam: asserts the registry is not accumulating managers. */
export function registrySize(): number {
  return registry.size;
}
