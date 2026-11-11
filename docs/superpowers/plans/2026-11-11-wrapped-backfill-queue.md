# Wrapped: backfill for everyone and a queue for throttled requests (PR B) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A paced background job builds every linked member's Wrapped for every year back to their first event into the same cache the page and command read, and a member who hits the hourly limit with nothing cached is queued and told when it will be ready; staff see a card and can run the job now.

**Architecture:** A Postgres repository (two tables in the dashboard schema) records runs and the queue; `build.ts` splits into "read the sources once" and "build one year from them" so the backfill and the on-demand path produce identical entries; a tick module drains the queue then sweeps members under the report build lease (organizer reads only), a per-tick member cap and a Meetup call budget; the command and the page enqueue on a rate-limit miss and show "ready by"; a dashboard card and a leadership-only Run now ride the existing home-page card and POST patterns.

**Tech Stack:** TypeScript ESM, pg via `dashboardPool`, Redis via `KeyValueCache`, discord.js, Express 5 `html` template, vitest; integration on the throwaway `postgres:16` :55432 / `redis:7` :56379.

**Spec:** `docs/superpowers/specs/2026-11-10-wrapped-design.md`, "Addendum (2026-11-11)", section "PR B" and "Decisions after the builder check" (2–7).

## Global Constraints

