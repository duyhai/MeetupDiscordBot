import { Logger } from 'tslog';

import { PUBLIC_APP_ORIGIN } from '../../constants.js';
import type { LogEntry } from '../helpers/discordLogger.js';
import { escapeDiscordText } from '../helpers/identity/names.js';
import { neutralizeMentions } from '../helpers/neutralizeMentions.js';
import { parseUtcDateStrict } from '../helpers/suspensionCsv.js';
import {
  lastSuspendedDay,
  pacificToday,
  utcDateOnly,
} from '../helpers/suspensionList.js';
import {
  DASHBOARD_PATHS,
  linkableMonthPath,
} from '../reports/dashboardPaths.js';
import {
  monthLabel,
  Period,
  periodDate,
  periodKey,
} from '../reports/period.js';
import type { PostgresNoShowWorkspaceRepository } from '../repositories/postgresNoShowWorkspaceRepository.js';
import type { PostgresReportSnapshotRepository } from '../repositories/postgresReportSnapshotRepository.js';
import { isWorkspaceMonth } from './months.js';
import { casesFromPayload } from './sync.js';
import {
  type ActionOutcome,
  type ActionRefusalReason,
  WORKSPACE_ACTIONS,
  type WorkspaceAction,
  type WorkspaceStatus,
} from './types.js';

const logger = new Logger({ name: 'workspaceService' });

/** The raw form values of one row action; the service validates them. */
export interface WorkspaceActionInput {
  period: Period;
  rowId: number;
  /** The signed-in Discord user id. */
  actor: string;
  action: unknown;
  version: unknown;
  note?: unknown;
  date?: unknown;
  recordId?: unknown;
}

export type WorkspaceActionCode = 'done' | 'invalid' | ActionRefusalReason;

/**
 * `existing` only on 'already-suspended', and only when the live record can
 * be linked instead (the link offer). 'already-suspended' without it is an
 * overlap with a live suspension: there is nothing to offer.
 */
export interface WorkspaceActionResult {
  code: WorkspaceActionCode;
  existing?: { id: number; suspendedAt: Date };
}

export interface WorkspaceServiceDeps {
  now(): Date;
  repository(): Promise<Pick<PostgresNoShowWorkspaceRepository, 'applyAction'>>;
  /** Posts to the moderation log (logModeration: embed only, no pings). */
  moderationLog(entry: LogEntry): Promise<unknown>;
}

const VERSION = /^[0-9]{1,9}$/;
const RECORD_ID = /^[0-9]{1,9}$/;
const DAY = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/;
const DISCORD_ID = /^[0-9]{17,20}$/;
const MEMBER_ID = /^[0-9]{1,20}$/;
/** Code points of a note before escaping (the brief's 900). */
const NOTE_LOG_MAX = 900;
/** Discord refuses an embed field value over 1024 characters, which would drop the whole entry. */
const FIELD_VALUE_MAX = 1000;

const isAction = (v: unknown): v is WorkspaceAction =>
  typeof v === 'string' && (WORKSPACE_ACTIONS as readonly string[]).includes(v);

export const ACTION_TITLES: Readonly<Record<WorkspaceAction, string>> = {
  copy_warning: 'Warning copied',
  mark_sent: 'Warning marked as sent',
  hold: 'Put on hold',
  skip: 'Skipped',
  reopen: 'Reopened',
  record_suspension: 'Suspension recorded',
  link_suspension: 'Suspension linked',
  void: 'Suspension voided',
  edit_notes: 'Notes edited',
};

export const STATUS_LABELS: Readonly<Record<WorkspaceStatus, string>> = {
  new: 'New',
  warning_copied: 'Warning copied',
  warning_sent: 'Warning sent',
  on_hold: 'On hold',
  suspended: 'Suspended',
  skipped: 'Skipped',
  voided: 'Suspension voided',
};

/**
 * A field value cut to FIELD_VALUE_MAX UTF-16 code units (what discord.js
 * validates), ending in "…" when cut. Never splits a surrogate pair, and a
 * cut only drops characters from the end, so escaped text stays escaped.
 */
export function fitFieldValue(value: string): string {
  if (value.length <= FIELD_VALUE_MAX) {
    return value;
  }
  let end = FIELD_VALUE_MAX - 1;
  const last = value.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) {
    end -= 1; // the cut would leave a high surrogate without its pair
  }
  return `${value.slice(0, end)}…`;
}

/** Member-supplied text for an embed: markdown escaped, then every @, <# and </ defused. */
function memberText(text: string, maxLength?: number): string {
  return neutralizeMentions(escapeDiscordText(text, maxLength));
}

function errorClass(error: unknown): string {
  return error instanceof Error ? error.name : 'Error';
}

