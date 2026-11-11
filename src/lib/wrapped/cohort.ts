/**
 * "Still around from your early cohort": the people at a member's first
 * events of a type who also shared an event with them this year. Pure, over
 * Meetup ids; naming them (linked and present only) is companions.ts's job,
 * so no name of another member can leave here.
 */
import { Companion, WrappedEvent } from './stats.js';

export interface CohortCandidate {
  meetupId: string;
  /** Of the type's first events, how many they were at too. */
  earlyCount: number;
  /** This year's events shared. */
  sharedCount: number;
}

const byNumericId = (a: string, b: string) =>
  a.localeCompare(b, undefined, { numeric: true });

/**
 * Ids seen at `firstEvents` (self excluded, counted once per event) that
 * also appear in `yearCompanions`; earlyCount desc, sharedCount desc,
 * numeric id asc.
 */
export function rankCohort(
  firstEvents: WrappedEvent[],
  attendeesByEvent: Record<string, string[]>,
  yearCompanions: Companion[],
  selfMeetupId: string,
): CohortCandidate[] {
  const sharedThisYear = new Map(
    yearCompanions.map(({ meetupId, sharedCount }) => [meetupId, sharedCount]),
  );
  const early = new Map<string, number>();
  firstEvents.forEach((event) => {
    new Set(attendeesByEvent[event.id] ?? []).forEach((meetupId) => {
      if (meetupId !== selfMeetupId && sharedThisYear.has(meetupId)) {
        early.set(meetupId, (early.get(meetupId) ?? 0) + 1);
      }
    });
  });
  return [...early.entries()]
    .map(([meetupId, earlyCount]) => ({
      meetupId,
      earlyCount,
      sharedCount: sharedThisYear.get(meetupId) ?? 0,
    }))
    .sort(
      (a, b) =>
        b.earlyCount - a.earlyCount ||
        b.sharedCount - a.sharedCount ||
        byNumericId(a.meetupId, b.meetupId),
    );
}

/** Event ids of every type's first events, deduped, minus `alreadyFetched`. */
export function earlyEventIdsToFetch(
  topTypes: { firstEvents: WrappedEvent[] }[],
  alreadyFetched: Iterable<string>,
): string[] {
  const fetched = new Set(alreadyFetched);
  const ids: string[] = [];
  topTypes.forEach(({ firstEvents }) =>
    firstEvents.forEach(({ id }) => {
      if (!fetched.has(id)) {
        fetched.add(id);
        ids.push(id);
      }
    }),
  );
  return ids;
}
