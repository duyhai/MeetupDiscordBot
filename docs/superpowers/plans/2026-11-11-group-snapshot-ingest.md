# Group snapshot ingest (PR 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Pull the group's full event list and every past event's RSVPs into Postgres with the organizer token, keep it current daily, and show its state on the staff dashboard.

**Scope cut (lead, 2026-11-11):** PR 1 is minimal so the first pull can start soon (Hai will stop the per-member backfill to free the token when it deploys). The **Refresh snapshot now** button moves to PR 2; Task 6 is the card line only. Executed natively for speed.

**Architecture:** A 5-minute tick (`src/lib/snapshot/ingest.ts`) runs one phase-structured run at a time, recorded in `meetup_snapshot_runs`: list every event (one tick), mark deletions, then read RSVPs for the events that need them under a 150-call tick budget, resumable because the work set is a SQL query. Postgres access goes through a `SnapshotStore` interface (`postgresSnapshotRepository.ts`), faked in memory for unit tests. Nothing about Wrapped changes in this PR.

**Tech Stack:** TypeScript (ESM), node-pg, graphql-request, vitest, Express (dashboard), discord.js alerts.

**Spec:** `docs/superpowers/specs/2026-11-11-group-snapshot-design.md` (PR 1 sections, plus "Decisions after the builder check" 2–5).

## Global Constraints

- Organizer credential only through `withOrganizerMeetup`, with `makeClient: (t) => new GqlMeetupClient(t, { bypassCache: true })`; the new client methods are never cached either way.
- The report build lease (`acquireBuildLease` / `releaseBuildLease`, `src/lib/reports/buildLease.ts`) is held for one tick's reads and released in `finally`; a held lease skips the tick.
- Guards: `canStartMonthBuild(now)` and `!identityDigestInProgress(cache, now)`, checked at tick start and before each event.
- Constants (one block in `ingest.ts`): `SNAPSHOT_TICK_MS = 5 * 60_000`, `SNAPSHOT_TICK_CALL_BUDGET = 150`, `SNAPSHOT_RUN_INTERVAL_MS = 20 * 60 * 60_000`, `RSVP_SETTLE_DAYS = 14`, `LISTING_PAGE = 100`, `RSVP_PAGE = 100`, `MIN_LISTING_RATIO = 0.95`, `SNAPSHOT_RUN_NOW_KEY = 'group-snapshot-run-now'`, `SNAPSHOT_RUN_NOW_TTL_SEC = 2 * 60 * 60`.
- Stored: Meetup ids, statuses, titles, dates, URLs, counts. **No member names** anywhere (queries don't ask for them). RSVP statuses stored: `YES`, `WAITLIST`, `ATTENDED`; others dropped.
- Nothing from the snapshot in Redis; the only Redis keys a tick touches are the lease, the run-now flag and the failing-alert guard (`group-snapshot-alerted-<utcDay>`, TTL 26 h).
- Logs and alerts carry counts, ids and error **class names** only, never a Meetup body or message. Alerts plain, no mentions.
- Schema added to `DASHBOARD_SCHEMA_SQL` (`dashboardPool.ts`), exactly the spec's three tables and indexes, created under the existing schema lock.
- `yarn tsc --noEmit` (ignore `node_modules` noise), `yarn vitest run`, `yarn eslint .`, `yarn prettier --check .` clean; integration tests with `DATABASE_URL=postgres://postgres:postgres@localhost:55432/postgres REDISCLOUD_URL=redis://localhost:56379 npx vitest run --config vitest.integration.config.ts`.

## Review Focus

1. **A listing that comes back short or empty** (Meetup hiccup, wrong filter) must not mark the history deleted: below 95 % of stored PAST events, nothing is delisted and `last_error = 'ShortListing'`. Test in Task 4.
2. **A 401 mid-tick** makes `withOrganizerMeetup` re-run the callback: a re-run must not double-count calls into `events_fetched` / `rsvps_stored` or replace an event's rows with a partial set. Test in Task 4 (callback run twice → each event's rows replaced once, totals counted once).
3. **An event whose RSVP read fails every time** must not stall the run: skipped for the rest of the run, counted `failed`, and the run still finishes. Test in Task 4.
4. **A big event (> 100 RSVPs)** must be read across all pages before its rows are replaced, and the budget check must not cut it mid-pages. Test in Task 4.
5. **Two processes ticking at once** (web + worker dyno): the open-run unique index and the lease mean one does the work; the other's `startRun` returns undefined. Test in Task 2 (integration) and Task 4.