- Privacy unchanged: the backfill writes exactly what `buildWrapped` writes; no Meetup name or id of another person in a log line (ids of the member being built are fine), in an alert, or in Postgres (the queue holds the member's own Meetup id).
- Pacing constants (one place, `src/lib/wrapped/backfill.ts`): `BACKFILL_TICK_MS = 5 * 60_000`, `MEMBERS_PER_TICK = 4`, `TICK_CALL_BUDGET = 150`, `RUN_INTERVAL_MS = 20 * 60 * 60_000`, `FRESH_CURRENT_YEAR_MS = 7 * 24 * 60 * 60_000`, `QUEUE_MAX_ATTEMPTS = 3`, `QUEUE_CLAIM_STALE_MS = 15 * 60_000`. One build in flight: the tick is sequential.
- Fresh = a cached copy for the member's current Meetup id, and (past year) any, or (current year) `builtAt` within `FRESH_CURRENT_YEAR_MS`.
- Guards per tick: `isQuietHour(now)` or `identityDigestInProgress(cache, now)` → nothing starts. Organizer-credential builds take `acquireBuildLease` (`report-build-claim`) for that member's build and release it after; member-token builds take none. Every year's build takes `buildingKey(discordUserId, year)` with `exclusive_set` (TTL `BUILDING_LEASE_TTL_SEC`) and never calls `claimBuild` (no hourly slot spent).
- Organizer client for the backfill: `withOrganizerMeetup(client, fn, { ...defaultOrganizerMeetupDeps, makeClient: (t) => new GqlMeetupClient(t) })` (request cache ON). Member-token path = `getSelfPastRsvpEvents` with the account-mismatch check; mismatch or a 401 anywhere → redo the member on the organizer path; any other error → member failed, retried next run.
- Queue: at most one row per Discord id; added only when rate-limited AND no cached copy for the current Meetup id; a row whose copy exists at drain time is dropped unbuilt; a successful on-demand build drops the member's row.
- Ready-by: `nextTickAt + floor((position − 1) / MEMBERS_PER_TICK) × BACKFILL_TICK_MS`, pushed past the quiet hour (18:00–19:00 UTC) when it falls inside; web shows Pacific `h:mm a`, Discord `<t:unix:t>`; copy "Queued — it'll be ready by about …".
- Alerts: one plain summary per finished run (`logAlert`, no mentions); per-member failures logged by `error.name` only; a failing tick never alerts more than once per UTC day (reuse the report scheduler's pattern).
- Staff POST guards are the router's (CSRF, Origin, rate limit) plus a live `isLeadership` check and an audit entry, as `wrappedAnnounce.ts`.
- `no-await-in-loop` is an error: sequential loops carry the client's disable comment with a reason.

## Review Focus

1. A member unlinked (row deleted) after being queued: the drain drops the row and logs nothing personal (Task 4 test "drops a queued member who is no longer linked").
2. A member whose first event is in a year before `FIRST_WRAPPED_YEAR` (2015): the sweep starts at 2015, never earlier (Task 4 test "years start no earlier than 2015").
3. A tick that starts at 17:58 UTC with a member half-built: it stops before the next year once the quiet hour starts, releases its leases, and the cursor stays on the previous member so the member is redone (Task 4 test "stops at the quiet hour and leaves the cursor behind").
4. Two processes ticking at once (deploy overlap): the queue claim is `FOR UPDATE SKIP LOCKED`, the run cursor advances only from the process that holds the row's `cursor` it read (compare-and-set), so no member is built twice in one run (Task 1 integration test "two claimers never get the same row"; Task 1 "advance is a compare-and-set").
5. Run now pressed while a run is open: refused with a fixed notice, nothing else changes (Task 6 test "Run now during a run is 'already running'").

---

### Task 1: Postgres repository: runs and queue

**Files:**

- Modify: `src/lib/repositories/dashboardPool.ts` (append to `DASHBOARD_SCHEMA_SQL`)
- Create: `src/lib/repositories/postgresWrappedBackfillRepository.ts`
- Test: `tst/integration/postgresWrappedBackfillRepository.test.ts`

**Interfaces:**

- Produces:

```sql
CREATE TABLE IF NOT EXISTS wrapped_backfill_runs (
  id            SERIAL PRIMARY KEY,
  trigger       TEXT NOT NULL CHECK (trigger = 'job' OR trigger ~ '^[0-9]{1,20}$'),
  started_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at   TIMESTAMPTZ,
  members_total INTEGER NOT NULL,
  members_done  INTEGER NOT NULL DEFAULT 0,
  built         INTEGER NOT NULL DEFAULT 0,
  skipped       INTEGER NOT NULL DEFAULT 0,
  failed        INTEGER NOT NULL DEFAULT 0,
  cursor        TEXT            -- last Discord id processed; NULL = none yet
);
CREATE UNIQUE INDEX IF NOT EXISTS wrapped_backfill_runs_open_idx ON wrapped_backfill_runs ((true)) WHERE finished_at IS NULL;
CREATE TABLE IF NOT EXISTS wrapped_queue (
  discord_user_id TEXT PRIMARY KEY CHECK (discord_user_id ~ '^[0-9]{1,20}$'),
  meetup_id       TEXT NOT NULL,
  year            INTEGER NOT NULL CHECK (year BETWEEN 2015 AND 2100),
  queued_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  claimed_at      TIMESTAMPTZ,
  attempts        INTEGER NOT NULL DEFAULT 0
);
```

```ts
export interface BackfillRun {
  id: number;
  trigger: string;
  startedAt: Date;
  finishedAt: Date | undefined;
  membersTotal: number;
  membersDone: number;
  built: number;
  skipped: number;
  failed: number;
  cursor: string | undefined;
}
export interface QueueRow {
  discordUserId: string;
  meetupId: string;
  year: number;
  queuedAt: Date;
  attempts: number;
}
export interface WrappedBackfillStore {
  openRun(): Promise<BackfillRun | undefined>;
  lastFinishedRun(): Promise<BackfillRun | undefined>;
  /** undefined when a run is already open (the partial unique index refuses it). */
  startRun(
    trigger: string,
    membersTotal: number,
  ): Promise<BackfillRun | undefined>;
  /** Compare-and-set on `cursor`: false when another process moved it. Adds the deltas. */
  advanceRun(
    id: number,
    from: string | undefined,
    to: string,
    delta: { done: number; built: number; skipped: number; failed: number },
  ): Promise<boolean>;
  finishRun(id: number): Promise<BackfillRun | undefined>;
  /** 'queued' on insert; { already: year } when the member already has a row (left as is). */
  enqueue(row: {
    discordUserId: string;
    meetupId: string;
    year: number;
  }): Promise<'queued' | { already: number }>;
  /** 1-based position among unfinished rows by queued_at, with the row; undefined when none. */
  position(
    discordUserId: string,
  ): Promise<{ position: number; row: QueueRow } | undefined>;
  queueLength(): Promise<number>;
  /** Oldest first, unclaimed or stale (claimed_at < now − staleMs), FOR UPDATE SKIP LOCKED; sets claimed_at. */
  claimNext(limit: number, staleMs: number): Promise<QueueRow[]>;
  complete(discordUserId: string): Promise<void>;
  /** attempts + 1; dropped (deleted) when that reaches maxAttempts, else released. Returns 'released' | 'dropped'. */
  release(
    discordUserId: string,
    maxAttempts: number,
  ): Promise<'released' | 'dropped'>;
}
export class PostgresWrappedBackfillRepository implements WrappedBackfillStore {
  static instance();
  constructor(pool);
}
```

- [ ] **Step 1: Write the failing integration tests** (pattern: `postgresWrappedAnnouncementRepository.test.ts`, `useIsolatedSchema('wrapped_backfill')`, `ensureDashboardSchema`):

```ts
it('the schema is idempotent on a second boot');
it('starts one run at a time; a second start while one is open is refused'); // startRun → run; startRun again → undefined; finishRun → startRun works
it('advance is a compare-and-set and sums the deltas'); // advance(id, undefined, 'a', {done:1,built:2,skipped:1,failed:0}) true; advance(id, undefined, 'b', …) false (cursor is 'a'); openRun().built === 2
it('enqueue keeps the first year for a member'); // 'queued', then { already: 2026 } for 2025
it('positions by queued_at and counts the queue'); // three rows → positions 1..3, queueLength 3
it(
  'claimNext takes the oldest unclaimed, then nothing until the claim is stale',
); // claim(2, 60_000) → 2 rows; claim(2, 60_000) → 1 row; claim again → []; with staleMs 0 → the first two again
it('two claimers never get the same row'); // two pools/clients claiming concurrently with Promise.all → disjoint ids
it('release counts attempts and drops at the cap'); // release(…, 3) → 'released' ×2, then 'dropped'; position undefined after
it('complete removes the row');
```

- [ ] **Step 2: Run** `DATABASE_URL=postgres://postgres:postgres@localhost:55432/postgres REDISCLOUD_URL=redis://localhost:56379 npx vitest run --config vitest.integration.config.ts tst/integration/postgresWrappedBackfillRepository.test.ts` → FAIL (module missing).
- [ ] **Step 3: Implement** the SQL in `DASHBOARD_SCHEMA_SQL` and the class (singleton `instance()` as the announcement repository; `claimNext` as `WITH c AS (SELECT discord_user_id FROM wrapped_queue WHERE claimed_at IS NULL OR claimed_at < now() − make_interval(secs => $2/1000) ORDER BY queued_at LIMIT $1 FOR UPDATE SKIP LOCKED) UPDATE wrapped_queue q SET claimed_at = now() FROM c WHERE q.discord_user_id = c.discord_user_id RETURNING …`; `advanceRun` as `UPDATE … SET cursor = $3, members_done = members_done + …, … WHERE id = $1 AND cursor IS NOT DISTINCT FROM $2`).
- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit** — `git commit -m "Wrapped backfill: runs and queue tables and repository"`.

### Task 2: Build from sources once per member

**Files:**

- Modify: `src/lib/wrapped/build.ts`
- Test: `tst/lib/wrapped/build.test.ts`

**Interfaces:**

- Produces:

```ts
export interface WrappedSources {
  events: EventSummary[];
  hosted: HostedEvent[];
}
export type SourceDeps = Pick<
  BuildDeps,
  'meetup' | 'findByMeetupId' | 'isPresent' | 'now' | 'log' | 'onProgress'
>;
/** The member's hosted events with attendance (was readHosted). */
export async function readHostedEvents(
  meetup: WrappedMeetup,
  hostId: string,
): Promise<HostedEvent[]>;
/** Everything after the history and the slot: attendees for the year, stats, cohort, naming. Pure over `sources`. */
export async function buildWrappedYear(
  deps: SourceDeps,
  linkedMeetupId: string,
  year: number,
  sources: WrappedSources,
): Promise<CachedWrapped>;
// buildWrapped = readHistory → claimBuild → readHostedEvents → buildWrappedYear; its result for a year is byte-identical to before.
```

- [ ] **Step 1: Write the failing tests**:

```ts
it('buildWrappedYear builds one year from sources without reading history or hosted again', …)   // getSelfPastRsvpEvents/getHostedEvents not called; result equals buildWrapped's wrapped for the same year (deep equal)
it('buildWrappedYear for two years shares the sources and fetches each year’s attendees once', …)
```

- [ ] **Step 2: Run → FAIL.** `yarn vitest run tst/lib/wrapped/build.test.ts`
- [ ] **Step 3: Refactor `build.ts`** into the three exports; keep `buildWrapped`'s signature and progress messages.
- [ ] **Step 4: Run → PASS** (`tst/lib/wrapped`, `tst/web/host/wrappedPage.test.ts`).
- [ ] **Step 5: Commit** — `git commit -m "Wrapped build: read sources once, build any year from them"`.

### Task 3: Queue helpers and ready-by

**Files:**

- Create: `src/lib/wrapped/queue.ts`
- Test: `tst/lib/wrapped/queue.test.ts`

**Interfaces:**

- Consumes: `WrappedBackfillStore` (Task 1), constants from Task 4's module are defined here to avoid a cycle: move `BACKFILL_TICK_MS`, `MEMBERS_PER_TICK` into `queue.ts` and have `backfill.ts` import them.
- Produces:

```ts
export const BACKFILL_TICK_MS = 5 * 60_000;
export const MEMBERS_PER_TICK = 4;
export const NEXT_TICK_KEY = 'wrapped-backfill-next-tick'; // ISO, written by the scheduler each tick
/** Next tick start, plus one tick per MEMBERS_PER_TICK entries ahead; pushed past 18:00–19:00 UTC. */
export function readyBy(nextTickAt: Date, position: number): Date;
export type QueueOutcome =
  | { kind: 'queued' | 'already'; year: number; readyBy: Date }
  | { kind: 'cached' };
/** Enqueue when there is no copy for the member's current Meetup id; else 'cached'. nextTick from the cache key, else now + BACKFILL_TICK_MS. */
export async function queueForLater(
  store: WrappedBackfillStore,
  cache: KeyValueCache,
  member: { discordUserId: string; meetupId: string },
  year: number,
  now: Date,
): Promise<QueueOutcome>;
export function queuedText(
  outcome: Exclude<QueueOutcome, { kind: 'cached' }>,
  format: (at: Date) => string,
): string;
// 'queued': `Queued — it'll be ready by about ${format(readyBy)}.`; 'already': `You already have ${year} queued; it'll be ready by about ${format(readyBy)}.`
export const pacificClock = (at: Date) => tz(dayjs(at)).format('h:mm a');
export const discordClock = (at: Date) =>
  `<t:${Math.floor(at.getTime() / 1000)}:t>`;
```

- [ ] **Step 1: Write the failing tests**:

```ts
it('readyBy counts one tick per four entries from the next tick', …)   // position 1..4 → nextTick; 5 → +5 min; 9 → +10 min
it('readyBy skips the quiet hour', …)   // nextTick 17:58Z, position 2 → 19:00Z (not 17:58)
it('queueForLater enqueues when nothing is cached and reports the position’s ready-by', …)
it('queueForLater reports the year already queued', …)
it('queueForLater is "cached" when a copy for the current Meetup id exists', …)   // store.enqueue not called
it('queuedText spells both outcomes', …)
```

- [ ] **Step 2: Run → FAIL.** · **Step 3: Implement** (a `FakeBackfillStore` in `tst/lib/wrapped/backfillFakes.ts` implementing `WrappedBackfillStore` in memory, reused by Task 4). · **Step 4: Run → PASS.** · **Step 5: Commit** — `"Wrapped queue: enqueue on a miss, ready-by from the tick cadence"`.

### Task 4: The backfill tick and scheduler

**Files:**

- Create: `src/lib/wrapped/backfill.ts`
- Test: `tst/lib/wrapped/backfill.test.ts` (fakes from `backfillFakes.ts`: store, cache, members, a counting `WrappedMeetup` per token/organizer)

**Interfaces:**

- Produces:

```ts
export const TICK_CALL_BUDGET = 150;
export const RUN_INTERVAL_MS = 20 * 60 * 60_000;
export const FRESH_CURRENT_YEAR_MS = 7 * 24 * 60 * 60_000;
export const QUEUE_MAX_ATTEMPTS = 3;
export const QUEUE_CLAIM_STALE_MS = 15 * 60_000;
export const RUN_NOW_KEY = 'wrapped-backfill-run-now'; // exclusive_set by Run now, removed by the tick that honours it
export interface OrganizerReads extends WrappedMeetup {
  getMemberRsvpEvents(
    memberId: string,
    groupId: string,
    filter: MemberRsvpFilter,
  ): Promise<EventSummary[] | undefined>;
}
export interface BackfillDeps {
  now(): Date;
  cache(): Promise<KeyValueCache>;
  store(): Promise<WrappedBackfillStore>;
  members(): Promise<
    Pick<MemberRepository, 'listAll' | 'findByDiscordId' | 'findByMeetupId'>
  >;
  memberToken(discordUserId: string): Promise<string | undefined>;
  memberClient(token: string): WrappedMeetup;
  /** withOrganizerMeetup with a CACHING client; fn may be re-run on a 401. */
  withOrganizer<T>(fn: (meetup: OrganizerReads) => Promise<T>): Promise<T>;
  isPresent(discordUserId: string): Promise<boolean>;
  canStart(now: Date, cache: KeyValueCache): Promise<boolean>; // !isQuietHour && !identityDigestInProgress
  alert(entry: LogEntry): Promise<boolean>;
  newLeaseValue(): string;
  groupId: string;
  log?: Pick<Logger<unknown>, 'info' | 'warn' | 'error'>;
}
export type TickOutcome =
  | { kind: 'skipped'; reason: 'quiet' | 'digest' | 'no-work' }
  | {
      kind: 'ran';
      queued: number;
      members: number;
      built: number;
      skipped: number;
      failed: number;
      calls: number;
      finishedRun: boolean;
    };
export async function runBackfillTick(deps: BackfillDeps): Promise<TickOutcome>;
export function yearsFor(events: { dateTime: string }[], now: Date): number[]; // first Pacific year (≥ FIRST_WRAPPED_YEAR) … this year, ascending
export function isFresh(
  copy: CachedWrapped | undefined,
  meetupId: string,
  year: number,
  now: Date,
): boolean;
export function startWrappedBackfillScheduler(
  client: Client,
  makeDeps: () => Promise<BackfillDeps>,
  options?: { env?; setIntervalFn?; log?; now?: () => number },
): void;
export function productionBackfillDeps(
  getClient: () => Client | undefined,
): Promise<BackfillDeps>;
```

Tick algorithm (the code the signatures do not determine):

1. `now`; `cache`; if `!canStart` → `skipped`. Call counter `calls = 0` (the counting wrapper increments on every `WrappedMeetup` method call).
2. **Drain:** `store.claimNext(MEMBERS_PER_TICK, QUEUE_CLAIM_STALE_MS)`; for each row while `members < MEMBERS_PER_TICK && calls < TICK_CALL_BUDGET`: member = `findByDiscordId`; unlinked or Meetup id ≠ row's → `complete` (drop), log info by Discord id; `isFresh(readWrapped(...))` → `complete`, skipped++; else `buildMember(member, [row.year])` → success: `complete`, built++; failure: `release(id, QUEUE_MAX_ATTEMPTS)`, failed++.
3. **Sweep:** `run = openRun()`; none → start one if `RUN_NOW_KEY` is set (remove it; trigger = its value) or the last finished run is older than `RUN_INTERVAL_MS` (or none), `membersTotal = linked.length`; else return. Linked members = `listAll()` filtered to both ids, sorted by Discord id; those `> run.cursor`. For each while caps allow and `canStart(now)`: `buildMember(member, yearsFor(history))` (skips fresh years), then `advanceRun(run.id, cursor, member.discordUserId, delta)`; if it returns false (another process moved it) stop. When the list is exhausted → `finishRun` and the summary alert: `Wrapped backfill finished: N members, built B, skipped S, failed F, took T` (`seconds`).
4. **buildMember:** token = `memberToken`; with a token: client = `memberClient`, history via `getSelfPastRsvpEvents`; mismatch or a 401 (`isMeetupUnauthorized`) anywhere → fall to the organizer path; organizer path: `acquireBuildLease(cache, lease)` (false → stop the tick: `no-work` with what was done), `withOrganizer(m => { history = m.getMemberRsvpEvents(meetupId, groupId, {rsvpStatus:['YES','ATTENDED'], eventStatus:['PAST']}); undefined → 'not-in-group' (counted as skipped); hosted = readHostedEvents(m, meetupId); years… })`, release the lease in `finally`. Per year: skip if fresh; `exclusive_set(buildingKey)` false → skip (counted skipped: an on-demand build is on it); `buildWrappedYear` → `writeWrapped`; remove the building key in `finally`. Any other error: log `error.name`, count the member failed, continue with the next member.

- [ ] **Step 1: Write the failing tests** (fake clock at 2026-12-10T20:00Z unless stated; fake members `A`,`B`,`C`… with Discord ids `100…`):

```ts
it('does nothing in the quiet hour or while the digest runs', …)
it('drains the queue before the sweep, oldest first, and writes the cache entry readWrapped serves', …)
it('drops a queued row whose copy appeared meanwhile, unbuilt', …)
it('drops a queued member who is no longer linked', …)   // Review Focus 1: findByDiscordId undefined → complete, no build, no name in the log
it('releases a failed queued build and drops it after three attempts', …)
it('starts a run when none finished in 20 hours, sweeps members in Discord-id order, at most four a tick', …)
it('builds every year from the first event (never before 2015) and skips fresh copies', …)   // Review Focus 2
it('rebuilds a current-year copy older than seven days and leaves a younger one', …)
it('stops starting builds once the call budget is spent, and resumes from the cursor next tick', …)
it('a member whose build fails is counted and retried next run (cursor moves past them)', …)
it('stops at the quiet hour and leaves the cursor behind', …)   // Review Focus 3: canStart flips false between members → tick returns, cursor = previous member, leases released
it('uses the member token when stored and the organizer reads otherwise, under the report lease', …)   // organizer path: acquireBuildLease taken/released per member; member-token path: not taken
it('falls back to the organizer path on an account mismatch or a 401', …)
it('never spends the hourly slot', …)   // limiter untouched: no claimBuild dep at all; building lease taken and released
it('honours Run now: starts a run at once and clears the flag', …)
it('finishes the run with one plain summary alert', …)
it('scheduler: ticks now and every 5 minutes, writes NEXT_TICK_KEY, skips while a tick runs, off without DATABASE_URL', …)
```

- [ ] **Step 2: Run → FAIL.** · **Step 3: Implement `backfill.ts`** (counting wrapper, tick, `productionBackfillDeps`: `PostgresWrappedBackfillRepository.instance()`, `ApplicationMemberRepository`, `getUsableMeetupTokens(await ApplicationCache(), id)?.accessToken`, `new GqlMeetupClient(token)`, `withOrganizerMeetup(client, fn, { ...defaultOrganizerMeetupDeps, makeClient: (t) => new GqlMeetupClient(t) })`, `isServerMember`, `canStart = async (now, cache) => !isQuietHour(now) && !(await identityDigestInProgress(cache, now))`, `logAlert`, `crypto.randomUUID`). · **Step 4: Run → PASS**, `yarn vitest run tst/lib/wrapped`. · **Step 5: Commit** — `"Wrapped backfill: queue drain, paced sweep, scheduler"`.

### Task 5: Queued state in the command and the page

**Files:**

- Modify: `src/lib/wrapped/handlers.ts`, `src/lib/wrapped/format.ts` (reply text), `src/web/host/wrappedPage.ts`
- Test: `tst/lib/wrapped/handlers.test.ts`, `tst/web/host/wrappedPage.test.ts`

**Interfaces:**

- `WrappedHandlerDeps.queue?: () => Promise<WrappedBackfillStore>` and `WrappedPageDeps.queue?: () => Promise<WrappedBackfillStore>` (absent → today's behaviour).
- Discord, on `rate-limited` with no cached copy and a queue: `queueForLater` → reply `replies.queued(text)` where `text = queuedText(outcome, discordClock)` (the limiter line first, then the queued line). With a cached copy: unchanged.
- Web: notice codes `queued` and `already-queued` render `queuedText(…, pacificClock)`; the ready-by time is read from the store at render (`position` + `NEXT_TICK_KEY`), never from the URL. `GET /host/wrapped` on a miss: if `queue` and `store.position(discordUserId)` exists and `limiter.retryAfterSec > 0` → the queued notice page, no build; otherwise build; after a `built` outcome, `store.complete(discordUserId)` (best effort). `POST /wrapped/rebuild` on `rate-limited` with no copy → `queueForLater` → `?notice=queued` or `already-queued`.

- [ ] **Step 1: Write the failing tests**: Discord: rate-limited + no copy → enqueued, reply contains "Queued — it'll be ready by about <t:" ; rate-limited + copy → not enqueued, old reply; no `queue` dep → old reply. Web: rebuild rate-limited + no copy → 303 `?notice=queued`, GET renders "ready by about 12:05 pm" (fixed clock) from the store; `already-queued`; a reload while queued and limited shows the notice without building; a reload with a free slot builds and drops the row; no `queue` dep → unchanged.
- [ ] **Step 2: Run → FAIL.** · **Step 3: Implement.** · **Step 4: Run → PASS** (`tst/lib/wrapped`, `tst/web/host`). · **Step 5: Commit** — `"Wrapped: queue a throttled request and say when it will be ready"`.

### Task 6: Staff card and Run now

**Files:**

- Modify: `src/lib/reports/dashboardPaths.ts` (`wrappedBackfill: '/wrapped/backfill/run'`), `src/web/routes/dashboardPages.ts` (dep + route registration), `src/web/routes/home.ts` (card after the announcement card), `src/web/dashboardDeps.ts` (wiring), `src/index.ts` (scheduler), `tst/web/routes/access.test.ts` (`'POST /wrapped/backfill/run': 303`), `tst/web/routes/pageFakes.ts`
- Create: `src/web/routes/wrappedBackfill.ts`
- Test: `tst/web/routes/wrappedBackfill.test.ts`

**Interfaces:**

```ts
export interface WrappedBackfillControl {
  status(): Promise<{ lastRun: BackfillRun | undefined; openRun: BackfillRun | undefined; queueLength: number; nextTickAt: Date | undefined }>;
  runNow(requestedBy: string): Promise<'requested' | 'already-running' | 'already-requested'>;   // exclusive_set RUN_NOW_KEY (TTL 1 h) unless a run is open
}
DashboardPageDeps.wrappedBackfill: WrappedBackfillControl;
export const WRAPPED_BACKFILL_PATH; export const BACKFILL_NOTICES = { requested: 'The Wrapped backfill will start on its next tick (within 5 minutes).', 'already-running': 'A Wrapped backfill run is already in progress.', 'already-requested': 'Run now was already pressed; the next tick starts it.', 'not-leadership': 'Only the 1.5 Leadership Team can run the Wrapped backfill.', unavailable: …, error: … }
export function wrappedBackfillCard(deps: Pick<DashboardPageDeps, 'now' | 'wrappedBackfill'>, view): Promise<SafeHtml>   // <h2>Wrapped backfill</h2>, last run line, open run "N of M members, built/skipped/failed", "Queue: N", "Next tick: h:mm a Pacific", Run now form (leadership note), ?backfill= notice
export function registerWrappedBackfillRoute(router, deps: Pick<DashboardPageDeps, 'isLeadership' | 'audit' | 'wrappedBackfill'>)   // POST → 303 /dashboard?backfill=<code>
```

- [ ] **Step 1: Write the failing tests** (pattern `wrappedAnnounce.test.ts`): card states (no run yet; open run; finished run; queue length; next tick), Run now as leadership → 303 `?backfill=requested` and `runNow` called with the user id and an audit entry; non-leadership → `not-leadership`; "Run now during a run is 'already running'" (Review Focus 5); access matrix row.
- [ ] **Step 2: Run → FAIL.** · **Step 3: Implement**, wire `dashboardDeps.ts` (`PostgresWrappedBackfillRepository.instance()`, `ApplicationCache`), `index.ts` (`startWrappedBackfillScheduler(client, () => productionBackfillDeps(() => client))`), `HomeReportsView.notice` reuse: add `backfillNotice: unknown` read from `req.query.backfill` in `dashboardRouter.ts`. · **Step 4: Run → PASS**, then `yarn test`. · **Step 5: Commit** — `"Wrapped backfill: staff card and Run now"`.

### Task 7: Integration: a tick on real Postgres and Redis

**Files:**

- Test: `tst/integration/wrappedBackfillTick.test.ts`

- [ ] **Step 1: Write the failing test**: isolated schema + real Redis; two linked members in an in-memory member repo, fake Meetup clients (member token for one, organizer for the other); enqueue one (year 2025); run `runBackfillTick` → the queued row is gone and `readWrapped(redis, id, 2025, meetupId)` is the entry; a second tick starts a run and writes both members' years; `runWrapped` (the Discord handler) then serves the entry with no Meetup call; a third tick is `no-work` (all fresh).
- [ ] **Step 2: Run → FAIL.** · **Step 3:** fix whatever the real stores reveal. · **Step 4: Run → PASS** (full integration suite). · **Step 5: Commit** — `"Wrapped backfill: integration on real Postgres and Redis"`.

### Task 8: Lint, typecheck, prettier, PR

- [ ] `yarn lint`, `yarn tsc --noEmit -p .` (node_modules noise only), `yarn prettier --check` on touched files, `yarn test`, the integration suite with the env line.
- [ ] PR "Wrapped: backfill past years for everyone, and a queue for throttled requests", base `wrapped-deeper-stats` (say so; rebase onto `main` once A merges). Body: the organizer-path evidence (`noShowReport.ts` reads `getMemberRsvpEvents` with the organizer token daily, so no probe was needed), pacing constants, the queue rules, the Redis-size question, tests run. Report URL and BASE..HEAD to the lead session.
