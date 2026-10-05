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
import { hasCancelledTitle } from './hallOfFame.js';

const MOST_RECENT_SHOWN = 5;
// One attendee-list fetch per event the requester went to; the lists are
// cached, so only the first lookup after a cache expiry pays for them.
const ATTENDEE_FETCH_CONCURRENCY = 5;

/**
 * How the other person's attendance is read:
 * - attendee-lists (default): check the attendee list of each event the
 *   requester went to. Uses only what any member can see on Meetup.
 * - member-rsvps: read the other person's RSVP list directly. Two requests
 *   instead of one per event, but not yet verified to work for a requester
 *   who isn't an organizer. Set WHERE_HAVE_WE_MET_LOOKUP=member-rsvps to
 *   switch once it is.
 */
export type SharedEventsLookup = 'attendee-lists' | 'member-rsvps';

export function configuredLookup(
  value = process.env.WHERE_HAVE_WE_MET_LOOKUP,
): SharedEventsLookup {
  return value === 'member-rsvps' ? 'member-rsvps' : 'attendee-lists';
}

/**
 * A Meetup profile link or a bare member ID. Accepts the plain link
 * (meetup.com/members/<id>/) and the ones copied from a group's member list
 * or a localized page (meetup.com/<group or locale>/members/<id>/).
 */
export function parseMeetupMemberId(input: string): string | undefined {
  const trimmed = input.trim();
  if (/^\d+$/.test(trimmed)) {
    return trimmed;
  }
  let url: URL;
  try {
    url = new URL(
      /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`,
    );
  } catch {
    return undefined;
  }
  if (url.hostname !== 'meetup.com' && !url.hostname.endsWith('.meetup.com')) {
    return undefined;
  }
  return /(?:^|\/)members\/(\d+)(?:\/|$)/.exec(url.pathname)?.[1];
}

export type WhereHaveWeMetTarget =
  { discordUserId: string } | { meetupId: string };

export type WhereHaveWeMetResult =
  | { kind: 'found'; shared: EventSummary[] }
  | { kind: 'target-unlinked' }
  | { kind: 'target-not-in-group' }
  | { kind: 'self' };

export interface WhereHaveWeMetDeps {
  /** Meetup member IDs of everyone who RSVP'd yes to or attended the event. */
  attendeeIds(eventId: string): Promise<string[]>;
  findByDiscordId(discordUserId: string): Promise<MemberRecord | undefined>;
  /** The requester's Meetup ID and the past events they went to. */
  myPastEvents(): Promise<{ events: EventSummary[]; meetupId: string }>;
  /**
   * member-rsvps lookup only: past events the member RSVP'd yes to or
   * attended; undefined if they aren't in the group any more.
   */
  theirPastEvents(meetupId: string): Promise<EventSummary[] | undefined>;
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
  lookup: SharedEventsLookup = 'attendee-lists',
): Promise<WhereHaveWeMetResult> {
  const { meetupId: myMeetupId, events } = await deps.myPastEvents();
  if (theirMeetupId === myMeetupId) {
    return { kind: 'self' };
  }
  // Hosts sometimes rename an event "cancelled" instead of cancelling it on
  // the platform; nobody met at those.
  const mine = [
    ...new Map(events.map((event) => [event.id, event])).values(),
  ].filter((event) => !hasCancelledTitle(event.title));
  let theyWent: (event: EventSummary) => Promise<boolean>;
  if (lookup === 'member-rsvps') {
    const theirs = await deps.theirPastEvents(theirMeetupId);
    if (theirs === undefined) {
      return { kind: 'target-not-in-group' };
    }
    const theirIds = new Set(theirs.map((event) => event.id));
    theyWent = async (event) => theirIds.has(event.id);
  } else {
    theyWent = async (event) =>
      (await deps.attendeeIds(event.id)).includes(theirMeetupId);
  }
  const wentToo = await mapWithConcurrency(
    mine,
    ATTENDEE_FETCH_CONCURRENCY,
    theyWent,
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
  targetNotInGroup: (theirName: string) =>
    `${theirName} isn't a current member of the Meetup group, so their events can't be looked up.`,
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
        theirPastEvents: (meetupId) =>
          meetupClient.getMemberRsvpEvents(
            meetupId,
            Configuration.meetup.groupId,
            { rsvpStatus: ['YES', 'ATTENDED'], eventStatus: ['PAST'] },
          ),
      },
      theirMeetupId,
      configuredLookup(),
    );
    if (result.kind === 'found') {
      await reply(formatWhereHaveWeMet(theirName, result.shared));
    } else if (result.kind === 'target-not-in-group') {
      await reply(replies.targetNotInGroup(theirName));
    } else {
      await reply(replies.self);
    }
  });
}