---

### Task 1: Meetup snapshot queries and node validation

**Files:**

- Modify: `src/lib/client/meetup/queries.ts` (add two queries), `src/lib/client/meetup/types.ts` (node types), `src/lib/client/meetup/gqlClient.ts` (two methods)
- Create: `src/lib/snapshot/meetup.ts`
- Test: `tst/lib/snapshot/meetup.test.ts`, extend `tst/lib/client/` gql client test if one covers request shapes (else a new `tst/lib/client/snapshotQueries.test.ts` asserting the query text)

**Interfaces:**

- Produces:
  - `SnapshotEventNode { id; title; dateTime; eventUrl; status; eventHosts: { member: { id } }[] | null; attendance: { totalCount } | null; waitlist: { totalCount } | null }` (all `unknown`-tolerant at validation).
  - `SnapshotRsvpNode { status: string; member: { id: string } | null }`.
  - `GqlMeetupClient.getGroupEventsForSnapshot(input: PaginationInput, filter: GroupEventFilter): Promise<PaginatedData<SnapshotEventNode>>` — filter as given, uncached, `MeetupGroupUnreadableError` on a null group, logs counts only.
  - `GqlMeetupClient.getEventRsvpsForSnapshot(eventId: string, input: PaginationInput): Promise<PaginatedData<SnapshotRsvpNode> | null>` — filter fixed to `{ rsvpStatus: ['YES', 'WAITLIST', 'ATTENDED'] }`, uncached; `null` when the event is null.
  - `SnapshotEvent { eventId: string; title: string; dateTime: Date; eventUrl: string | null; status: EventStatus | 'UNKNOWN'; hostIds: string[]; yesCount: number | null; waitlistCount: number | null }`
  - `SnapshotRsvp { memberId: string; status: 'YES' | 'WAITLIST' | 'ATTENDED' }`
  - `toSnapshotEvent(node: unknown): SnapshotEvent | undefined`, `toSnapshotRsvp(node: unknown): SnapshotRsvp | undefined` in `src/lib/snapshot/meetup.ts`.

- [ ] **Step 1: Write failing tests** in `tst/lib/snapshot/meetup.test.ts`:
  - `toSnapshotEvent` keeps a well-formed node (hosts → `hostIds: ['111','222']`, counts copied).
  - non-digit id, missing or unparsable `dateTime` → `undefined`.
  - `eventUrl` not matching `MEETUP_EVENT_URL` → `null`; title trimmed and bounded to `TITLE_MAX` (reuse from `eventAudit/meetup.ts`); unknown status → `'UNKNOWN'`; negative/float count → `null`; host entries with non-digit ids dropped.
  - `toSnapshotRsvp`: `NO` or unknown status → `undefined`; missing member or non-digit id → `undefined`.
  - The query text test: `getGroupEventsForSnapshot` contains `attendance: rsvps(filter: { rsvpStatus: [YES, ATTENDED] })`, `waitlist: rsvps(filter: { rsvpStatus: [WAITLIST] })`, `eventHosts { member { id } }` and does **not** contain `name`; `getEventRsvpsForSnapshot` asks `member { id }` and not `name`.
- [ ] **Step 2: Run** `npx vitest run tst/lib/snapshot/meetup.test.ts` — expect FAIL (module not found).
- [ ] **Step 3: Implement** the queries, types, client methods (pattern: `getGroupEventsForAudit` / `getEventForAudit`) and validators.
- [ ] **Step 4: Run** the test file — PASS. `yarn tsc --noEmit | grep -v '^node_modules'` — empty.
- [ ] **Step 5: Commit** `Group snapshot: Meetup queries and node validation`.

