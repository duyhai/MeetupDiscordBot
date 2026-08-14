import { linkStr } from '../../util/discord.js';
import { MemberRecord } from '../repositories/types.js';

/**
 * Extracts a Meetup member ID from a raw numeric ID or a profile URL
 * (e.g. https://www.meetup.com/members/186893524/).
 */
export function parseMeetupMemberId(input: string): string | undefined {
  const trimmed = input.trim();
  if (/^\d+$/.test(trimmed)) {
    return trimmed;
  }
  // Anchored to the start of the (trimmed) input so the host must actually be
  // meetup.com — lookalike domains and meetup.com embedded in a hostile URL's
  // path (evil.com/meetup.com/members/...) are both rejected. The optional
  // locale segment accepts localized URLs (meetup.com/es/members/...).
  const match =
    /^(?:https?:\/\/)?(?:www\.)?meetup\.com\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?members\/(\d+)(?:[/?#]|$)/i.exec(
      trimmed,
    );
  return match ? match[1] : undefined;
}

const discordDate = (date: Date) =>
  `<t:${Math.floor(date.getTime() / 1000)}:D>`;

/**
 * Builds the embed fields for a member-record lookup reply.
 */
export function formatMemberFields(
  record: MemberRecord,
): { inline?: boolean; name: string; value: string }[] {
  const meetupAccount = record.meetupId
    ? linkStr(
        record.meetupName ?? record.meetupId,
        record.meetupMemberUrl ??
          `https://www.meetup.com/members/${record.meetupId}/`,
      )
    : 'not linked';

  return [
    { name: 'Discord user', value: `<@${record.discordUserId}>`, inline: true },
    { name: 'Meetup account', value: meetupAccount, inline: true },
    ...(record.meetupId
      ? [{ name: 'Meetup ID', value: record.meetupId, inline: true }]
      : []),
    { name: 'Onboard method', value: record.onboardMethod, inline: true },
    ...(record.onboardedBy
      ? [
          {
            name: 'Onboarded by',
            value: `<@${record.onboardedBy}>`,
            inline: true,
          },
        ]
      : []),
    {
      name: 'First onboarded',
      value: discordDate(record.firstOnboardedAt),
      inline: true,
    },
    {
      name: 'Last synced',
      value: discordDate(record.lastSyncedAt),
      inline: true,
    },
  ];
}
