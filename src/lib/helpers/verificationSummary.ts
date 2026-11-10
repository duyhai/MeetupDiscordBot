import { EmbedBuilder } from 'discord.js';

import { linkStr } from '../../util/discord.js';

const SUCCESS_COLOR = 0x2ecc71;

export interface VerificationSummary {
  attendedCount: number;
  hostedCount: number;
  meetupMemberUrl: string;
  meetupName: string;
  rolesGranted: string[];
}

/** The summary's words, shared by the Discord embed and the host dashboard's page. */
export interface VerificationSummaryText {
  title: string;
  description: string;
  /** "Organizer, Guest Host", or "Verified member" when nothing more. */
  roles: string;
  /** "12 attended · 3 hosted — badges applied", or undefined for a first-timer. */
  activity: string | undefined;
}

export function verificationSummaryText({
  attendedCount,
  hostedCount,
  rolesGranted,
}: Pick<
  VerificationSummary,
  'attendedCount' | 'hostedCount' | 'rolesGranted'
>): VerificationSummaryText {
  // Same reasoning for activity: a first-timer's "0 hosted, 0 attended"
  // makes a successful verification look like a failure, so it is simply
  // omitted until there is something to celebrate.
  const parts = [];
  if (attendedCount > 0) parts.push(`${attendedCount} attended`);
  if (hostedCount > 0) parts.push(`${hostedCount} hosted`);
  return {
    title: '✅ You are verified',
    description:
      'You now have access to the members-only channels. Pick the ones you ' +
      'want at <id:browse>.',
    // A brand-new member earns nothing beyond membership, which is the
    // common case -- "none" would read like something went wrong.
    roles: rolesGranted.length ? rolesGranted.join(', ') : 'Verified member',
    activity: parts.length
      ? `${parts.join(' · ')} — badges applied`
      : undefined,
  };
}

/**
 * The single message a member sees after linking.
 *
 * Verification used to answer in pieces -- a welcome, a roles line, a badges
 * line, and "Sit tight!" twice -- because each step was once its own command.
 * Behind one button that reads as four half-answers, so the steps now report
 * their results and this composes them.
 */
export function buildVerificationSummary(
  summary: VerificationSummary,
): EmbedBuilder {
  const text = verificationSummaryText(summary);
  const embed = new EmbedBuilder()
    .setTitle(text.title)
    .setColor(SUCCESS_COLOR)
    .setDescription(text.description)
    .addFields(
      {
        name: 'Meetup',
        value: linkStr(summary.meetupName, summary.meetupMemberUrl),
        inline: true,
      },
      { name: 'Roles', value: text.roles, inline: true },
    );
  if (text.activity) {
    embed.addFields({ name: 'Activity', value: text.activity, inline: true });
  }
  return embed;
}