### Task 2: Schema and Postgres repository

**Files:**

- Modify: `src/lib/repositories/dashboardPool.ts` (append the three tables verbatim from the spec, with the spec's comments, plus `status IN ('YES','WAITLIST','ATTENDED')` CHECK)
- Create: `src/lib/repositories/postgresSnapshotRepository.ts`
- Create: `tst/lib/snapshot/fakes.ts` (`FakeSnapshotStore implements SnapshotStore`, same contract in memory)
- Test: `tst/integration/postgresSnapshotRepository.test.ts` (isolated schema via `tst/integration/isolatedSchema.ts`)

**Interfaces:**

- Consumes: `SnapshotEvent`, `SnapshotRsvp` (Task 1).
- Produces (`SnapshotStore`):

  ```ts
  interface SnapshotRun {
    id: number;
    trigger: string;
    kind: 'full' | 'incremental';
    startedAt: Date;
    finishedAt?: Date;
    listedAt?: Date;
    eventsListed: number;
    eventsFetched: number;
    rsvpsStored: number;
    failed: number;
    requests: number;
    lastError?: string;
  }
  interface SnapshotDelta {
    eventsFetched: number;
    rsvpsStored: number;
    failed: number;
  }
  interface SnapshotStore {
    openRun(): Promise<SnapshotRun | undefined>;
    lastFinishedRun(): Promise<SnapshotRun | undefined>;
    hasFinishedFull(): Promise<boolean>;
    /** undefined when one is open (the unique index). */
    startRun(
      trigger: string,
      kind: 'full' | 'incremental',
    ): Promise<SnapshotRun | undefined>;
    /** Non-deleted events with status PAST. */
    pastEventCount(): Promise<number>;
    upsertEvents(events: SnapshotEvent[], listedAt: Date): Promise<void>;
    /** deleted_at = at for non-deleted PAST/CANCELLED rows with listed_at < before; returns the count. */
    markDelisted(before: Date, at: Date): Promise<number>;
    /** deleted_at from event_audit_state.deleted_at; returns the count. */
    markAuditDeletions(): Promise<number>;
    /** deleted_at = at for one event (a by-id read answered null). */
    markDeleted(eventId: string, at: Date): Promise<void>;
    markListed(
      runId: number,
      listedAt: Date,
      eventsListed: number,
    ): Promise<void>;
    /** The spec's three rules, oldest date_time first, excluding `skip`. */
    eventsNeedingRsvps(q: {
      runStartedAt: Date;
      now: Date;
      settleDays: number;
      limit: number;
      skip: string[];
    }): Promise<{ eventId: string; dateTime: Date }[]>;
    pendingRsvpCount(q: {
      runStartedAt: Date;
      now: Date;
      settleDays: number;
    }): Promise<number>;
    /** One transaction: delete the event's rows, insert these, set rsvps_fetched_at. */
    replaceRsvps(
      eventId: string,
      rsvps: SnapshotRsvp[],
      fetchedAt: Date,
    ): Promise<void>;
    advance(runId: number, delta: SnapshotDelta): Promise<void>;
    recordRequests(runId: number, calls: number): Promise<void>;
    /** Sets last_error (a class name) on the run. */
    recordError(runId: number, errorName: string): Promise<void>;
    finishRun(runId: number): Promise<SnapshotRun | undefined>;
    totals(): Promise<{ events: number; rsvps: number }>;
  }
  ```

  `PostgresSnapshotRepository.instance()` singleton like `PostgresWrappedEntryRepository`.

- [ ] **Step 1: Write failing integration tests:**
  - schema created twice (`ensureDashboardSchema` ×2) without error;
  - `startRun` twice → second `undefined`; after `finishRun`, `lastFinishedRun().kind` kept, `hasFinishedFull()` true only after a `full` finished;
  - `upsertEvents` then again with a changed title/status updates in place, `listed_at` moves;
  - `replaceRsvps` replaces (3 rows → 2 rows, `rsvps_fetched_at` set); a duplicate member id in the input is collapsed (last wins), not a PK error;
  - `eventsNeedingRsvps`: never-read PAST → included; PAST 3 days ago read before `runStartedAt` → included, read after → excluded; PAST 40 days ago read once → excluded; `rsvps_fetched_at < date_time` → included; ACTIVE, deleted, or in `skip` → excluded; ordered by `date_time`;
  - `markAuditDeletions` copies `event_audit_state.deleted_at` (seed a state row via `PostgresEventAuditRepository.saveRun` or a direct insert in the isolated schema);
  - `markDelisted(before)` marks only PAST/CANCELLED rows with older `listed_at`, never ACTIVE;
  - `totals()` excludes nothing (raw counts) — events and rows.
    Also write the matching unit contract for `FakeSnapshotStore` in the same task (the fake is used from Task 4).
- [ ] **Step 2: Run** with the integration env line — FAIL.
- [ ] **Step 3: Implement** schema + repository. `replaceRsvps` uses `inDashboardTransaction`; inserts via `unnest($2::text[], $3::text[])`.
- [ ] **Step 4: Run** integration file — PASS; unit tests unaffected.
- [ ] **Step 5: Commit** `Group snapshot: tables and repository`.

### Task 3: Reading one listing and one event (organizer reads, counted)

**Files:**

- Create: `src/lib/snapshot/read.ts`
- Test: `tst/lib/snapshot/read.test.ts`

**Interfaces:**

- Consumes: Task 1 client methods and validators.
- Produces:
  - `type SnapshotMeetup = Pick<GqlMeetupClient, 'getGroupEventsForSnapshot' | 'getEventRsvpsForSnapshot'>`
  - `interface CallCounter { n: number }`
  - `listAllEvents(meetup: SnapshotMeetup, calls: CallCounter): Promise<{ events: SnapshotEvent[]; pastSeen: number; dropped: number }>` — pages `status: ['PAST', 'CANCELLED']` then `['ACTIVE']`, 100 per page via `getPaginatedData`, one count per page; deduped by id (ACTIVE wins, as the audit); `pastSeen` = validated PAST events.
  - `readEventRsvps(meetup: SnapshotMeetup, eventId: string, calls: CallCounter): Promise<SnapshotRsvp[] | null>` — every page; `null` when Meetup has no such event.

- [ ] **Step 1: Failing tests:** two PAST pages + one ACTIVE page → 3 calls, deduped events, `dropped` counts invalid nodes; an RSVP read over 3 pages (250 rows) → 3 calls, 250 rsvps, `NO` rows dropped; a null event → `null`; an error propagates.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `Group snapshot: listing and RSVP reads`.

### Task 4: The tick

**Files:**

- Create: `src/lib/snapshot/ingest.ts`
- Test: `tst/lib/snapshot/ingest.test.ts` (uses `FakeSnapshotStore`, a fake `SnapshotMeetup`, the in-memory cache)

**Interfaces:**

- Consumes: Tasks 2–3.
- Produces:
  ```ts
  interface SnapshotDeps {
    now(): Date;
    cache(): Promise<KeyValueCache>;
    store(): Promise<SnapshotStore>;
    withOrganizer<T>(fn: (meetup: SnapshotMeetup) => Promise<T>): Promise<T>;
    canStart(now: Date, cache: KeyValueCache): Promise<boolean>;
    alert(entry: LogEntry): Promise<boolean>;
    newLeaseValue(): string;
    log?: Pick<Logger<unknown>, 'info' | 'warn' | 'error'>;
  }
  type SnapshotTickOutcome =
    | { kind: 'skipped'; reason: 'guard' | 'lease' | 'not-due' }
    | {
        kind: 'ran';
        runId: number;
        listed: boolean;
        fetched: number;
        failed: number;
        calls: number;
        finished: boolean;
      }
    | { kind: 'failed'; runId: number | undefined; error: string };
  function runSnapshotTick(deps: SnapshotDeps): Promise<SnapshotTickOutcome>;
  function resetSkipped(): void; // tests
  ```
  The constants block from Global Constraints lives here and is exported.

Order inside a tick: guard → open run, else due check (`SNAPSHOT_RUN_NOW_KEY` set, or no finished run, or last finished ≥ `SNAPSHOT_RUN_INTERVAL_MS` ago) → `startRun(trigger, (await hasFinishedFull()) ? 'incremental' : 'full')` and remove the flag → lease → `withOrganizer`: listing phase if `!run.listedAt` (prev = `pastEventCount()` before upsert; upsert; delist only if `pastSeen >= MIN_LISTING_RATIO * prev`, else `recordError('ShortListing')`; `markAuditDeletions`; `markListed`) → RSVP loop (one event per iteration: budget and guard check, `eventsNeedingRsvps(limit 1, skip)`, read, `replaceRsvps`, or on `null` `markDeleted(eventId, now)` and log the id, on error add to the module-level skip set keyed by run id and `advance({failed:1})`) → empty set ⇒ `finishRun` → release lease, `recordRequests` in `finally`. Re-run safety: the callback recomputes from the store each time; `advance` is called only after a successful `replaceRsvps`, so a 401 re-run re-reads only events not yet replaced; calls are counted on the outer counter (paid twice, as the backfill notes).

- [ ] **Step 1: Failing tests** (each its own `it`):
  - no run, nothing finished → starts a `full` run, lists, reads events oldest first, stops at 150 calls (`calls` ≤ 150 + the pages of the event in flight), run stays open;
  - next ticks continue without listing again and finish; a second run after 20 h is `incremental`; before 20 h → `not-due`; with the run-now flag → starts and removes the flag;
  - short listing (stored 100 PAST, listing returns 90) → nothing delisted, `lastError === 'ShortListing'`; full listing → absent PAST rows delisted;
  - audit deletions applied in the listing phase;
  - an event over 100 RSVPs read across all pages before replace (Review Focus 4);
  - one event always throwing → skipped for the run, `failed` 1, run finishes; next run retries it (after `resetSkipped` simulating a new run id);
  - `withOrganizer` invoking the callback twice (fake that throws a 401-shaped error on first pass after two events, then re-runs) → each event replaced exactly once, `eventsFetched` equals distinct events (Review Focus 2);
  - guard false → `skipped: 'guard'`, no Meetup call; lease held → `skipped: 'lease'`; guard turning false mid-loop ends the tick cleanly;
  - lease released when the callback throws; the throw → `failed` outcome, `recordError(<class name>)`, one alert per UTC day titled "Group snapshot is failing", description has the class name and no message text;
  - an event whose RSVP read answers `null` → `markDeleted`, no rows written, not counted failed;
  - a failure while the open run started more than 24 h ago → the failing alert's description also says the run has been open for <n> h;
  - full run finish → one alert "Group snapshot finished" with events, RSVP rows, calls, failed, duration; incremental finish → no alert;
  - `startRun` returning undefined (another process) → `not-due`, no reads (Review Focus 5);
  - no alert entry contains `<@` or `@everyone` (reuse `tst/lib/noPings` helpers if they apply).
- [ ] **Step 2: Run** `npx vitest run tst/lib/snapshot/ingest.test.ts` — FAIL.
- [ ] **Step 3: Implement** `runSnapshotTick`.
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `Group snapshot: the ingest tick`.

### Task 5: Scheduler and production wiring

**Files:**

- Create: `src/lib/snapshot/job.ts`
- Modify: `src/index.ts` (start beside `startWrappedBackfillScheduler`)
- Test: `tst/lib/snapshot/job.test.ts`

**Interfaces:**

- Produces: `startGroupSnapshotScheduler(client: Client, makeDeps: () => Promise<SnapshotDeps>, options?: { env?; setIntervalFn?; log?; runTick? }): void`; `productionSnapshotDeps(getClient: () => Client | undefined): Promise<SnapshotDeps>` (organizer via `withOrganizerMeetup` with the bypass-cache `makeClient`; `canStart` = `canStartMonthBuild(now) && !(await identityDigestInProgress(cache, now))`; `alert` via `logAlert`; `store` = `PostgresSnapshotRepository.instance()`).

- [ ] **Step 1: Failing tests:** no `DATABASE_URL` → warns and never ticks; ticks once at start and every `SNAPSHOT_TICK_MS`; an overlapping tick is skipped; a `makeDeps` rejection is logged, never thrown.
- [ ] **Step 2–4:** run (FAIL), implement (pattern: `startWrappedBackfillScheduler`), run (PASS).
- [ ] **Step 5: Commit** `Group snapshot: scheduler`.

### Task 6: Staff card line (Refresh button deferred to PR 2)

**Files:**

- Modify: `src/web/routes/wrappedBackfill.ts`, `src/lib/reports/dashboardPaths.ts` (`snapshotRefresh: '/wrapped/snapshot/run'`), `src/web/dashboardDeps.ts`, `src/web/routes/dashboardPages.ts` (register), `tst/web/routes/pageFakes.ts` (fake control)
- Test: `tst/web/routes/wrappedBackfill.test.ts` (extend)

**Interfaces:**

- Consumes: `SnapshotStore` (`lastFinishedRun`, `openRun`, `totals`, `pendingRsvpCount`), `SNAPSHOT_RUN_NOW_KEY`, `SNAPSHOT_RUN_NOW_TTL_SEC`, `RSVP_SETTLE_DAYS`.
- Produces: `WrappedBackfillControl` gains
  `snapshot(): Promise<SnapshotStatus>` and `refreshSnapshot(requestedBy: string): Promise<RunNowOutcome>`, with
  `SnapshotStatus { lastRun?: SnapshotRun; openRun?: SnapshotRun; events: number; rsvps: number; pending: number }`;
  notice codes `snapshot-requested`, `snapshot-already-running`, `snapshot-already-requested` added to `BACKFILL_NOTICES` (fixed text), sharing `not-leadership`/`unavailable`/`error`.

Card copy (exact pattern; numbers via `toLocaleString('en-US')`, dates via `pacificDateTime`):

- finished: `Group snapshot: updated <age> ago (<pacific date time> Pacific) · <events> events · <rsvps> RSVPs · last run: <kind>, <requests> calls, <failed> failed.`
- open run: `Group snapshot: refreshing (<kind>): <eventsFetched> of ~<eventsFetched + pending> events read.` (followed by the finished line if one exists)
- none: `Group snapshot: not pulled yet.`
- `lastError` on the open or last run: append ` Last tick failed (<lastError>).`
- Form: `Refresh snapshot now` button posting to the new path, shown when no snapshot run is open and a CSRF token exists.

- [ ] **Step 1: Failing tests:** each card state renders its line (not pulled, open with pending, finished, last error class); a failing `snapshot()` degrades only the line; the POST matrix mirrors Run now (not leadership → `not-leadership`; Discord down → `unavailable`; leader → `snapshot-requested` + audit "Group snapshot refresh requested"; open run → `snapshot-already-running`; second press → `snapshot-already-requested`); an unknown notice code renders nothing.
- [ ] **Step 2–4:** run (FAIL), implement, run (PASS).
- [ ] **Step 5: Commit** `Group snapshot: staff card line and Refresh snapshot now`.

### Task 7: Verification, PR

- [ ] **Step 1:** `yarn tsc --noEmit 2>&1 | grep -v '^node_modules'` empty; `yarn vitest run` all pass; `yarn eslint .` and `yarn prettier --check .` clean; integration suite with the env line passes.
- [ ] **Step 2:** Screenshot the card (dev preview) in each state into `docs/screenshots/2026-11-11-group-snapshot/`.
- [ ] **Step 3:** PR against `main`: summary, sizing estimate (replace with probe numbers when the lead returns them), budget and pacing table, the probe's status, "no names stored / indefinite retention (lead, 2026-11-11)", follow-up PR 2. Report URL and BASE..HEAD to "MeetupBot - lead" for review.
