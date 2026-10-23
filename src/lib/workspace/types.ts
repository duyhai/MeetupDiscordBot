import type { Period } from '../reports/period.js';
import type { SuspensionRecordState } from '../repositories/postgresSuspensionRepository.js';
import type { TransitionRefusal } from './transitions.js';

/** A workspace row's status. The order is the CHECK list's order. */
export const WORKSPACE_STATUSES = [
  'new',
  'warning_copied',
  'warning_sent',
  'on_hold',
  'suspended',
  'skipped',
  'voided',
] as const;
export type WorkspaceStatus = (typeof WORKSPACE_STATUSES)[number];

export type Classification = 'warning' | 'suspension';

/** What staff can do to a row. */
export const WORKSPACE_ACTIONS = [
  'copy_warning',
  'mark_sent',
  'hold',
  'skip',
  'reopen',
  'record_suspension',
  'link_suspension',
  'void',
  'edit_notes',
] as const;
export type WorkspaceAction = (typeof WORKSPACE_ACTIONS)[number];

/**
 * What an active ban blocks: creating or attaching a suspension. Void,
 * hold, skip, reopen, notes and the warning actions stay (D7; Hai: void
 * stays allowed).
 */
export const BAN_BLOCKED_ACTIONS: readonly WorkspaceAction[] = [
  'record_suspension',
  'link_suspension',
];

/** Event actions the sync writes, as actor 'sync'. */
export const SYNC_EVENT_ACTIONS = [
  'sync_created',
  'sync_reclassified',
  'sync_dropped',
  'sync_returned',
] as const;

/** To do. */
export const OPEN_STATUSES: readonly WorkspaceStatus[] = [
  'new',
  'warning_copied',
];
export const PARKED_STATUSES: readonly WorkspaceStatus[] = ['on_hold'];
export const DONE_STATUSES: readonly WorkspaceStatus[] = [
  'warning_sent',
  'suspended',
  'skipped',
  'voided',
];

export const NOTES_MAX = 2000;
/** /meetup_void_suspension's maxLength. */
export const VOID_REASON_MAX = 500;
/** Code points. */
export const MEMBER_NAME_MAX = 500;

export interface WorkspaceRow {
  id: number;
  period: Period;
  memberId: string;
  memberName: string;
  classification: Classification;
  status: WorkspaceStatus;
  notes: string;
  suspensionRecordId: number | null;
  inLatestSnapshot: boolean;
  version: number;
  updatedAt: Date;
  /** 'sync' or a Discord user id. */
  updatedBy: string | null;
}

export interface WorkspaceEvent {
  /** BIGSERIAL, read as text. */
  id: string;
  rowId: number;
  /** 'sync' or a Discord user id. */
  actor: string;
  action: string;
  oldStatus: WorkspaceStatus;
  newStatus: WorkspaceStatus;
  note: string | null;
  suspensionRecordId: number | null;
  createdAt: Date;
}

/** One case of a stored no-show report, as the workspace holds it. */
export interface SyncCase {
  memberId: string;
  memberName: string;
  classification: Classification;
}

export interface SyncOutcome {
  /** 'current': already synced from this build; 'older': a newer build is synced. */
  status: 'synced' | 'current' | 'older';
  created: number;
  reclassified: number;
  dropped: number;
  returned: number;
}

/** Which stored build a month's workspace was last synced from. */
export interface WorkspaceMonthState {
  period: Period;
  snapshotId: number;
  snapshotBuiltAt: Date;
  syncedAt: Date;
}

export const isWorkspaceStatus = (value: unknown): value is WorkspaceStatus =>
  WORKSPACE_STATUSES.some((status) => status === value);

/**
 * One staff action on one row. Who may send it (LEADERSHIP_ONLY_ACTIONS,
 * checked live) is the caller's business: the repository applies it as
 * `actor`.
 */
export interface ActionRequest {
  period: Period;
  rowId: number;
  /** The version the form was rendered from: a different current one is 'stale'. */
  expectedVersion: number;
  /** The Discord user id of who acted. */
  actor: string;
  action: WorkspaceAction;
  /** hold/skip/void reason, or edit_notes' new notes. Untrimmed; decideTransition normalises. */
  note: string;
  /** record_suspension: UTC midnight of the chosen Pacific date (parseUtcDateStrict). */
  suspendedOn?: Date;
  /** link_suspension: the record to link. */
  linkRecordId?: number;
}

export type ActionRefusalReason =
  | 'not-found'
  | 'stale'
  | TransitionRefusal
  | 'already-suspended'
  | 'record-unavailable'
  | 'bad-date'
  /** record_suspension dated before one of the member's live records. */
  | 'out-of-order'
  /** record_suspension or link_suspension for a member with an active ban. */
  | 'banned';

/** A refusal wrote nothing: not the version bump, not an event. */
export type ActionOutcome =
  | {
      ok: true;
      row: WorkspaceRow;
      previousStatus: WorkspaceStatus;
      event: WorkspaceEvent;
      suspension?: SuspensionRecordState;
      /** The record already existed (link_suspension, or a same-date record found on insert). */
      linkedExisting: boolean;
      /** void: the record had been voided outside the workspace; it was not voided again. */
      alreadyVoided: boolean;
    }
  | {
      ok: false;
      reason: ActionRefusalReason;
      /** already-suspended: the live record the row could link instead. */
      existing?: { id: number; suspendedAt: Date };
      /** out-of-order: the member's latest live record dated after the chosen day. */
      later?: { id: number; suspendedAt: Date };
    };
