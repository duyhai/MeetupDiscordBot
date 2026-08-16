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

/**
 * The single message a member sees after linking.
 *
 * Verification used to answer in pieces -- a welcome, a roles line, a badges
 * line, and "Sit tight!" twice -- because each step was once its own command.
 * Behind one button that reads as four half-answers, so the steps now report
 * their results and this composes them.
 */
export function buildVerificationSummary({
  attendedCount,
  hostedCount,
  meetupMemberUrl,
  meetupName,
  rolesGranted,
}: VerificationSummary): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setTitle('✅ You are verified')
    .setColor(SUCCESS_COLOR)
    .setDescription(
      'You now have access to the members-only channels. Pick the ones you ' +
        'want at <id:browse>.',
    )
    .addFields(
      {
        name: 'Meetup',
        value: linkStr(meetupName, meetupMemberUrl),
        inline: true,
      },
      {
        name: 'Roles',
        // A brand-new member earns nothing beyond membership, which is the
        // common case -- "none" would read like something went wrong.
        value: rolesGranted.length
          ? rolesGranted.join(', ')
          : 'Verified member',
        inline: true,
      },
    );

  // Same reasoning for activity: a first-timer's "0 hosted, 0 attended" makes
  // a successful verification look like a failure, so it is simply omitted
  // until there is something to celebrate.
  if (hostedCount > 0 || attendedCount > 0) {
    const parts = [];
    if (attendedCount > 0) parts.push(`${attendedCount} attended`);
    if (hostedCount > 0) parts.push(`${hostedCount} hosted`);
    embed.addFields({
      name: 'Activity',
      value: `${parts.join(' · ')} — badges applied`,
      inline: true,
    });
  }

  return embed;
}
