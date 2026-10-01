/**
 * "Where have we met?": the events two members both went to. An incentive
 * for the Reverify migration, since it only works once both people have
 * linked their Meetup accounts.
 *
 * Privacy: it only ever shows events the person asking attended themselves.
 */
import dayjs from 'dayjs';
import { ButtonInteraction, CommandInteraction } from 'discord.js';

import Configuration from '../../configuration.js';
import { linkStr } from '../../util/discord.js';
import { ApplicationMemberRepository } from '../../util/memberRepository.js';
import { withMeetupClient } from '../../util/meetup.js';
import { tz } from '../../util/timezone.js';
import { EventSummary } from '../client/meetup/types.js';
import { MemberRecord } from '../repositories/types.js';

const MOST_RECENT_SHOWN = 5;

/** Events both lists contain, oldest first, each once. */
export function sharedEvents(
  mine: EventSummary[],
  theirs: EventSummary[],
): EventSummary[] {
  const theirIds = new Set(theirs.map((event) => event.id));
  const byId = new Map(
    mine
      .filter((event) => theirIds.has(event.id))
      .map((event) => [event.id, event]),
  );
  return [...byId.values()].sort(
    (a, b) => dayjs(a.dateTime).valueOf() - dayjs(b.dateTime).valueOf(),
  );
}

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
  | { kind: 'requester-unlinked' }
  | { kind: 'target-unlinked' }
  | { kind: 'target-not-in-group' }
  | { kind: 'self' };

export interface WhereHaveWeMetDeps {
  findByDiscordId(discordUserId: string): Promise<MemberRecord | undefined>;
  /** Past events the member RSVP'd yes to or attended; undefined if they left. */
  pastRsvps(meetupId: string): Promise<EventSummary[] | undefined>;
}

export async function findSharedEvents(
  deps: WhereHaveWeMetDeps,
  requesterDiscordId: string,
  target: WhereHaveWeMetTarget,
): Promise<WhereHaveWeMetResult> {
  const myMeetupId = (await deps.findByDiscordId(requesterDiscordId))?.meetupId;
  if (!myMeetupId) {
    return { kind: 'requester-unlinked' };
  }
  const theirMeetupId =
    'meetupId' in target
      ? target.meetupId
      : (await deps.findByDiscordId(target.discordUserId))?.meetupId;
  if (!theirMeetupId) {
    return { kind: 'target-unlinked' };
  }
  if (theirMeetupId === myMeetupId) {
    return { kind: 'self' };
  }
  const [mine, theirs] = await Promise.all([
    deps.pastRsvps(myMeetupId),
    deps.pastRsvps(theirMeetupId),
  ]);
  if (theirs === undefined) {
    return { kind: 'target-not-in-group' };
  }
  return { kind: 'found', shared: sharedEvents(mine ?? [], theirs) };
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

const replies: Record<
  Exclude<WhereHaveWeMetResult['kind'], 'found'>,
  (theirName: string) => string
> = {
  'requester-unlinked': () =>
    'Link your Meetup account first: press **Link Meetup Account** in the get-verified channel. It takes about 10 seconds.',
  'target-unlinked': (theirName) =>
    `${theirName} hasn't linked their Meetup account yet, so there's nothing to compare. Nudge them to press **Link Meetup Account**!`,
  'target-not-in-group': (theirName) =>
    `${theirName} isn't a current member of the Meetup group, so their events can't be looked up.`,
  self: () => "That's you! Try it on someone you've met at an event.",
};

/** Runs the lookup for a Discord interaction and replies privately. */
export async function replyWhereHaveWeMet(
  interaction: ButtonInteraction | CommandInteraction,
  target: WhereHaveWeMetTarget,
  theirName: string,
): Promise<void> {
  const repo = await ApplicationMemberRepository();
  const reply = async (content: string) => {
    await interaction.followUp({ content, ephemeral: true });
  };
  const me = await repo.findByDiscordId(interaction.user.id);
  if (!me?.meetupId) {
    await reply(replies['requester-unlinked'](theirName));
    return;
  }
  await withMeetupClient(interaction, async (meetupClient) => {
    const result = await findSharedEvents(
      {
        findByDiscordId: (id) => repo.findByDiscordId(id),
        pastRsvps: (meetupId) =>
          meetupClient.getMemberRsvpEvents(
            meetupId,
            Configuration.meetup.groupId,
            { rsvpStatus: ['YES', 'ATTENDED'], eventStatus: ['PAST'] },
          ),
      },
      interaction.user.id,
      target,
    );
    await reply(
      result.kind === 'found'
        ? formatWhereHaveWeMet(theirName, result.shared)
        : replies[result.kind](theirName),
    );
  });
}
