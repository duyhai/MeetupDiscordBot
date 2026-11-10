# Event audit trail — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Snapshot the group's upcoming Meetup events hourly, record every status, host, start, title and RSVP change (deletions confirmed by a direct read), alert leadership for deletions, cancellations and host changes, and show it all on a staff dashboard page.

**Architecture:** A pure diff (`src/lib/eventAudit/diff.ts`) over `EventObservation`s read from Meetup with the organizer credential (`meetup.ts`), driven by a run (`run.ts`) that writes one transaction through `PostgresEventAuditRepository` and then alerts with per-event rate limits (`alerts.ts`). A scheduler (`job.ts`) mirrors the report build job's tick, lease and manual-request pattern. Two read-only dashboard routes plus a POST for "Snapshot now".

**Tech Stack:** TypeScript ESM (`.js` imports), pg, Redis (`KeyValueCache`), graphql-request, Express 5 with the `html` tagged template, vitest.

**Spec:** `docs/superpowers/specs/2026-11-10-event-audit-trail-design.md`

## Global Constraints

- Nothing posted to Discord carries raw Meetup text: titles and names through `alertText`, errors through `describeBuildError`; embeds only, `allowedMentions: { parse: [] }` (`logAlert` does this).
- No role or user pings (the no-pings scan in `tst/lib/noPings.test.ts` runs over `src`).
- `src/lib` never imports from `src/web`.
- Every rendered value is escaped: `memberText` for member-written text, `safeHref` / `meetupProfileUrl` / `localUrl` for every href.
- Idempotent schema under `(DASHBOARD_LOCK_CLASS, SCHEMA_LOCK_KEY)` via `inDashboardTransaction`.
- Retention: 180 days. Confirm cap 25 per run. Alert cap 10 per run. Alert rate limit 6 h per event and kind. Hourly cadence: due when the latest saved run started ≥ 55 min ago. Failed-run backoff 30 min. Manual cooldown 2 min.
- RSVP drop: `prev − next ≥ 5` or `prev − next ≥ 0.25 × prev` with `prev ≥ 1`.
- Cancelled statuses: `CANCELLED`, `CANCELLED_PERM`, `AUTOSCHED_CANCELLED`.
- Lint, `tsc`, prettier clean; integration tests on the throwaway stack:
  `DATABASE_URL=postgres://postgres:postgres@localhost:55432/postgres REDISCLOUD_URL=redis://localhost:56379 npx vitest run --config vitest.integration.config.ts`.

## Review Focus

1. A Meetup listing that returns zero events (outage shaped as an empty list): no event may be recorded deleted without a `null` confirmation; the confirm cap bounds the reads. (Task 5 tests this.)
2. A `getEventForAudit` that throws for one event while others confirm: that event is left alone, the run still saves. (Task 5.)
3. A node with a hostile title (`<script>`, markdown, 10 000 chars): stored truncated, rendered escaped, alerted through `alertText`. (Tasks 3, 6, 9.)
4. The first run ever on a populated group: snapshots only, zero `created` changes, zero alerts. (Tasks 2, 5.)
5. A `hosts` JSONB written by a bug as a non-array: the page must not 500; the repository validates on read and renders "unknown hosts". (Task 9.)

---

### Task 1: Types and the diff

**Files:**

- Create: `src/lib/eventAudit/types.ts`, `src/lib/eventAudit/diff.ts`
- Test: `tst/lib/eventAudit/diff.test.ts`

**Interfaces (Produces):**

