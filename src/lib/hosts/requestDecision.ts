import { Logger } from 'tslog';

import { DASHBOARD_LOCK_TIMEOUT_MS } from '../repositories/dashboardPool.js';
import {
  DENY_REASON_MAX,
  EventRequest,
  EventRequestStatus,
  PublishFrom,
} from '../repositories/postgresEventRequestRepository.js';
import { LogEntry, alertText } from '../helpers/discordLogger.js';
import { WorkspaceDeadlineError, withDeadline } from '../../util/deadline.js';
import { ExistingEvent, PublishOutcome, canDeny } from './publishRequest.js';

const logger = new Logger({ name: 'requestDecision' });

/**
 * How long a decision's service call may run before the caller is told to
 * check back ('still-publishing', 'deny-slow'). With the Leadership check's
 * deadline it stays inside Heroku's 30 s router timeout; a Discord
 * interaction's token lasts longer. Work still running is left to finish:
 * a publish commits whole, and a late deny is audited when it lands.
 */
export const DECISION_DEADLINE_MS = 20_000;
/** How long the live Leadership check may take; past it, Discord counts as unreachable. */
export const LEADERSHIP_CHECK_DEADLINE_MS = 5_000;
/**
 * How long Deny waits for Meetup to say whether a failed request's event
 * exists. Well inside the decision's own deadline, so a slow answer refuses
 * the deny (fails closed) and leaves time to write one that is allowed.
 */
export const DENY_CHECK_DEADLINE_MS = 8_000;
/** At most one Leadership refusal audit per user per this window (the caller's limiter). */
export const REFUSAL_AUDIT_WINDOW_MS = 60_000;

export type DecisionAction = 'approve' | 'deny' | 'retry' | 'resolve';
export const DECISION_ACTIONS: readonly DecisionAction[] = [
  'approve',
  'deny',
  'retry',
  'resolve',
];

export type DecisionCode =
  | 'published'
  | 'failed'
  | 'denied'
  | 'resolved'
  | 'stale'
  | 'still-publishing'
  | 'deny-slow'
  | 'reason-required'
  | 'reason-too-long'
  | 'deny-event-exists'
  | 'deny-check-failed'
  | 'not-leadership'
  | 'leadership-unavailable'
  | 'error';

export interface DecisionOutcome {
  code: DecisionCode;
  /** The request as the decision left it, when it was decided. */
  request?: EventRequest;
}

/** The request store's reads and the writes a decision uses. */
export interface StaffRequestStore {
  get: (id: string) => Promise<EventRequest | undefined>;
  listByStatus: (
    statuses: EventRequestStatus[],
    limit?: number,
  ) => Promise<EventRequest[]>;
  listDecided: (limit?: number) => Promise<EventRequest[]>;
  /**
   * `lockTimeoutMs` bounds how long the write may wait on a row lock, so a
   * deny cannot commit long after the caller gave up on it.
   */
  deny: (
    id: string,
    seenVersion: number,
    actor: string,
    reason: string,
    options?: { lockTimeoutMs?: number },
  ) => Promise<EventRequest | undefined>;
  resolve: (
    id: string,
    seenVersion: number,
    actor: string,
  ) => Promise<EventRequest | undefined>;
}

export interface DecisionDeps {
  now: () => Date;
  /** Live Discord check for the 1.5 Leadership Team role. Rejects when Discord cannot answer. */
  isLeadership: (discordUserId: string) => Promise<boolean>;
  /** Activity log; fire and forget. */
  audit: (entry: LogEntry) => Promise<unknown>;
  /** Rejects when Postgres cannot answer: the decision is 'error'. */
  store: () => Promise<StaffRequestStore>;
  /** publishRequest with the organizer credential; the actor is the leader's Discord id. */
  publishRequest: (
    id: string,
    version: number,
    actor: string,
    from: PublishFrom[],
  ) => Promise<PublishOutcome>;
  /**
   * The Meetup event a failed request may have become without it being
   * recorded. Throws when Meetup cannot answer.
   */
  findExistingEvent: (
    request: EventRequest,
  ) => Promise<ExistingEvent | undefined>;
  /**
   * Shows the decision on the request's Discord post. Fire and forget: a
   * failure never reaches the decision (the mirror logs and alerts itself).
   */
  mirror?: (request: EventRequest) => Promise<unknown>;
  /**
   * Admits one refusal audit per actor per REFUSAL_AUDIT_WINDOW_MS (a
   * FixedWindowLimiter), so a repeated refused press cannot flood the log.
   */
  refusals: { take: (actor: string) => boolean };
  /** Tests only: how long the pre-deny Meetup check may take. */
  denyCheckDeadlineMs?: number;
}

