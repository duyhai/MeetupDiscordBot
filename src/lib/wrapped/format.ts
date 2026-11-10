/**
 * How a Wrapped looks: one embed, the same privately and when shared, built
 * from the cached stats. Other people appear only as Discord mentions of
 * linked members (the cache holds nothing else about them).
 */
import dayjs from 'dayjs';
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  MessageActionRowComponentBuilder,
} from 'discord.js';

import { EMBED_COLORS, GET_VERIFIED_CHANNEL_ID } from '../../constants.js';
import { EVENT_TYPE_LABELS } from '../hosts/eventTypes.js';
import { tz } from '../../util/timezone.js';
import { CachedWrapped } from './cache.js';
import { WrappedEvent } from './stats.js';

export const SHARE_BUTTON_PREFIX = 'wrapped_share';
export const SHARE_BUTTON_ID_PATTERN = /^wrapped_share:(\d{4}):(\d+)$/;

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

export function shareCustomId(year: number, channelId: string): string {
  return `${SHARE_BUTTON_PREFIX}:${year}:${channelId}`;
}

export function parseShareCustomId(
  customId: string,
): { year: number; channelId: string } | undefined {
  const match = SHARE_BUTTON_ID_PATTERN.exec(customId);
  return match ? { year: Number(match[1]), channelId: match[2] } : undefined;
}

/** Angle-bracketed URL: Discord renders no preview card. */
function quietLink(text: string, url: string): string {
  return `[${text}](<${url}>)`;
}

function eventDay(event: WrappedEvent): string {
  return tz(dayjs(event.dateTime)).format('ll');
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

function thisYearText(wrapped: CachedWrapped): string {
  const { attendedThisYear, attendedAllTime, year } = wrapped.stats;
  if (attendedThisYear === 0) {
    return (
      `A quiet year: no events in ${year}, but ${plural(attendedAllTime, 'event')} ` +
      'with us all-time. See you at the next one!'
    );
  }
  return `${plural(attendedThisYear, 'event')} in ${year} (${attendedAllTime} all-time).`;
}

function companionsText(wrapped: CachedWrapped): string {
  const { named, otherCount } = wrapped.companions;
  if (named.length === 0 && otherCount === 0) {
    return 'Nobody yet — next year!';
  }
  const mentions = named.map(
    ({ discordUserId, sharedCount }) =>
      `<@${discordUserId}> (${plural(sharedCount, 'event')})`,
  );
  const others =
    otherCount > 0 ? `${plural(otherCount, 'other member')}` : undefined;
  if (mentions.length === 0) {
    return `${others} you shared events with`;
  }
  return others ? `${mentions.join(', ')} and ${others}` : mentions.join(', ');
}

export function wrappedEmbed(
  displayName: string,
  wrapped: CachedWrapped,
): EmbedBuilder {
  const { stats } = wrapped;
  const embed = new EmbedBuilder()
    .setTitle(`🎁 ${displayName}'s 1.5 Gen Wrapped ${stats.year}`)
    .setColor(EMBED_COLORS.info)
    .setFooter({
      text: 'Counted from Meetup RSVPs, so an event you signed up for but missed still counts.',
    });

  embed.addFields({
    name: 'First event with us',
    value: stats.firstEvent
      ? `${quietLink(stats.firstEvent.title, stats.firstEvent.eventUrl)} on ${eventDay(stats.firstEvent)}`
      : 'Still ahead of you!',
  });
  embed.addFields({ name: 'This year', value: thisYearText(wrapped) });
  embed.addFields({
    name: 'Top activities',
    value:
      stats.topTypes.length > 0
        ? stats.topTypes
            .map(
              ({ type, count }) =>
                `${EVENT_TYPE_LABELS[type]} (${plural(count, 'event')})`,
            )
            .join(', ')
        : 'None this year',
  });
  if (stats.hosting) {
    embed.addFields({
      name: 'Hosting',
      value: `You hosted ${plural(stats.hosting.thisYear, 'event')} this year (${stats.hosting.allTime} all-time). Thank you!`,
    });
  }
  embed.addFields({
    name: 'Busiest month',
    value: stats.busiestMonth
      ? `${MONTHS[stats.busiestMonth.month]} (${plural(stats.busiestMonth.count, 'event')})`
      : 'None this year',
  });
  embed.addFields({
    name: 'Longest streak',
    value:
      stats.longestStreakMonths > 0
        ? `${plural(stats.longestStreakMonths, 'month')} in a row with at least one event`
        : 'None this year',
  });
  embed.addFields({
    name: 'Went with the most',
    value: companionsText(wrapped),
  });
  return embed;
}

export function shareButtonRow(
  year: number,
  channelId: string,
): ActionRowBuilder<MessageActionRowComponentBuilder> {
  const button = new ButtonBuilder()
    .setLabel('Share to this channel')
    .setEmoji('📣')
    .setStyle(ButtonStyle.Primary)
    .setCustomId(shareCustomId(year, channelId));
  return new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
    button,
  );
}

export function sharedPostContent(sharerUserId: string, year: number): string {
  return `<@${sharerUserId}> shared their 1.5 Gen Wrapped ${year}`;
}

export const replies = {
  notLinked:
    'Wrapped is for linked members. Press **Link Meetup Account** in ' +
    `<#${GET_VERIFIED_CHANNEL_ID}> to link your Meetup account, then run ` +
    '`/wrapped` again.',
  rateLimited: (minutes: number) =>
    `You built your Wrapped less than an hour ago; try again in ${plural(minutes, 'minute')}.`,
  accountMismatch:
    "The Meetup account you're connected to isn't the one linked to your Discord. " +
    'Press **Link Meetup Account** to reconnect, then run `/wrapped` again.',
  notInGroup:
    "I can't see your Meetup history. Are you still a member of the Meetup group?",
  stillBuilding:
    "Still building your Wrapped — you've been busy! I'll DM you when it's ready.",
  shareExpired: 'Your Wrapped has expired; run `/wrapped` again to share it.',
  alreadyShared: 'You already shared this Wrapped here today.',
  cannotShareHere:
    "I can't post your Wrapped in that channel. Run `/wrapped` where you'd like to share it.",
  shared: 'Shared! 🎉',
};