```ts
// types.ts
export type EventChangeKind =
  | 'created'
  | 'cancelled'
  | 'deleted'
  | 'host_changed'
  | 'start_moved'
  | 'title_changed'
  | 'rsvp_drop'
  | 'rsvps_closed';
export const EVENT_CHANGE_KINDS: readonly EventChangeKind[];
export const CANCELLED_STATUSES: ReadonlySet<string>; // the three above
export function isCancelledStatus(status: string): boolean;
export interface EventHost {
  id: string;
  name: string;
}
export interface EventObservation {
  eventId: string;
  title: string;
  status: string;
  startAt: Date;
  duration: string | null;
  eventUrl: string | null;
  venueId: string | null;
  photoId: string | null;
  hosts: EventHost[];
  rsvpYes: number | null;
  waitlist: number | null;
  rsvpsClosed: boolean | null;
  lastEditedAt: Date | null;
}
export interface EventSnapshot extends EventObservation {
  id: number;
  runId: number;
  takenAt: Date;
}
export interface NewEventChange {
  eventId: string;
  kind: EventChangeKind;
  oldValue: unknown;
  newValue: unknown;
  title: string;
  startAt: Date;
  eventUrl: string | null;
  hosts: EventHost[];
  rsvpYes: number | null;
  waitlist: number | null;
}
export interface EventChange extends NewEventChange {
  id: number;
  runId: number;
  detectedAt: Date;
  actor: string | null;
  alertedAt: Date | null;
}
// diff.ts
export const RSVP_DROP_MIN = 5;
export const RSVP_DROP_FRACTION = 0.25;
export function isRsvpDrop(prev: number | null, next: number | null): boolean;
/** baseline: the first run ever; a new event then yields nothing. */
export function diffEvent(
  previous: EventObservation | undefined,
  next: EventObservation,
  options: { baseline: boolean },
): NewEventChange[];
/** The deleted change for an event whose confirmation came back null. */
export function deletionChange(previous: EventObservation): NewEventChange;
```

`hosts` on a `host_changed` row is the union of old and new hosts (both are likely actors); on every other row it is `next.hosts` (or `previous.hosts` for `deleted`). Same-id host lists in a different order are equal.

- [ ] **Step 1: Write the failing tests** in `tst/lib/eventAudit/diff.test.ts` with an `obs(overrides)` fixture builder (event `311000001`, title `Board games`, status `ACTIVE`, start `2026-12-05T19:00:00-08:00`, hosts `[{id:'4242',name:'Hana'}]`, rsvpYes 20, waitlist 2, rsvpsClosed false):
  - `isRsvpDrop`: (20, 16) false; (100, 95) true; (10, 7) true; (0, 0) false; (null, 3) false; (20, null) false; (4, 0) true (100 %).
  - `diffEvent(undefined, next, {baseline:false})` → one `created` with `newValue = { title, startAt: ISO string, hosts }`; with `{baseline:true}` → `[]`.
  - unchanged → `[]`.
  - status `ACTIVE` → `CANCELLED` → one `cancelled`, old/new `{ status }`; `CANCELLED` → `CANCELLED_PERM` → `[]` (already cancelled, nothing further).
  - hosts `[4242]` → `[4242, 5151]` → `host_changed`, `hosts` on the row has both ids; `[4242,5151]` → `[5151,4242]` → `[]`.
  - start moved by an hour → `start_moved` with ISO strings; title changed → `title_changed`.
  - rsvpYes 20 → 14 → `rsvp_drop` with `{ rsvpYes, waitlist }` both sides; 20 → 17 → `[]`.
  - rsvpsClosed false → true → `rsvps_closed`; true → false → `[]`; null → true → `[]`.
  - host change + start move at once → two changes, in table order (`host_changed` before `start_moved`).
  - `deletionChange(prev)` → kind `deleted`, `oldValue = { status, startAt, rsvpYes }`, `newValue = null`, hosts = prev.hosts, rsvpYes 20.
- [ ] **Step 2: Run** `npx vitest run tst/lib/eventAudit/diff.test.ts` — FAIL (module not found).
- [ ] **Step 3: Implement** `types.ts` and `diff.ts` as above. Dates in `oldValue`/`newValue` are ISO strings (JSONB).
- [ ] **Step 4: Run** the file — PASS.
- [ ] **Step 5: Commit** `feat(eventAudit): change kinds and the snapshot diff`.

### Task 2: Meetup queries, client methods and observation mapping

**Files:**

- Modify: `src/lib/client/meetup/queries.ts` (append `getGroupEventsForAudit`, `getEventForAudit`), `src/lib/client/meetup/types.ts` (append `AuditEventNode`, `GetGroupEventsForAuditResponse`, `GetEventForAuditResponse`), `src/lib/client/meetup/gqlClient.ts` (two methods)
- Create: `src/lib/eventAudit/meetup.ts`
- Test: `tst/lib/eventAudit/meetup.test.ts`

**Interfaces (Produces):**

