import { Period } from '../reports/period.js';

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

/** What staff can do to a row (Task 5 adds the request and outcome types). */
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
