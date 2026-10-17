import dayjs from 'dayjs';
import { NO_SHOW_APPEAL_URL, NO_SHOW_POLICY_URL } from '../../constants.js';
import { tz } from '../../util/timezone.js';
import { neutralizeMentions } from '../helpers/neutralizeMentions.js';
import { recommendedSuspensionDays } from '../helpers/noShowReport.js';
import { parseUtcDateStrict } from '../helpers/suspensionCsv.js';
import { lastSuspendedDay } from '../helpers/suspensionList.js';
import type { SuspensionRecord } from '../repositories/types.js';

/**
 * Every word members will be messaged lives in this module, for Melissa and
 * Stacey to review. The text is plain: staff copy it into a Meetup or Discord
 * DM. Member-supplied values (names, event titles) pass through
 * neutralizeMentions so pasting never pings anyone; the page escapes the whole
 * text when it renders. The fixed wording has no "@", "<#" or "</".
 */
const SIGNATURE = '1.5 Gen Asians Organizers';

export const feeDollars = (prior: number): number => 10 * 2 ** prior;

export function firstName(memberName: string): string {
  const word = (typeof memberName === 'string' ? memberName : '')
    .trim()
    .split(/\s+/)[0];
  return word ? word : 'there';
}

/** 'September 3, 2026' in the group's timezone. */
const pacificDay = (dateTime: string): string =>
  tz(dayjs(dateTime)).format('MMMM D, YYYY');

/** A stored YYYY-MM-DD (UTC midnight convention) as 'October 30, 2026'. */
const calendarDay = (day: string): string =>
  dayjs.utc(`${day}T00:00:00Z`).format('MMMM D, YYYY');

const greeting = (memberName: string): string =>
  neutralizeMentions(firstName(memberName));

export function warningMessage(input: {
  memberName: string;
  event: { title: string; dateTime: string };
  priorSuspensions: number;
  hostWaiver: boolean;
}): string {
  const days = recommendedSuspensionDays(input.priorSuspensions);
  const penalty = input.hostWaiver
    ? `a ${days}-day suspension from the group.`
    : `a ${days}-day suspension from the group and a $${feeDollars(input.priorSuspensions)} admin fee to rejoin, ` +
      'which you can donate to any Asian charity of your choice (or pay to 1.5 Gen Asians).';
  return [
    `Hello ${greeting(input.memberName)}, our records show you RSVP'd to ${neutralizeMentions(input.event.title)} on ` +
      `${pacificDay(input.event.dateTime)} but were marked as a no-show. Cancellations within 48 hours also count ` +
      'as no-shows, so please update your RSVP at least 2 days ahead if your plans change. This is a friendly ' +
      `warning: a second no-show results in ${penalty} Our Attendance & No-Show Policy: ${NO_SHOW_POLICY_URL}. ` +
      `If you think this was a mistake, you can appeal here: ${NO_SHOW_APPEAL_URL}. Thank you!`,
    SIGNATURE,
  ].join('\n');
}

export function suspensionMessage(input: {
  memberName: string;
  counted: { title: string; dateTime: string }[];
  priorSuspensions: number;
  hostWaiver: boolean;
  /** YYYY-MM-DD, the first day of the suspension. */
  suspendedOn: string;
}): string {
  const days = recommendedSuspensionDays(input.priorSuspensions);
  const start = parseUtcDateStrict(input.suspendedOn);
  if (start === undefined) {
    throw new RangeError('suspendedOn must be YYYY-MM-DD');
  }
  // lastSuspendedDay reads only these two fields; it is the one place that owns the arithmetic.
  const span: Pick<SuspensionRecord, 'suspendedAt' | 'durationDays'> = {
    suspendedAt: start,
    durationDays: days,
  };
  const endDate = calendarDay(lastSuspendedDay(span as SuspensionRecord));
  const fee = input.hostWaiver
    ? ''
    : `Rejoining requires a $${feeDollars(input.priorSuspensions)} admin fee, which you can donate to any Asian ` +
      'charity of your choice (or pay to 1.5 Gen Asians). ';
  return [
    `Hello ${greeting(input.memberName)}, our records show ${input.counted.length} no-shows:`,
    ...input.counted.map(
      (e) => `- ${neutralizeMentions(e.title)}, ${pacificDay(e.dateTime)}`,
    ),
    '',
    `Under our Attendance & No-Show Policy (${NO_SHOW_POLICY_URL}), you are being suspended from the group for ` +
      `${days} days. Your current RSVPs will be removed. After ${endDate}, you can reapply to join on Meetup. ` +
      `${fee}If you think this was a mistake, you can appeal here: ${NO_SHOW_APPEAL_URL}. Thank you for understanding.`,
    SIGNATURE,
  ].join('\n');
}
