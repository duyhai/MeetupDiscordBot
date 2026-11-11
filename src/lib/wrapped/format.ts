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
  escapeMarkdown,
} from 'discord.js';

import { EMBED_COLORS, GET_VERIFIED_CHANNEL_ID } from '../../constants.js';
import { neutralizeMentions } from '../helpers/neutralizeMentions.js';
import { EVENT_TYPE_LABELS } from '../hosts/eventTypes.js';
import { tz } from '../../util/timezone.js';
import { CachedWrapped } from './cache.js';
import { WrappedEvent } from './stats.js';

export const SHARE_BUTTON_PREFIX = 'wrapped_share';
/** The embed names this many companions; the cache may hold more (the website shows them). */
export const EMBED_NAMED_COMPANIONS = 3;
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

/**
 * Private view: linked companions as `<@id>` mentions (only the member sees
 * them). Shared view (Hai, 2026-11-10): the same people as plain server
 * display names, never tags, so a public post names nobody in a way that
 * notifies or links them; a companion whose name can't be resolved any more
 * is folded into the count.
 */
export type EmbedView =
  | { kind: 'private' }
  | { kind: 'shared'; displayNames: Record<string, string> };

/**
 * A display name as inert text: no markdown (links, headings and lists
 * included), no mention or channel link. Angle brackets go too, so a
 * nickname written as "<@123>" can't render as a tag in the public post.
 */
function plainName(name: string): string {
  const escaped = escapeMarkdown(name.replace(/[<>]/g, ''), {
    // Off by default in discord.js 14: a nickname "[free nitro](https://…)"
    // would otherwise render as a live link in the public post.
    maskedLink: true,
    heading: true,
    bulletedList: true,
    numberedList: true,
  });
  // Belt and braces for the link syntax: "](" can't pair up any more.
  // escapeMarkdown knows no subtext ("-# "), so a leading one is broken
  // up too (#138 review).
  return neutralizeMentions(
    escaped.replace(/\]\(/g, ']\u200b(').replace(/^-#/, '\\-#'),
  );
}

function companionsText(wrapped: CachedWrapped, view: EmbedView): string {
  const { named, otherCount } = wrapped.companions;
  if (named.length === 0 && otherCount === 0) {
    return 'Nobody yet — next year!';
  }
  const shown: string[] = [];
  // The first three that can be shown; everyone else named (past three, or
  // unresolvable in the shared view) joins the count, like anyone unnamed.
  let others = otherCount;
  named.forEach(({ discordUserId, sharedCount }) => {
    const label =
      view.kind === 'private'
        ? `<@${discordUserId}>`
        : view.displayNames[discordUserId];
    if (label === undefined || shown.length >= EMBED_NAMED_COMPANIONS) {
      others += 1;
      return;
    }
    const text = view.kind === 'private' ? label : plainName(label);
    shown.push(`${text} (${plural(sharedCount, 'event')})`);
  });
  const othersText =
    others > 0 ? `${plural(others, 'other member')}` : undefined;
  if (shown.length === 0) {
    return `${othersText} you shared events with`;
  }
  return othersText
    ? `${shown.join(', ')} and ${othersText}`
    : shown.join(', ');
}

export function wrappedEmbed(
  displayName: string,
  wrapped: CachedWrapped,
  view: EmbedView = { kind: 'private' },
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
    value: companionsText(wrapped, view),
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
  buildFailed:
    "Couldn't build your Wrapped right now — try again in a little while.",
  alreadyBuilding:
    "Your Wrapped is already being built — hang on, it's on its way.",
  stillBuilding:
    "Still building your Wrapped — you've been busy! I'll DM you when it's ready.",
  shareExpired: 'Your Wrapped has expired; run `/wrapped` again to share it.',
  alreadyShared: 'You already shared this Wrapped here today.',
  cannotShareHere:
    "I can't post your Wrapped in that channel. Run `/wrapped` where you'd like to share it.",
  shared: 'Shared! 🎉',
};