```ts
// types.ts
export interface AuditEventNode {
  id: unknown; title?: unknown; status?: unknown; dateTime?: unknown; duration?: unknown;
  eventUrl?: unknown; going?: unknown; waiting?: unknown;
  rsvpSettings?: { rsvpsClosed?: unknown } | null; venue?: { id?: unknown } | null;
  featuredEventPhoto?: { id?: unknown } | null;
  eventHosts?: ({ member?: { id?: unknown; name?: unknown } | null } | null)[] | null;
}
export interface GetGroupEventsForAuditResponse { groupByUrlname: { id: string; events: PaginatedData<AuditEventNode> } | null }
export interface GetEventForAuditResponse { event: AuditEventNode | null }
// gqlClient.ts
getGroupEventsForAudit(input: PaginationInput, filter?: GroupEventFilter): Promise<PaginatedData<AuditEventNode>>
  // filter sent as given (no month padding), never cached, logs page counts only; null group → MeetupGroupUnreadableError
getEventForAudit(eventId: string): Promise<AuditEventNode | null>
  // null when `event` is null; a ClientError with HTTP 200 and data.event === null is also null (Meetup's not-found); anything else throws
// meetup.ts
export const TITLE_MAX = 300; export const HOST_NAME_MAX = 100; export const RECENT_PAST_DAYS = 2;
export const MEETUP_EVENT_URL: RegExp; // moved here from hostEvents.ts and re-exported there
export function toObservation(node: unknown): EventObservation | undefined; // the spec's mapping table
export interface AuditMeetupReader {
  listEvents(now: Date): Promise<EventObservation[]>; // ACTIVE all pages + PAST [now-2d, now], deduped (upcoming wins)
  getEvent(eventId: string): Promise<EventObservation | null>; // null = Meetup has no such event
}
export function gqlAuditReader(meetup: Pick<GqlMeetupClient,'getGroupEventsForAudit'|'getEventForAudit'>): AuditMeetupReader;
export type ReadMeetup = <T>(fn: (reader: AuditMeetupReader) => Promise<T>) => Promise<T>;
export function organizerReadMeetup(getClient: () => Client | undefined, organizer?: OrganizerMeetupDeps): ReadMeetup;
  // (fn) => withOrganizerMeetup(getClient(), (meetup) => fn(gqlAuditReader(meetup)), organizer)
```

