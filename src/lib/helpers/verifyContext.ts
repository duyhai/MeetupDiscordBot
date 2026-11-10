import {
  ButtonInteraction,
  Client,
  CommandInteraction,
  Guild,
} from 'discord.js';

import { describeInteraction } from '../../util/discord.js';

/**
 * Who is being verified, and where: what the Verify steps used to read off
 * a discord.js interaction. The Verify button builds one from its
 * interaction; the host dashboard builds one from a website sign-in.
 */
export interface VerifyContext {
  guild: Guild;
  client: Client;
  /** The member's Discord user id. */
  userId: string;
  /** Their Discord username, for logs and alerts. */
  username: string;
  /** How the attempt began, for alerts: "button:sync_meetup_account", "host dashboard". */
  attempt: string;
  /**
   * Where the link came from, kept on the member row: 'self_onboard' (the
   * Verify button, the default) or 'web_link' (the host dashboard, which
   * has already posted its own "linked" activity line, so Verify's link
   * step stays quiet).
   */
  linkMethod?: 'self_onboard' | 'web_link';
}

export function verifyContextOf(
  interaction: ButtonInteraction | CommandInteraction,
): VerifyContext {
  return {
    guild: interaction.guild,
    client: interaction.client,
    userId: interaction.user.id,
    username: interaction.user.username,
    attempt: describeInteraction(interaction),
  };
}
