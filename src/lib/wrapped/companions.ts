/**
 * Turns a ranking of other people (Meetup ids: the stats module's
 * co-attendees, or cohort.ts's early cohort) into the people a Wrapped may
 * name: linked members who are still on the server, as Discord user ids.
 * Everyone else becomes one number. This is the only place a Meetup id of
 * another member is looked at, and none leaves it.
 */
import { MemberRecord } from '../repositories/types.js';
import { CohortCandidate } from './cohort.js';
import { Companion, NamedCohort, WrappedEvent } from './stats.js';

export const NAMED_COMPANIONS = 10;
/** Postgres lookups per build for companions, so a hugely social member stays cheap. */
export const COMPANION_LOOKUP_CAP = 50;
/** Per top type. */
export const NAMED_COHORT = 10;
export const COHORT_LOOKUP_CAP = 25;

export interface NamedCompanion {
  discordUserId: string;
  sharedCount: number;
  /** This year's events you were both at; the top companion only. */
  sharedEvents?: WrappedEvent[];
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

/**
 * The generic walk: in rank order, keeps the first `limit` who are linked
 * and present, looking up at most `lookupCap`. `otherCount` is everyone
 * ranked who was not named.
 */
export async function nameRanked<T extends { meetupId: string }>(
  ranked: T[],
  deps: CompanionDeps,
  limit: number,
  lookupCap: number,
): Promise<{ named: (T & { discordUserId: string })[]; otherCount: number }> {
  const named: (T & { discordUserId: string })[] = [];
  const candidates = ranked.slice(0, lookupCap);
  // Sequential on purpose: each lookup only happens if the ones before it
  // haven't already filled the list.
  for (const candidate of candidates) {
    if (named.length >= limit) {
      break;
    }
    // eslint-disable-next-line no-await-in-loop
    const record = await deps.findByMeetupId(candidate.meetupId);
    // eslint-disable-next-line no-await-in-loop
    if (record && (await deps.isPresent(record.discordUserId))) {
      named.push({ ...candidate, discordUserId: record.discordUserId });
    }
  }
  return { named, otherCount: ranked.length - named.length };
}

/** The Meetup id and event ids stay here: the cache gets Discord ids and counts. */
export async function nameCompanions(
  ranked: Companion[],
  deps: CompanionDeps,
): Promise<NamedCompanions> {
  const { named, otherCount } = await nameRanked(
    ranked,
    deps,
    NAMED_COMPANIONS,
    COMPANION_LOOKUP_CAP,
  );
  return {
    named: named.map(({ discordUserId, sharedCount }) => ({
      discordUserId,
      sharedCount,
    })),
    otherCount,
  };
}

export async function nameCohort(
  ranked: CohortCandidate[],
  deps: CompanionDeps,
): Promise<NamedCohort> {
  const { named, otherCount } = await nameRanked(
    ranked,
    deps,
    NAMED_COHORT,
    COHORT_LOOKUP_CAP,
  );
  return {
    named: named.map(({ discordUserId, earlyCount, sharedCount }) => ({
      discordUserId,
      earlyCount,
      sharedCount,
    })),
    otherCount,
  };
}
