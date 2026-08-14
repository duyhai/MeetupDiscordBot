import {
  CommandInteraction,
  EmbedBuilder,
  MessageContextMenuCommandInteraction,
  UserContextMenuCommandInteraction,
} from 'discord.js';

import { EMBED_COLORS } from '../../constants.js';
import { linkStr } from '../../util/discord.js';
import { ApplicationMemberRepository } from '../../util/memberRepository.js';
import { MemberRecord } from '../repositories/types.js';
import { logActivity } from './discordLogger.js';

const strings = {
  badMeetupInput:
    "Couldn't parse a Meetup member ID from that input. Use a profile URL like https://www.meetup.com/members/123456/ or a numeric ID.",
  noRowForUser: (userId: string) => `<@${userId}> has no member record.`,
  noRowForMeetup: 'No Discord account has linked that Meetup account.',
};

/** Interactions the whois lookups can reply to (slash + both context menus). */
export type WhoisLookupInteraction =
  | CommandInteraction
  | MessageContextMenuCommandInteraction
  | UserContextMenuCommandInteraction;

async function replyWithLookup(
  interaction: WhoisLookupInteraction,
  row: MemberRecord,
): Promise<void> {
  const embed = new EmbedBuilder()
    .setTitle('Member lookup')
    .setColor(EMBED_COLORS.info)
    .addFields(formatMemberFields(row))
    .setTimestamp(new Date());
  await interaction.followUp({ embeds: [embed], ephemeral: true });
}

// Lookups inspect member records, so each resolved target is audited to the
// activity channel (who looked up whom, and whether a record existed).
async function auditLookup(
  interaction: WhoisLookupInteraction,
  targetDescription: string,
  found: boolean,
): Promise<void> {
  await logActivity(interaction.client, {
    title: 'Member record looked up',
    description: `${interaction.user.toString()} looked up ${targetDescription}${
      found ? '' : ' — no record'
    }`,
  });
}

/** Discord user → their member record (linked Meetup account, if any). */
export async function whoisByDiscordUser(
  interaction: WhoisLookupInteraction,
  targetUserId: string,
): Promise<void> {
  const repo = await ApplicationMemberRepository();
  const row = await repo.findByDiscordId(targetUserId);
  if (!row) {
    await interaction.followUp({
      content: strings.noRowForUser(targetUserId),
      ephemeral: true,
    });
    await auditLookup(interaction, `<@${targetUserId}>`, false);
    return;
  }
  await replyWithLookup(interaction, row);
  await auditLookup(interaction, `<@${targetUserId}>`, true);
}

/** Meetup profile URL or numeric ID → the Discord account that claimed it. */
export async function whoisByMeetupInput(
  interaction: WhoisLookupInteraction,
  input: string,
): Promise<void> {
  const meetupId = parseMeetupMemberId(input);
  if (!meetupId) {
    // An unparseable URL is an expected mod typo, not a failure: reply
    // ephemerally instead of throwing into the wrapper's alert path.
    await interaction.followUp({
      content: strings.badMeetupInput,
      ephemeral: true,
    });
    return;
  }
  const repo = await ApplicationMemberRepository();
  const row = await repo.findByMeetupId(meetupId);
  if (!row) {
    await interaction.followUp({
      content: strings.noRowForMeetup,
      ephemeral: true,
    });
    await auditLookup(interaction, `Meetup ID ${meetupId}`, false);
    return;
  }
  await replyWithLookup(interaction, row);
  await auditLookup(
    interaction,
    `Meetup ID ${meetupId} (<@${row.discordUserId}>)`,
    true,
  );
}

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