/** The form fields validateActionFields reads: raw, as the body parser gave them. */
export interface ActionFieldInput {
  version: unknown;
  date?: unknown;
  recordId?: unknown;
}

export interface ActionFields {
  expectedVersion: number;
  /** record_suspension: the Pacific date as its UTC midnight. */
  suspendedOn?: Date;
  /** link_suspension: the record to link. */
  linkRecordId?: number;
}

/**
 * The one check of an action's version, suspension date and record id, used
 * by both the route (before any database work) and the service, so the two
 * cannot disagree. The version and record id are 1-9 digits; the date is
 * YYYY-MM-DD, a real calendar day, from the month's first day (the stored
 * convention) through today, Pacific.
 */
export function validateActionFields(
  action: WorkspaceAction,
  input: ActionFieldInput,
  period: Period,
  now: Date,
):
  | { ok: true; fields: ActionFields }
  | { ok: false; code: 'invalid' | 'bad-date' } {
  const { version } = input;
  if (typeof version !== 'string' || !VERSION.test(version)) {
    return { ok: false, code: 'invalid' };
  }
  const fields: ActionFields = { expectedVersion: Number(version) };
  if (action === 'record_suspension') {
    const day = typeof input.date === 'string' ? input.date : '';
    const suspendedOn = DAY.test(day) ? parseUtcDateStrict(day) : undefined;
    if (
      suspendedOn === undefined ||
      day < periodDate(period) ||
      day > pacificToday(now)
    ) {
      return { ok: false, code: 'bad-date' };
    }
    fields.suspendedOn = suspendedOn;
  }
  if (action === 'link_suspension') {
    if (typeof input.recordId !== 'string' || !RECORD_ID.test(input.recordId)) {
      return { ok: false, code: 'invalid' };
    }
    fields.linkRecordId = Number(input.recordId);
  }
  return { ok: true, fields };
}

/**
 * One staff action on one card. Validates the raw form values, applies the
 * action in the repository's single transaction, then, after commit, posts
 * the moderation-log entry without waiting for it. Who may send a
 * Leadership-only action is checked by the caller (live, Task 8) before this
 * runs. A repository error propagates; the route answers it.
 */
export async function performWorkspaceAction(
  deps: WorkspaceServiceDeps,
  input: WorkspaceActionInput,
): Promise<WorkspaceActionResult> {
  const { action } = input;
  if (
    !isAction(action) ||
    typeof input.actor !== 'string' ||
    !DISCORD_ID.test(input.actor) ||
    !Number.isSafeInteger(input.rowId) ||
    input.rowId < 1
  ) {
    return { code: 'invalid' };
  }
  const checked = validateActionFields(action, input, input.period, deps.now());
  if (checked.ok === false) {
    return { code: checked.code };
  }
  const { expectedVersion, suspendedOn, linkRecordId } = checked.fields;
  const repo = await deps.repository();
  const outcome = await repo.applyAction({
    period: input.period,
    rowId: input.rowId,
    expectedVersion,
    actor: input.actor,
    action,
    note: typeof input.note === 'string' ? input.note : '',
    suspendedOn,
    linkRecordId,
  });
  if (outcome.ok === false) {
    return outcome.existing
      ? { code: outcome.reason, existing: outcome.existing }
      : { code: outcome.reason };
  }
  // After commit, fire and forget: the events table is the durable audit, and
  // a Discord outage must not turn a recorded action into an error page.
  postWithoutWaiting(
    deps,
    moderationEntry(input.period, outcome, action, input.actor),
  );
  return { code: 'done' };
}

/** Never throws and never waits: a failure is logged by its class name only. */
export function postWithoutWaiting(
  deps: Pick<WorkspaceServiceDeps, 'moderationLog'>,
  entry: LogEntry,
): void {
  Promise.resolve()
    .then(() => deps.moderationLog(entry))
    .catch((error: unknown) => {
      logger.warn(`Workspace moderation log failed: ${errorClass(error)}`);
    });
}

function pageLine(period: Period): string {
  const page = linkableMonthPath(DASHBOARD_PATHS.workspaceMonth, period);
  return page ? `\n${PUBLIC_APP_ORIGIN}${page}` : '';
}

