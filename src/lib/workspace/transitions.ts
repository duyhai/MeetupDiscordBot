import {
  Classification,
  NOTES_MAX,
  VOID_REASON_MAX,
  WORKSPACE_ACTIONS,
  WorkspaceAction,
  WorkspaceRow,
  WorkspaceStatus,
} from './types.js';

export type TransitionRefusal =
  | 'not-allowed'
  | 'wrong-classification'
  | 'not-in-report'
  | 'note-required'
  | 'note-too-long'
  | 'no-earlier-status';

export interface TransitionInput {
  action: WorkspaceAction;
  status: WorkspaceStatus;
  classification: Classification;
  inLatestSnapshot: boolean;
  /** The action's note (hold/skip reason, void reason, or the new notes for edit_notes). Untrimmed. */
  note: string;
  /** For reopen: the status before the latest hold/skip, from the events log. */
  statusBeforePark?: WorkspaceStatus;
}

export type TransitionDecision =
  | { ok: true; to: WorkspaceStatus; note: string | null }
  | { ok: false; reason: TransitionRefusal };

type From = readonly WorkspaceStatus[] | 'any';

export interface TransitionRule {
  from: From;
  to: WorkspaceStatus | 'unchanged' | 'before-park';
  note: 'ignored' | 'required' | 'notes';
  classification: Classification | 'any';
  needsLatest: boolean;
  noteMax: number;
}

const S = (...s: WorkspaceStatus[]): readonly WorkspaceStatus[] => s;

export const TRANSITION_RULES = Object.freeze({
  copy_warning: {
    from: S('new', 'warning_copied'),
    to: 'warning_copied',
    note: 'ignored',
    classification: 'warning',
    needsLatest: true,
    noteMax: NOTES_MAX,
  },
  mark_sent: {
    from: S('new', 'warning_copied'),
    to: 'warning_sent',
    note: 'ignored',
    classification: 'warning',
    needsLatest: true,
    noteMax: NOTES_MAX,
  },
  hold: {
    from: S('new', 'warning_copied', 'warning_sent'),
    to: 'on_hold',
    note: 'required',
    classification: 'any',
    needsLatest: false,
    noteMax: NOTES_MAX,
  },
  skip: {
    from: S('new', 'warning_copied', 'warning_sent', 'on_hold'),
    to: 'skipped',
    note: 'required',
    classification: 'any',
    needsLatest: false,
    noteMax: NOTES_MAX,
  },
  reopen: {
    from: S('on_hold', 'skipped'),
    to: 'before-park',
    note: 'ignored',
    classification: 'any',
    needsLatest: false,
    noteMax: NOTES_MAX,
  },
  record_suspension: {
    from: S('new', 'warning_copied', 'warning_sent', 'on_hold', 'voided'),
    to: 'suspended',
    note: 'ignored',
    classification: 'suspension',
    needsLatest: true,
    noteMax: NOTES_MAX,
  },
  link_suspension: {
    from: S('new', 'warning_copied', 'warning_sent', 'on_hold', 'voided'),
    to: 'suspended',
    note: 'ignored',
    classification: 'suspension',
    needsLatest: false,
    noteMax: NOTES_MAX,
  },
  void: {
    from: S('suspended'),
    to: 'voided',
    note: 'required',
    classification: 'any',
    needsLatest: false,
    noteMax: VOID_REASON_MAX,
  },
  edit_notes: {
    from: 'any',
    to: 'unchanged',
    note: 'notes',
    classification: 'any',
    needsLatest: false,
    noteMax: NOTES_MAX,
  },
} satisfies Record<WorkspaceAction, TransitionRule>) as Readonly<
  Record<WorkspaceAction, TransitionRule>
>;

/**
 * Who may do what beyond "any dashboard user" (Hai, 2026-10-16): recording,
 * linking and voiding a suspension are for the 1.5 Leadership Team only, checked live
 * against Discord at the moment of the action (Task 8). This is the one place
 * that says which actions; the service, the routes and the page read it. It
 * does not change what decideTransition or allowedActions allow: the state
 * rules and the role rule are separate questions.
 */
export const LEADERSHIP_ONLY_ACTIONS: readonly WorkspaceAction[] =
  Object.freeze([
    'record_suspension',
    'link_suspension',
    'void',
  ] as WorkspaceAction[]);

export const isLeadershipOnly = (action: WorkspaceAction): boolean =>
  LEADERSHIP_ONLY_ACTIONS.includes(action);

/** CRLF → LF, then trimmed: what is stored and what the length rule counts. */
export const normalizeNote = (text: unknown): string =>
  (typeof text === 'string' ? text : '').replace(/\r\n?/g, '\n').trim();

export function decideTransition(input: TransitionInput): TransitionDecision {
  const rule: TransitionRule | undefined = TRANSITION_RULES[input.action];
  if (!rule) {
    return { ok: false, reason: 'not-allowed' };
  }
  if (rule.from !== 'any' && !rule.from.includes(input.status)) {
    return { ok: false, reason: 'not-allowed' };
  }
  if (
    rule.classification !== 'any' &&
    rule.classification !== input.classification
  ) {
    return { ok: false, reason: 'wrong-classification' };
  }
  if (rule.needsLatest && !input.inLatestSnapshot) {
    return { ok: false, reason: 'not-in-report' };
  }
  const note = normalizeNote(input.note);
  if (rule.note !== 'ignored' && Array.from(note).length > rule.noteMax) {
    return { ok: false, reason: 'note-too-long' };
  }
  if (rule.note === 'required' && note === '') {
    return { ok: false, reason: 'note-required' };
  }
  let to: WorkspaceStatus;
  if (rule.to === 'unchanged') {
    to = input.status;
  } else if (rule.to === 'before-park') {
    const before = input.statusBeforePark;
    // Only a status a hold or skip could have come from: anything else means the log is not ours.
    if (before === undefined || !TRANSITION_RULES.skip.from.includes(before)) {
      return { ok: false, reason: 'no-earlier-status' };
    }
    to = before;
  } else {
    to = rule.to;
  }
  return { ok: true, to, note: rule.note === 'ignored' ? null : note };
}

/** What a card offers: every action decideTransition would allow (reopen assumed to have its log entry). */
export function allowedActions(
  row: Pick<WorkspaceRow, 'status' | 'classification' | 'inLatestSnapshot'>,
): WorkspaceAction[] {
  return WORKSPACE_ACTIONS.filter(
    (action) =>
      decideTransition({
        action,
        status: row.status,
        classification: row.classification,
        inLatestSnapshot: row.inLatestSnapshot,
        note: 'x',
        statusBeforePark: 'new',
      }).ok,
  );
}
