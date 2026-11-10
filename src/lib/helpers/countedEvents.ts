/**
 * The one rule for which group events count as hosted or attended. Used by
 * the Hall of Fame and no-show reports, the Guest Host badge count and
 * role, the host dashboard (history, heat maps, candidates) and Wrapped, so
 * a host's number is the same wherever they see it.
 *
 * - Cancelled events never happened: Meetup's cancelled statuses, and a
 *   title saying "cancelled" (hosts sometimes rename an event instead of
 *   cancelling it on the platform).
 * - An Open House is a drop-in session the group tags in the title
 *   ("[Open House] …", "… (Open House)"), not a hosted event: nobody ran
 *   it. Verified against every past group event on 2026-11-10: 73 of the
 *   74 titles containing "open house" carry the tag in brackets or
 *   parentheses; the one that does not ("Theodor Jacobsen Observatory
 *   Open House") is an outing at a venue's open house and keeps counting.
 */
import { EventStatus } from '../client/meetup/types.js';

const CANCELLED_TITLE = /cancell?ed/i;
const CANCELLED_STATUSES: readonly EventStatus[] = [
  'CANCELLED',
  'CANCELLED_PERM',
  'AUTOSCHED_CANCELLED',
];
/** The tag form only: "[Open House]", "[ Open House ]", "(Open House)". */
const OPEN_HOUSE_TAG = /[[(]\s*open\s+house\s*[\])]/i;

/** What the rule looks at; status is optional where a list has none. */
export type CountedEventLike = { title: string; status?: EventStatus };

export function hasCancelledTitle(title: string): boolean {
  return CANCELLED_TITLE.test(title);
}

export function isCancelledEvent(event: CountedEventLike): boolean {
  return (
    hasCancelledTitle(event.title) ||
    (event.status !== undefined && CANCELLED_STATUSES.includes(event.status))
  );
}

export function isOpenHouseEvent(
  event: Pick<CountedEventLike, 'title'>,
): boolean {
  return OPEN_HOUSE_TAG.test(event.title);
}

/** Whether an event counts as hosted: not cancelled, not an Open House. */
export function countsAsHosted(event: CountedEventLike): boolean {
  return !isCancelledEvent(event) && !isOpenHouseEvent(event);
}

/**
 * Whether an event counts as attended: not cancelled. Going to an Open
 * House is still going to a group event, so it counts here (my call; the
 * hosted rule is the one leadership asked for).
 */
export function countsAsAttended(event: CountedEventLike): boolean {
  return !isCancelledEvent(event);
}

/** Why an event is not counted as hosted, for a page that shows the excluded. */
export function hostedExclusion(
  event: CountedEventLike,
): 'cancelled' | 'open-house' | undefined {
  if (isCancelledEvent(event)) {
    return 'cancelled';
  }
  return isOpenHouseEvent(event) ? 'open-house' : undefined;
}
