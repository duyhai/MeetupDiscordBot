/**
 * Turns the stats module's ranking of co-attendees (Meetup ids) into the
 * people a Wrapped may name: linked members who are still on the server,
 * as Discord user ids. Everyone else becomes one number. This is the only
 * place a Meetup id of another member is looked at, and none leaves it.
 */
import { MemberRecord } from '../repositories/types.js';
import { Companion } from './stats.js';

export const NAMED_COMPANIONS = 3;
/** Postgres lookups per build, so a hugely social member stays cheap. */
export const COMPANION_LOOKUP_CAP = 25;

export interface NamedCompanion {
  discordUserId: string;
  sharedCount: number;
}

export interface NamedCompanions {
  named: NamedCompanion[];
  /** Co-attendees that year who are not named: an aggregate, never a name. */
  otherCount: number;
}

export interface CompanionDeps {
  findByMeetupId(meetupId: string): Promise<MemberRecord | undefined>;
  /** Whether the linked Discord account is still on the server. */
  isPresent(discordUserId: string): Promise<boolean>;
}

export async function nameCompanions(
  ranked: Companion[],
  deps: CompanionDeps,
): Promise<NamedCompanions> {
  const named: NamedCompanion[] = [];
  const candidates = ranked.slice(0, COMPANION_LOOKUP_CAP);
  // Sequential on purpose: each lookup only happens if the ones before it
  // haven't already filled the list.
  for (const { meetupId, sharedCount } of candidates) {
    if (named.length >= NAMED_COMPANIONS) {
      break;
    }
    // eslint-disable-next-line no-await-in-loop
    const record = await deps.findByMeetupId(meetupId);
    // eslint-disable-next-line no-await-in-loop
    if (record && (await deps.isPresent(record.discordUserId))) {
      named.push({ discordUserId: record.discordUserId, sharedCount });
    }
  }
  return { named, otherCount: ranked.length - named.length };
}