- [ ] **Step 1: Write the failing tests** (`meetup.test.ts`):
  - `toObservation` of a full node → every field mapped; `going: '7'` → null; `going: -1` → null; title of 400 chars → 300; a `<script>` title kept verbatim (escaping is the page's job); `id: 'abc'` → undefined; `dateTime: 'nope'` → undefined; `eventUrl: 'javascript:x'` → null; `eventUrl` matching `https://www.meetup.com/g/events/311000001/` → kept; host with non-digit id dropped; `duration: 'PT2H'` kept, `'2 hours'` → null; `status: 'WHATEVER'` → `'UNKNOWN'`.
  - `gqlAuditReader.listEvents(now)` with a fake client: calls `getGroupEventsForAudit` with `{status:['ACTIVE']}` then `{status:['PAST'], afterDateTime: now−2d ISO, beforeDateTime: now ISO}`; walks pages (`hasNextPage` once); an id in both lists appears once with the ACTIVE node; an invalid node is dropped.
  - `gqlAuditReader.getEvent` → mapped observation, or null for null.
  - `gqlClient.getEventForAudit`: with `nock` on `Configuration.meetup.endpoint`, a 200 body `{ data: { event: null }, errors: [{ message: 'not found' }] }` → null; a 500 → throws; `{ data: { event: {...} } }` → the node. (`tst/lib/client` has existing gqlClient tests to copy the nock setup from.)
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement** queries, types, client methods, `meetup.ts`; move `MEETUP_EVENT_URL` and re-export from `hostEvents.ts` so `attendanceUrl` keeps working. Add the two queries to `QUERY_NAMES` of `tst/fixtures/meetup/graphqlResponder.ts` only if a test there needs them (not required).
- [ ] **Step 4: Run** the new file and `tst/lib/hosts/hostEvents.test.ts` — PASS.
- [ ] **Step 5: Commit** `feat(eventAudit): audit queries and observation mapping`.

### Task 3: Repository and schema

**Files:**

- Create: `src/lib/repositories/postgresEventAuditRepository.ts`
- Test: `tst/integration/postgresEventAuditRepository.test.ts`

**Interfaces (Produces):**

```ts
export const EVENT_AUDIT_RETENTION_DAYS = 180;
export const EVENT_AUDIT_SCHEMA_SQL: string; // the spec's tables, indexes and the append-only trigger
export async function ensureEventAuditSchema(
  pool: pg.Pool,
  options?: DashboardTransactionOptions,
): Promise<void>;
export interface EventAuditRun {
  id: number;
  startedAt: Date;
  finishedAt: Date | null;
  requestedBy: string;
  listed: number | null;
  confirmed: number | null;
  changes: number | null;
  outcome: 'saved' | 'failed' | null;
}
export interface EventState {
  eventId: string;
  latest: EventSnapshot;
  firstSeenAt: Date;
  lastSeenAt: Date;
  deletedAt: Date | null;
}
export interface RunWrite {
  startedAt: Date;
  finishedAt: Date;
  requestedBy: string;
  listed: number;
  confirmed: number;
  observations: EventObservation[];
  deletedEventIds: string[];
  changes: NewEventChange[];
}
export interface ChangeFilter {
  kind?: EventChangeKind;
  hostId?: string;
  from?: Date;
  to?: Date;
  beforeId?: number;
}
export interface EventHistory {
  state: EventState;
  changes: EventChange[];
  snapshots: EventSnapshot[];
}
export class PostgresEventAuditRepository {
  static instance(): Promise<PostgresEventAuditRepository>;
  constructor(pool: pg.Pool);
  latestRun(): Promise<EventAuditRun | undefined>; // newest by started_at
  liveStates(): Promise<EventState[]>; // deleted_at IS NULL, with latest snapshot
  hasAnyState(): Promise<boolean>; // false = first run ever
  saveRun(write: RunWrite): Promise<{ runId: number; changes: EventChange[] }>;
  // one transaction: run row (outcome saved), a snapshot per observation (taken_at = startedAt),
  // state upsert (latest, last_seen; first_seen kept), deleted_at = finishedAt for deletedEventIds, change rows (run_id, detected_at = finishedAt)
  recordFailedRun(
    startedAt: Date,
    finishedAt: Date,
    requestedBy: string,
  ): Promise<void>;
  unalerted(kinds: EventChangeKind[], limit?: number): Promise<EventChange[]>; // alerted_at IS NULL, oldest first, default 50
  markAlerted(ids: number[], at: Date): Promise<void>;
  prune(
    now: Date,
    limit?: number,
  ): Promise<{ snapshots: number; changes: number; states: number }>; // default 5000 each
  listChanges(filter: ChangeFilter, limit?: number): Promise<EventChange[]>; // newest first (id DESC), default PAGE_SIZE 50
  eventHistory(
    eventId: string,
    snapshotLimit?: number,
  ): Promise<EventHistory | undefined>; // default 200
  recentChangesForHost(
    meetupId: string,
    options?: { limit?: number; since?: Date },
  ): Promise<EventChange[]>; // hosts @> [{id}], default 20
}
```

Ids are validated (`^[0-9]{1,20}$`) and an invalid id answers `undefined`/`[]` rather than querying. Rows whose `hosts` JSONB is not an array of `{id,name}` strings read back as `hosts: []` (Review Focus 5). The trigger: UPDATE on `event_changes` allowed only when every column but `alerted_at` is unchanged; DELETE on `event_changes`/`event_snapshots` allowed only when the row's time is older than `now() - 180 days`.

- [ ] **Step 1: Write the failing integration test** (pattern of `postgresEventAnnouncementRepository.test.ts`, `useIsolatedSchema('eventaudit')`, TRUNCATE the four tables in `beforeEach`):
  - schema ensure twice is fine; `hasAnyState()` false, `latestRun()` undefined.
  - `saveRun` with two observations and no changes → `liveStates()` has both with `latest.rsvpYes`; a second `saveRun` with one changed observation, one `deletedEventIds`, one `created` change → states: one live (latest updated, firstSeenAt kept), one `deletedAt` set; `latestRun().outcome === 'saved'`, `listed === 1`.
  - `unalerted(['deleted','cancelled','host_changed'])` returns only those kinds; `markAlerted` then empties it.
  - `listChanges` filters: by kind, by `hostId` (a host only in `oldValue` side still matches because `hosts` is the union), by `from`/`to`, cursor `beforeId` excludes that id and newer.
  - `eventHistory('311000001')` → snapshots newest first, changes newest first; unknown id → undefined; `'abc'` → undefined.
  - `recentChangesForHost('4242')` finds the change; `'9999'` → `[]`.
  - append-only: `UPDATE event_changes SET title = 'x'` rejects; `UPDATE … SET alerted_at = now()` succeeds; `DELETE FROM event_snapshots` rejects for a fresh row.
  - `prune(now + 181 days)` removes old snapshots that are not latest, old changes, and states whose latest is old (with its snapshot); a state's latest snapshot younger than 180 days is kept with its state.
  - `hosts` stored as `{}` by raw SQL reads back as `[]`.
- [ ] **Step 2: Run** on the throwaway stack — FAIL.
- [ ] **Step 3: Implement** the repository.
- [ ] **Step 4: Run** — PASS. Also `yarn test tst/lib/repositories` still passes.
- [ ] **Step 5: Commit** `feat(eventAudit): snapshot, state and change tables`.

### Task 4: Alerts

**Files:**

- Create: `src/lib/eventAudit/alerts.ts`
- Modify: `src/lib/reports/dashboardPaths.ts` (add `eventChanges: '/events'`, `eventHistory: '/events/:eventId'`, `eventSnapshot: '/events/snapshot'` to `DASHBOARD_PATHS`; add `eventHistoryPath(eventId: string): string | undefined` returning `${DASHBOARD_BASE}/events/${id}` only for `^[0-9]{1,20}$`)
- Test: `tst/lib/eventAudit/alerts.test.ts`, `tst/lib/reports/dashboardPaths.test.ts` (one case)

**Interfaces (Produces):**

```ts
export const ALERTABLE_KINDS: readonly EventChangeKind[] = [
  'deleted',
  'cancelled',
  'host_changed',
];
export const ALERT_CAP = 10;
export const ALERT_RATE_LIMIT_SEC = 6 * 60 * 60;
export const alertedKey = (eventId: string, kind: EventChangeKind) =>
  `event-audit-alerted-${eventId}-${kind}`;
export function changeAlertEntry(change: EventChange): LogEntry | undefined; // undefined for non-alertable kinds
export function summaryAlertEntry(count: number): LogEntry;
export function failureAlertEntry(error: unknown): LogEntry; // "Event snapshot failed: <describeBuildError>"; retries text
```

Entry titles: `Event deleted: <alertText(title)>`, `Event cancelled: …`, `Event hosts changed: …`. Description lines per the spec; hosts as `alertText(name) (id)` joined by `, `, `(no hosts listed)` when empty; RSVP line uses `?` for null counts; history link `${PUBLIC_APP_ORIGIN}${eventHistoryPath(id)}`; the Meetup link line only for cancelled/host_changed when `eventUrl` is non-null; for host_changed: `Hosts before: …` from `oldValue.hosts` and `Hosts now: …` from `newValue.hosts` (only entries that are `{id: digits, name: string}`). Summary: title `Event changes: N in one pass`, description names the page URL.

- [ ] **Step 1: Write the failing tests**: a deleted change with title `**bold** [x](http://e)` and host `@everyone` → title contains `Event deleted: \*\*bold\*\*`, description contains `\@everyone` is not required; assert no `<@` and no `@everyone` unescaped (`alertText` leaves `@everyone` as is, which embeds never ping; assert the description does not contain `<@&`), contains `23 going, 2 on the waitlist`, contains the history URL, does not contain `meetup.com` (deleted). Cancelled with a URL → contains the URL; host_changed → `Hosts before:` and `Hosts now:`; `rsvp_drop` → undefined. `failureAlertEntry(new Error('x'))` description has `Error`, not `x`. `eventHistoryPath('abc')` undefined.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** **Step 4: Run** the two files and `tst/lib/noPings.test.ts` — PASS.
- [ ] **Step 5: Commit** `feat(eventAudit): alert entries and dashboard paths`.

### Task 5: The run

**Files:**

- Create: `src/lib/eventAudit/run.ts`
- Test: `tst/lib/eventAudit/run.test.ts`, `tst/lib/eventAudit/fakes.ts` (an in-memory `FakeEventAuditStore` implementing the store interface below, and `fakeReader(events, byId)`)

**Interfaces (Produces):**

```ts
export const CONFIRM_CAP = 25;
export const FAILED_ALERT_TTL_SEC = 26 * 60 * 60;
export const BACKOFF_SEC = 30 * 60;
export const BACKOFF_KEY = 'event-audit-backoff';
export const failedAlertedKey = (day: string) =>
  `event-audit-failed-alerted-${day}`;
export type EventAuditStore = Pick<
  PostgresEventAuditRepository,
  | 'latestRun'
  | 'liveStates'
  | 'hasAnyState'
  | 'saveRun'
  | 'recordFailedRun'
  | 'unalerted'
  | 'markAlerted'
  | 'prune'
>;
export interface EventAuditDeps {
  now(): Date;
  cache(): Promise<KeyValueCache>;
  store(): Promise<EventAuditStore>;
  readMeetup: ReadMeetup;
  alert(entry: LogEntry): Promise<boolean>;
  newLeaseValue(): string;
}
export type RunOutcome =
  | {
      ok: true;
      listed: number;
      confirmed: number;
      changes: number;
      deleted: number;
      durationMs: number;
    }
  | { ok: false; error: unknown };
/** Never throws. Does not take the lease (job.ts does). */
export async function runEventAudit(
  deps: EventAuditDeps,
  requestedBy: string,
): Promise<RunOutcome>;
```

Algorithm (the spec's steps 1–7): inside one `readMeetup` call: list, load states, pick vanished (`startAt > now`, status not PAST/cancelled), confirm up to `CONFIRM_CAP` oldest-start-first, returning `{ observations, deletedIds, confirmed }`; then `baseline = !(await store.hasAnyState())`; diff each observation against its state's latest; `saveRun`; then alerts: `unalerted(ALERTABLE_KINDS)` (this run's and any left over), if `> ALERT_CAP` post the summary once and mark all; else per change `cache.exclusive_set(alertedKey, '1', ALERT_RATE_LIMIT_SEC)` → post → mark (a failed post removes the key); then `prune`. On a thrown error anywhere before the save: `recordFailedRun` (best effort), `cache.set(BACKOFF_KEY, iso, BACKOFF_SEC)`, once-a-day failure alert (`failedAlertedKey(utcDay(now))`, removed if the post failed), log `String(error)` to the process log only, return `{ ok: false }`.

- [ ] **Step 1: Write the failing tests** with the fakes (fixtures: three upcoming events; `now = 2026-11-10T18:00Z`):
  - first run on an empty store → 3 snapshots, 0 changes, 0 alerts, `hasAnyState` false before.
  - second run, event B missing from the list, `getEvent(B)` → null → one `deleted` change, one alert whose title starts `Event deleted:`, `deletedEventIds = [B]`, `confirmed = 1`.
  - B missing, `getEvent(B)` → the node with status `CANCELLED` → one `cancelled` change (not deleted), a snapshot of B written, alert `Event cancelled:`.
  - B missing, `getEvent(B)` throws → no change for B, run `ok`, B still live.
  - empty listing (outage shaped as a list) with 30 live events and `getEvent` throwing → `confirmed === 25`, 0 changes, `ok`.
  - B's start already past (prev snapshot start < now) and missing → not confirmed, not deleted.
  - 12 host changes in one run → one summary alert, all 12 marked alerted; 2 host changes → 2 alerts; the same event changing hosts again within 6 h (key present in the FakeCache) → no second alert, still marked.
  - `alert` returns false → row stays unalerted, key removed.
  - `readMeetup` throws → `ok: false`, `recordFailedRun` called, backoff key set, one failure alert; a second failure the same day → no second alert.
  - the leftover: a store with an unalerted `deleted` row from a previous run → alerted in this run.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `feat(eventAudit): the snapshot run with confirmed deletions and rate-limited alerts`.

### Task 6: Scheduler and manual request

**Files:**

- Create: `src/lib/eventAudit/job.ts`
- Modify: `src/index.ts` (call `startEventAuditScheduler(client)` after `startReportBuildScheduler`)
- Test: `tst/lib/eventAudit/job.test.ts`

**Interfaces (Produces):**

```ts
export const EVENT_AUDIT_TICK_MS = 15 * 60 * 1000;
export const EVENT_AUDIT_INTERVAL_MS = 55 * 60 * 1000;
export const EVENT_AUDIT_COOLDOWN_SEC = 2 * 60;
export const COOLDOWN_KEY = 'event-audit-cooldown';
export async function isEventAuditDue(
  store: Pick<EventAuditStore, 'latestRun'>,
  cache: KeyValueCache,
  now: Date,
): Promise<boolean>;
// false in backoff; true with no saved run; else latest saved run startedAt + 55 min <= now (failed runs ignored)
export async function runEventAuditTick(deps: EventAuditDeps): Promise<void>;
// skip in isQuietHour or identityDigestInProgress; acquireBuildLease or skip; due check; runEventAudit(deps, 'job'); releaseBuildLease in finally
export type EventAuditRefusal =
  'quiet-hour' | 'identity-sweep' | 'busy' | 'cooldown' | 'bad-requester';
export type EventAuditRequestResult =
  | { status: 'started'; done: Promise<RunOutcome> }
  | { status: EventAuditRefusal };
export async function requestEventAudit(
  deps: EventAuditDeps,
  requestedBy: string,
): Promise<EventAuditRequestResult>;
// requestRebuild's order: requester /^[0-9]{17,20}$/, canStartMonthBuild → 'quiet-hour', digest → 'identity-sweep', lease → 'busy', cooldown exclusive_set → 'cooldown' (lease released), then the run in the background releasing the lease in finally
export async function defaultEventAuditDeps(
  client: Client,
): Promise<EventAuditDeps>;
export function startEventAuditScheduler(
  client: Client,
  options?: { env?; makeDeps?; setIntervalFn?; log?; now? },
): void;
// no DATABASE_URL → warn and return; tick now and every EVENT_AUDIT_TICK_MS; one tick at a time; failures logged by String(error), never Discord
```

- [ ] **Step 1: Write the failing tests** (FakeCache, FakeEventAuditStore from Task 5, a `vi.fn` `readMeetup`): due rule (no run → true; saved run 54 min ago → false; 56 min → true; failed run 1 min ago but saved 2 h ago → true; backoff key → false); tick in the quiet hour (`2026-11-10T18:10Z`) does not read Meetup; lease held (`BUILD_LEASE_KEY` set) → no read, lease untouched; a due tick reads Meetup and releases the lease; `requestEventAudit` codes in order, `started` resolves `done` ok and releases the lease, the cooldown key has TTL 120; scheduler with no `DATABASE_URL` warns and never ticks.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement**, wire `index.ts`. **Step 4: Run** — PASS; `yarn test tst/lib/reports` unchanged.
- [ ] **Step 5: Commit** `feat(eventAudit): hourly scheduler on the build lease and Snapshot now`.

### Task 7: Dashboard deps and page fakes

**Files:**

- Modify: `src/web/routes/dashboardPages.ts` (`EventAuditPageReader = Pick<PostgresEventAuditRepository,'listChanges'|'eventHistory'|'latestRun'>`; on `DashboardPageDeps`: `eventAudit: () => Promise<EventAuditPageReader>`, `snapshotNow: (requestedBy: string) => Promise<EventAuditRequestResult | { status: 'unavailable' }>`), `src/web/dashboardDeps.ts` (wire `PostgresEventAuditRepository.instance()` and `requestEventAudit(await defaultEventAuditDeps(discordClient), id)` with the timed cache as `manualRebuildDeps` does; `{status:'unavailable'}` without a client), `tst/web/routes/pageFakes.ts` (`fakeEventAudit(changes: EventChange[], histories?: Record<string, EventHistory>, latestRun?: EventAuditRun)` with `vi.fn` methods implementing the filters in memory; `eventChangeRow(overrides)` fixture; defaults on `fakePageDeps`: one `deleted` row and `snapshotNow` resolving `{status:'started', done: Promise.resolve({ok:true,...})}`)
- Test: existing `tst/web/routes/access.test.ts` and `tst/web/dashboardDeps.test.ts` keep passing.

- [ ] **Step 1: Add the types and fakes; run** `yarn test tst/web` — PASS (nothing uses them yet).
- [ ] **Step 2: Commit** `feat(eventAudit): page deps and fakes`.

### Task 8: The pages

**Files:**

- Create: `src/web/routes/eventChanges.ts`
- Modify: `src/web/routes/dashboardPages.ts` (`registerEventChangeRoutes(router, deps)`), `src/web/pages.ts` (nav item `{ key: 'eventChanges', path: dashboardPath(DASHBOARD_PATHS.eventChanges), label: 'Event changes' }` after Identity changes), `tst/web/routes/responsive.test.ts` (add `/dashboard/events` to `TABLE_PAGES`)
- Test: `tst/web/routes/eventChanges.test.ts`

**Interfaces (Produces):**

```ts
export const KIND_LABELS: Record<EventChangeKind, string>; // Created, Cancelled, Deleted, Hosts changed, Start moved, Title changed, RSVPs dropped, RSVPs closed
export const SNAPSHOT_MESSAGES: Record<
  EventAuditRefusal | 'started' | 'error' | 'unavailable',
  string
>; // fixed text
export function registerEventChangeRoutes(
  router: express.Router,
  deps: Pick<DashboardPageDeps, 'now' | 'eventAudit' | 'snapshotNow'>,
): void;
```

Routes: GET `DASHBOARD_PATHS.eventChanges` (query: `kind` ∈ kinds, `host` digits, `from`/`to` calendar days via the identity page's `calendarDay`/`pacificMidnight` logic copied or extracted, `before` ≤ 18 digits; `?result=` notice), POST `DASHBOARD_PATHS.eventSnapshot` (`deps.snapshotNow(session.userId)`, redirect 303 to the list with `?result=<code>`; a thrown `CacheTimeoutError` propagates, other errors → `error`), GET `DASHBOARD_PATHS.eventHistory` (`:eventId` digits else 404; `eventHistory` undefined → 404). Details column per kind: created `New event`; cancelled `ACTIVE → CANCELLED`; deleted `Gone from Meetup`; host_changed `Hana → Hana, Ken`; start_moved `Dec 5, 2026 7:00 PM → Dec 6, 2026 7:00 PM`; title_changed `“old” → “new”`; rsvp_drop `20 → 14 going`; rsvps_closed `RSVPs closed`. Hosts cell: `memberLink({id,name})` each, plus `Only this host` filter link. Event cell: `eventLink({title, eventUrl})` and a `History` link to `eventHistoryPath`. The Snapshot-now card shows `Last snapshot: <pacificDateTime(latestRun.startedAt)> (saved|failed)` or `No snapshot yet`.

- [ ] **Step 1: Write the failing route tests** (setup like `hostPromotion.test.ts`): list 200 with `aria-current="page">Event changes`, a hostile title/host name not present raw, Meetup link only for a URL that passes `safeHref`, `Only this host` href carries `host=4242`; `?kind=deleted` passes `{kind:'deleted'}` to `listChanges` and `?kind=nope` passes none; `?before=12` → `beforeId: 12`; 50 rows → an `Older` link with `before=<last id>`; history page 200 with snapshots and changes, `/dashboard/events/abc` 404, unknown id 404; POST snapshot → 303 with `result=started`, `snapshotNow` called with `USER.id`; `busy` → `result=busy`; a rejecting `snapshotNow` → `result=error`; the message text for each code renders on the list; `eventAudit` rejecting → 503.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement** the page, register it, add the nav item and the responsive table page.
- [ ] **Step 4: Run** `yarn test tst/web` — PASS (access matrix, responsive, shell, pages tests included).
- [ ] **Step 5: Commit** `feat(eventAudit): Event changes page, event history and Snapshot now`.

### Task 9: Hardening and screenshots

**Files:**

- Test: `tst/web/routes/eventChanges.test.ts` (a row with `hosts: []` and `eventUrl: null` renders `unknown hosts` and no link), `tst/lib/eventAudit/meetup.test.ts` (10 000-char title → 300)
- Create: `docs/superpowers/screenshots/event-changes/README.md` + PNGs

- [ ] **Step 1: Add the two tests, run, make them pass.**
- [ ] **Step 2: Render** the list and history pages through the real router with `fakePageDeps` fixtures (a small script under the scratchpad using the test harness is fine, or a vitest file skipped by default) in the built-in browser at 360 and 1280 px, light and dark (`data-theme` toggle); save PNGs and the README describing each.
- [ ] **Step 3: Full checks**: `yarn lint`, `npx tsc --noEmit -p . | grep -v '^node_modules'`, `npx prettier --check "**/*.{ts,js,json,md}"`, `yarn test`, the integration command. All green.
- [ ] **Step 4: Commit** `docs(eventAudit): screenshots`; push; open the PR against `main` (do not merge); report the PR URL and `BASE..HEAD` SHAs to the "MeetupBot - lead" session.

## Self-review notes

- Spec coverage: snapshot (T2, T3, T5), diff (T1), deletion confirmation (T5), alerts and rate limit (T4, T5), scheduler and lease (T6), pages (T8), host hook (T3 `recentChangesForHost`), tests and screenshots (all, T9), retention (T3, T5).
- Names used across tasks: `EventObservation`, `NewEventChange`, `EventChange`, `EventSnapshot`, `EventState`, `EventHistory`, `RunWrite`, `ChangeFilter`, `EventAuditStore`, `EventAuditDeps`, `RunOutcome`, `ReadMeetup`, `AuditMeetupReader`, `EventAuditRequestResult`, `EventAuditRefusal`, `eventHistoryPath` — consistent above.
