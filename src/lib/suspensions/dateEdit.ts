import { Logger } from 'tslog';

import { PUBLIC_APP_ORIGIN } from '../../constants.js';
import type { LogEntry } from '../helpers/discordLogger.js';
import { parseUtcDateStrict } from '../helpers/suspensionCsv.js';
import { pacificToday, utcDateOnly } from '../helpers/suspensionList.js';
import { DASHBOARD_PATHS, dashboardPath } from '../reports/dashboardPaths.js';
import type { PostgresSuspensionRepository } from '../repositories/postgresSuspensionRepository.js';
import { postWithoutWaiting } from '../workspace/service.js';

const logger = new Logger({ name: 'suspensionDateEdit' });

/** The earliest suspension date the dashboard takes (as a ban date). */
export const FIRST_SUSPENSION_DAY = '2013-03-01';

export type DateEditCode =
  | 'date-changed'
  | 'date-unchanged'
  | 'not-live'
  | 'date-taken'
  | 'overlaps'
  | 'reorders'
  | 'linked-month'
  | 'bad-date'
  | 'invalid'
  | 'error';

export interface DateEditDeps {
  now(): Date;
  repository(): Promise<Pick<PostgresSuspensionRepository, 'editDate'>>;
  /** The moderation log (embed only, no pings); fire and forget. */
  moderationLog(entry: LogEntry): Promise<unknown>;
}

const DISCORD_ID = /^[0-9]{17,20}$/;
const MAX_SERIAL = 2 ** 31 - 1;

/**
 * Leadership's date fix on a live suspension record. The caller has already
 * asked Discord live that `actor` holds the 1.5 Leadership Team role (this
 * takes no other path in). `date` is the form's YYYY-MM-DD: from
 * FIRST_SUSPENSION_DAY through Pacific today. A repository error propagates;
 * the route answers it.
 */
export async function editSuspensionDate(
  deps: DateEditDeps,
  input: {
    actor: string;
    id: number;
    date: unknown;
    leadershipConfirmed: true;
  },
): Promise<{ code: DateEditCode }> {
  if (
    input.leadershipConfirmed !== true ||
    typeof input.actor !== 'string' ||
    !DISCORD_ID.test(input.actor) ||
    !Number.isSafeInteger(input.id) ||
    input.id < 1 ||
    input.id > MAX_SERIAL
  ) {
    return { code: 'invalid' };
  }
  const day = typeof input.date === 'string' ? input.date.trim() : '';
  const suspendedAt = parseUtcDateStrict(day);
  if (
    suspendedAt === undefined ||
    day < FIRST_SUSPENSION_DAY ||
    day > pacificToday(deps.now())
  ) {
    return { code: 'bad-date' };
  }
  const outcome = await (
    await deps.repository()
  ).editDate({ id: input.id, suspendedAt, editedBy: input.actor });
  if (outcome.ok === false) {
    return {
      code: outcome.reason === 'unchanged' ? 'date-unchanged' : outcome.reason,
    };
  }
  postWithoutWaiting(deps, {
    title: 'Suspension date changed',
    // The record id and dates only, never the member's name (as the ban log).
    description:
      `<@${input.actor}> changed the date of suspension #${input.id}.\n` +
      `${PUBLIC_APP_ORIGIN}${dashboardPath(DASHBOARD_PATHS.suspensions)}`,
    fields: [
      {
        name: 'Date',
        value: `${utcDateOnly(outcome.before.suspendedAt)} → ${utcDateOnly(outcome.after.suspendedAt)}`,
      },
      {
        name: 'Length',
        value: `${outcome.before.durationDays} → ${outcome.after.durationDays} days`,
      },
    ],
  });
  logger.info(`Suspension #${input.id} date changed`);
  return { code: 'date-changed' };
}