export interface DecisionInput {
  id: string;
  /** The version the actor saw; the compare-and-set refuses any other. */
  version: number;
  /** The leader's Discord id. */
  actor: string;
  action: DecisionAction;
  /** Deny only: as typed; CRLF and surrounding space are normalised here. */
  reason?: string;
}

function auditRefusalOnce(
  deps: DecisionDeps,
  input: DecisionInput,
  leadership: 'not-leader' | 'unreachable',
): void {
  if (!deps.refusals.take(input.actor)) {
    return;
  }
  deps
    .audit({
      title: 'Host request action refused',
      description:
        `<@${input.actor}> tried to ${input.action} host request #${input.id} ` +
        `without the 1.5 Leadership Team role (${leadership}).`,
    })
    .catch(() => undefined);
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : 'Error';
}

/**
 * One decision on a request, from the staff queue or a Discord button:
 * the live Leadership check, then approve/retry (publishRequest), deny
 * (reason rules, the Meetup check for a failed request, the bounded write)
 * or resolve. Writes the audit line and mirrors a decided request onto its
 * Discord post. Never throws: every failure is a code.
 */
export async function decideRequest(
  deps: DecisionDeps,
  input: DecisionInput,
): Promise<DecisionOutcome> {
  const { id, version, actor, action } = input;
  // Live, on every decision: nothing cached decides this.
  let leader: boolean;
  try {
    leader = await withDeadline(LEADERSHIP_CHECK_DEADLINE_MS, () =>
      deps.isLeadership(actor),
    );
  } catch (error: unknown) {
    logger.warn(`Leadership check failed: ${errorName(error)}`);
    auditRefusalOnce(deps, input, 'unreachable');
    return { code: 'leadership-unavailable' };
  }
  if (!leader) {
    auditRefusalOnce(deps, input, 'not-leader');
    return { code: 'not-leadership' };
  }

  let store: StaffRequestStore;
  try {
    store = await deps.store();
  } catch (error: unknown) {
    logger.warn(`Host request store failed: ${errorName(error)}`);
    return { code: 'error' };
  }

  const auditLine = (what: string, request: EventRequest | undefined) => {
    deps
      .audit({
        title: `Host request ${what}`,
        fields: [
          { name: 'Request', value: `#${id}`, inline: true },
          { name: 'By', value: `<@${actor}>`, inline: true },
          ...(request
            ? [{ name: 'Title', value: alertText(request.title) }]
            : []),
        ],
      } satisfies LogEntry)
      .catch(() => undefined);
  };
  const mirror = (request: EventRequest) => {
    deps.mirror?.(request).catch((error: unknown) => {
      logger.warn(`Request post mirror threw: ${errorName(error)}`);
    });
  };

  if (action === 'deny') {
    // A textarea's line breaks arrive as CRLF but count as one character
    // for maxlength; so does this, and so is it stored.
    const reason = (input.reason ?? '').replace(/\r\n?/g, '\n').trim();
    if (reason === '') {
      return { code: 'reason-required' };
    }
    if (Array.from(reason).length > DENY_REASON_MAX) {
      return { code: 'reason-too-long' };
    }
    // Each step has its own deadline, and the deny is written only while
    // the caller is still waiting: withDeadline does not cancel the work,
    // so one deadline around all three could commit a deny after the caller
    // had been told it failed.
    const deadline = deps.now().getTime() + DECISION_DEADLINE_MS;
    let denied: EventRequest | undefined;
    let write: Promise<EventRequest | undefined> | undefined;
    try {
      // Checked at this version; deny's compare-and-set on the same version
      // means the row cannot have changed in between.
      const current = await withDeadline(DECISION_DEADLINE_MS, () =>
        store.get(id),
      );
      if (
        current === undefined ||
        current.version !== version ||
        !canDeny(current)
      ) {
        return { code: 'stale' };
      }
      if (current.status === 'failed') {
        // Several failures mean the event may be on Meetup unrecorded:
        // denying it would leave a live event the host is told was refused,
        // with no Retry left. No answer in time is no answer.
        let existing: ExistingEvent | undefined | 'unknown';
        try {
          existing = await withDeadline(
            deps.denyCheckDeadlineMs ?? DENY_CHECK_DEADLINE_MS,
            () => deps.findExistingEvent(current),
          );
        } catch (error: unknown) {
          logger.warn(`Host request deny check failed: ${errorName(error)}`);
          existing = 'unknown';
        }
        if (existing === 'unknown') {
          return { code: 'deny-check-failed' };
        }
        if (existing !== undefined) {
          return { code: 'deny-event-exists' };
        }
      }
      const left = deadline - deps.now().getTime();
      if (left <= 0) {
        throw new WorkspaceDeadlineError(DECISION_DEADLINE_MS);
      }
      // The write gets only the time the caller has left: its row-lock wait
      // is bounded by it too. The pool wait and BEGIN come before the lock
      // timeout starts, so a write can still land after the answer: then
      // the caller is told it may still save, and the late write is audited.
      // Never longer than the pool's usual 15 s lock wait, though.
      const lockTimeoutMs = Math.max(
        1,
        Math.floor(Math.min(left, DASHBOARD_LOCK_TIMEOUT_MS)),
      );
      write = store.deny(id, version, actor, reason, { lockTimeoutMs });
      const pending = write;
      denied = await withDeadline(left, () => pending);
    } catch (error: unknown) {
      if (error instanceof WorkspaceDeadlineError && write !== undefined) {
        write
          .then((late) => {
            if (late !== undefined) {
              auditLine('denied (saved after the page timed out)', late);
              mirror(late);
            }
          })
          .catch((late: unknown) => {
            logger.warn(
              `Host request deny failed after the deadline: ${errorName(late)}`,
            );
          });
        return { code: 'deny-slow' };
      }
      logger.warn(`Host request deny failed: ${errorName(error)}`);
      return { code: 'error' };
    }
    if (denied === undefined) {
      return { code: 'stale' };
    }
    auditLine('denied', denied);
    mirror(denied);
    return { code: 'denied', request: denied };
  }

  if (action === 'resolve') {
    let resolved: EventRequest | undefined;
    try {
      resolved = await withDeadline(DECISION_DEADLINE_MS, () =>
        store.resolve(id, version, actor),
      );
    } catch (error: unknown) {
      logger.warn(`Host request resolve failed: ${errorName(error)}`);
      return { code: 'error' };
    }
    if (resolved === undefined) {
      return { code: 'stale' };
    }
    auditLine('marked resolved', resolved);
    mirror(resolved);
    return { code: 'resolved', request: resolved };
  }

  const from: PublishFrom[] =
    action === 'approve' ? ['pending'] : ['failed', 'publishing'];
  const publishing = deps.publishRequest(id, version, actor, from);
  let outcome: PublishOutcome;
  try {
    outcome = await withDeadline(DECISION_DEADLINE_MS, () => publishing);
  } catch (error: unknown) {
    if (error instanceof WorkspaceDeadlineError) {
      auditLine(
        `${action === 'approve' ? 'approval' : 'retry'} started (still publishing)`,
        undefined,
      );
      // The publish goes on; the post is updated when it ends.
      publishing
        .then((late) => {
          if (late.code !== 'stale') {
            mirror(late.request);
          }
        })
        .catch((late: unknown) => {
          logger.warn(
            `Host request publish failed after the deadline: ${errorName(late)}`,
          );
        });
      return { code: 'still-publishing' };
    }
    logger.warn(`Host request publish failed: ${errorName(error)}`);
    return { code: 'error' };
  }
  if (outcome.code === 'stale') {
    return { code: 'stale' };
  }
  auditLine(action === 'approve' ? 'approved' : 'retried', outcome.request);
  mirror(outcome.request);
  return { code: outcome.code, request: outcome.request };
}