/** The moderation-log embed for one applied action. No content: `<@id>` in an embed never pings. */
export function moderationEntry(
  period: Period,
  outcome: Extract<ActionOutcome, { ok: true }>,
  action: WorkspaceAction,
  actor: string,
): LogEntry {
  const { row, previousStatus, event, suspension } = outcome;
  const memberId = MEMBER_ID.test(row.memberId) ? row.memberId : 'unknown id';
  const fields: NonNullable<LogEntry['fields']> = [
    {
      name: 'Member',
      value: `${memberText(row.memberName || 'Unknown member')} (${memberId})`,
    },
    {
      name: 'Status',
      value: `${STATUS_LABELS[previousStatus]} → ${STATUS_LABELS[row.status]}`,
    },
  ];
  if (event.note) {
    const name =
      action === 'edit_notes' ? 'Notes' : action === 'void' ? 'Reason' : 'Note';
    fields.push({ name, value: memberText(event.note, NOTE_LOG_MAX) });
  }
  if (suspension) {
    const from = utcDateOnly(suspension.suspendedAt);
    const span = `#${suspension.id}: ${suspension.durationDays} days from ${from} through ${lastSuspendedDay(suspension)}`;
    const how = outcome.alreadyVoided
      ? ' (already voided with /meetup_void_suspension)'
      : outcome.linkedExisting
        ? ' (existing record linked)'
        : '';
    fields.push({ name: 'Suspension', value: `${span}${how}` });
  }
  return {
    title: `No-show workspace: ${ACTION_TITLES[action]}`,
    fields: fields.map((field) => ({
      ...field,
      value: fitFieldValue(field.value),
    })),
    // <@id> in an embed never pings; it names the actor as the commands do.
    description: `<@${actor}> in the ${monthLabel(period)} workspace.${pageLine(period)}`,
  };
}

export const REFUSED_WHAT: Partial<Record<WorkspaceAction, string>> = {
  record_suspension: 'record a suspension',
  link_suspension: 'link a suspension',
  void: 'void a suspension',
};

/** Why a Leadership-only action was refused before anything was written. */
export type LeadershipRefusal = 'not-leadership' | 'discord-unreachable';

/**
 * The moderation-log entry for a Leadership-only action refused by the live
 * role check (Task 8). The moderation log is its only audit: nothing is
 * written to noshow_workspace_events. `actor` must be the session's Discord
 * id; anything else is not shown.
 */
export function leadershipRefusalEntry(
  period: Period,
  rowId: number,
  action: WorkspaceAction,
  actor: string,
  why: LeadershipRefusal,
): LogEntry {
  const who = DISCORD_ID.test(actor) ? `<@${actor}>` : 'Someone';
  const what = REFUSED_WHAT[action] ?? 'change a card';
  const card =
    Number.isSafeInteger(rowId) && rowId > 0 ? ` (card ${rowId})` : '';
  const where = `in the ${monthLabel(period)} workspace${card}`;
  const reason =
    why === 'not-leadership'
      ? `${where} without the 1.5 Leadership Team role`
      : `${where}, but Discord could not confirm their role`;
  return {
    title: 'No-show workspace: Leadership-only action refused',
    description: `${who} tried to ${what} ${reason}. Nothing was changed.${pageLine(period)}`,
  };
}

export type WorkspaceSyncCode =
  'synced' | 'current' | 'older' | 'no-report' | 'malformed' | 'not-eligible';

export interface WorkspaceSyncDeps {
  now(): Date;
  /** Lazy: the workspace schema is set up only here (PostgresNoShowWorkspaceRepository.instance()). */
  repository(): Promise<
    Pick<PostgresNoShowWorkspaceRepository, 'syncFromSnapshot' | 'monthState'>
  >;
  snapshots(): Promise<
    Pick<PostgresReportSnapshotRepository, 'getCurrent' | 'getCurrentMeta'>
  >;
}

/**
 * Copies a workspace month's current no-show cases into the workspace.
 * Reads nothing for a month outside the workspace range, and never opens
 * the workspace repository for a month without a usable report. May reject.
 */
export async function syncWorkspace(
  deps: WorkspaceSyncDeps,
  period: Period,
): Promise<WorkspaceSyncCode> {
  if (!isWorkspaceMonth(period, deps.now())) {
    return 'not-eligible';
  }
  const snapshots = await deps.snapshots();
  // The cheap check first: most ticks find the workspace already synced
  // from the current build, and the payload is then never read.
  const meta = await snapshots.getCurrentMeta('no_show', period);
  if (!meta) {
    return 'no-report';
  }
  const repository = await deps.repository();
  const state = await repository.monthState(period);
  if (
    state !== undefined &&
    state.snapshotId === meta.id &&
    state.snapshotBuiltAt.getTime() === meta.builtAt.getTime()
  ) {
    return 'current';
  }
  const snapshot = await snapshots.getCurrent('no_show', period);
  if (!snapshot) {
    return 'no-report';
  }
  const cases = casesFromPayload(snapshot.payload);
  if (cases === undefined) {
    logger.error(
      `Workspace sync ${periodKey(period)}: the stored no-show report is not in the expected shape; nothing synced`,
    );
    return 'malformed';
  }
  const outcome = await repository.syncFromSnapshot({
    period,
    snapshotId: snapshot.id,
    snapshotBuiltAt: snapshot.builtAt,
    cases,
  });
  return outcome.status;
}
