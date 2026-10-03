/**
 * "Where have we met?": the events two members both went to. An incentive
 * for the Reverify migration, since right-clicking someone only works once
 * they have linked their Meetup account.
 *
 * Privacy: it starts from the events the person asking went to themselves
 * and checks each one's attendee list, so it only ever shows what they could
 * already see on Meetup.
 */
import dayjs from 'dayjs';
import { ButtonInteraction, CommandInteraction } from 'discord.js';

import Configuration from '../../configuration.js';
import { linkStr } from '../../util/discord.js';
import { ApplicationMemberRepository } from '../../util/memberRepository.js';
import { withMeetupClient } from '../../util/meetup.js';
import { tz } from '../../util/timezone.js';
import {
  getPaginatedData,
  mapWithConcurrency,
} from '../client/meetup/paginationHelper.js';
import { EventSummary } from '../client/meetup/types.js';
import { MemberRecord } from '../repositories/types.js';

const MOST_RECENT_SHOWN = 5;
// One attendee-list fetch per event the requester went to; the lists are
// cached, so only the first lookup after a cache expiry pays for them.
const ATTENDEE_FETCH_CONCURRENCY = 5;

/** A Meetup profile link (…/members/<id>/…) or a bare member ID. */
export function parseMeetupMemberId(input: string): string | undefined {
  const trimmed = input.trim();
  if (/^\d+$/.test(trimmed)) {
    return trimmed;
  }
  return /meetup\.com\/members\/(\d+)/.exec(trimmed)?.[1];
}

export type WhereHaveWeMetTarget =
  { discordUserId: string } | { meetupId: string };

export type WhereHaveWeMetResult =
  | { kind: 'found'; shared: EventSummary[] }
  | { kind: 'target-unlinked' }
  | { kind: 'self' };

export interface WhereHaveWeMetDeps {
  /** Meetup member IDs of everyone who RSVP'd yes to or attended the event. */
  attendeeIds(eventId: string): Promise<string[]>;
  findByDiscordId(discordUserId: string): Promise<MemberRecord | undefined>;
  /** The requester's Meetup ID and the past events they went to. */
  myPastEvents(): Promise<{ events: EventSummary[]; meetupId: string }>;
}

/** The other person's Meetup ID, or undefined if they haven't linked. */
export async function resolveTargetMeetupId(
  deps: Pick<WhereHaveWeMetDeps, 'findByDiscordId'>,
  target: WhereHaveWeMetTarget,
): Promise<string | undefined> {
  if ('meetupId' in target) {
    return target.meetupId;
  }
  return (
    (await deps.findByDiscordId(target.discordUserId))?.meetupId ?? undefined
  );
}

/** The requester's events the other person also went to, oldest first. */
export async function findSharedEvents(
  deps: WhereHaveWeMetDeps,
  theirMeetupId: string,
): Promise<WhereHaveWeMetResult> {
  const { meetupId: myMeetupId, events } = await deps.myPastEvents();
  if (theirMeetupId === myMeetupId) {
    return { kind: 'self' };
  }
  const mine = [...new Map(events.map((event) => [event.id, event])).values()];
  const wentToo = await mapWithConcurrency(
    mine,
    ATTENDEE_FETCH_CONCURRENCY,
    async (event) => (await deps.attendeeIds(event.id)).includes(theirMeetupId),
  );
  const shared = mine
    .filter((_, index) => wentToo[index])
    .sort((a, b) => dayjs(a.dateTime).valueOf() - dayjs(b.dateTime).valueOf());
  return { kind: 'found', shared };
}

function eventDay(event: EventSummary): string {
  return tz(dayjs(event.dateTime)).format('ll');
}

export function formatWhereHaveWeMet(
  theirName: string,
  shared: EventSummary[],
): string {
  if (shared.length === 0) {
    return `You and ${theirName} haven't been to the same event yet. Maybe the next one!`;
  }
  const [first] = shared;
  const recent = shared.slice(-MOST_RECENT_SHOWN).reverse();
  return [
    `You and ${theirName} first met at ${linkStr(
      first.title,
      first.eventUrl,
    )} on ${eventDay(first)}.`,
    shared.length === 1
      ? "That's the only event you've been to together so far."
      : `You've been to ${shared.length} events together.`,
    ...(shared.length > 1
      ? [
          '',
          'Most recent:',
          ...recent.map(
            (event) =>
              `- ${linkStr(event.title, event.eventUrl)}, ${eventDay(event)}`,
          ),
        ]
      : []),
  ].join('\n');
}

const replies = {
  targetUnlinked: (theirName: string) =>
    `${theirName} hasn't linked their Meetup account yet, so I can't look them up from Discord. ` +
    'Nudge them to press **Link Meetup Account**! ' +
    'If you know their Meetup profile, you can also run `/where_have_we_met meetup_profile:` with its link.',
  self: "That's you! Try it on someone you've met at an event.",
};

/** Runs the lookup for a Discord interaction and replies privately. */
export async function replyWhereHaveWeMet(
  interaction: ButtonInteraction | CommandInteraction,
  target: WhereHaveWeMetTarget,
  theirName: string,
): Promise<void> {
  const reply = async (content: string) => {
    await interaction.followUp({ content, ephemeral: true });
  };
  if (
    'discordUserId' in target &&
    target.discordUserId === interaction.user.id
  ) {
    await reply(replies.self);
    return;
  }
  const repo = await ApplicationMemberRepository();
  const findByDiscordId = (id: string) => repo.findByDiscordId(id);
  // Checked before the Meetup sign-in, so nobody signs in just to be told
  // the other person hasn't linked.
  const theirMeetupId = await resolveTargetMeetupId(
    { findByDiscordId },
    target,
  );
  if (!theirMeetupId) {
    await reply(replies.targetUnlinked(theirName));
    return;
  }
  await withMeetupClient(interaction, async (meetupClient) => {
    await interaction.editReply({
      content: 'Looking through the events you went to…',
      components: [],
    });
    const result = await findSharedEvents(
      {
        findByDiscordId,
        myPastEvents: () =>
          meetupClient.getSelfPastRsvpEvents(Configuration.meetup.groupId),
        attendeeIds: async (eventId) => {
          const rsvps = await getPaginatedData(async (paginationInput) => {
            // The same filter the stats commands use, so the cached
            // attendee lists are shared with them.
            const page = await meetupClient.getEventRsvps(
              eventId,
              paginationInput,
              { rsvpStatus: ['ATTENDED', 'YES'] },
            );
            return page.event.rsvps;
          });
          return rsvps.map((rsvp) => rsvp.member.id);
        },
      },
      theirMeetupId,
    );
    await reply(
      result.kind === 'found'
        ? formatWhereHaveWeMet(theirName, result.shared)
        : replies.self,
    );
  });
}
