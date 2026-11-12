# Group snapshot for Wrapped — design

Status: drafted 2026-11-11 from IDEAS.md §10 and the lead's build brief; builder-checked and approved by the lead. The
brief was detailed enough that no interview was held; every choice it left
open is marked _my call_. Two PRs: **1 (ingest + staff visibility)** and
**2 (compute Wrapped from the snapshot)**. PR 2 is based on PR 1's branch.

## Why

The Wrapped backfill (#154) reuses the per-member on-demand build: about 18
Meetup calls per member, throttled to 4 members per 5-minute tick, so a full
sweep of ~470 linked members takes ~10 hours, and every `/wrapped` refresh
pages Meetup again. Hai: "we should have just pulled all the historic data of
our group and then done all the calculations locally."

The group's whole history is one dataset: every event and who RSVP'd. Pulled
once (~2–3k organizer calls) and kept current incrementally (tens of calls a
day), Wrapped for every member and every year becomes a local computation:
the backfill takes minutes, the December post and `/wrapped` cost zero Meetup
calls, and the dataset feeds the long-term analytics and cohort goals
(IDEAS.md §1).

## Goals

1. **Ingest** (PR 1). A job pulls the group's full event list (PAST and
   ACTIVE) and each past event's RSVPs into Postgres with the organizer
   token: a resumable full pull under a per-tick call budget, then daily
   incremental runs. Failures alert `#meetup-bot-alerts`, plain.
2. **Compute** (PR 2). `WrappedSources` and the attendee lists can come from
   the snapshot for a given Meetup member id, with no Meetup call. The
   backfill builds every linked member from the snapshot (minutes); `/wrapped`
   and `/host/wrapped` serve stored entries and rebuild from the snapshot on
   `refresh`, under the unchanged hourly limiter. The current token-based
   path stays as the fallback.
3. **Staff visibility** (PR 1). The dashboard home's Wrapped backfill card
   gains a snapshot line (age, events and RSVPs stored, last ingest result)
   and a leadership-only **Refresh snapshot now** button, mirroring Run now.

## Non-goals

- Any new member-facing stat or page. The Wrapped shape is unchanged.
- Upcoming events' RSVPs. Wrapped counts past events only; ACTIVE events are
  stored as event rows (so the list is complete and the watermark is real),
  their RSVPs are read once they are past (_my call_: upcoming RSVPs change
  hourly and nothing reads them yet).
- Analytics or cohort pages over the dataset. Later, on top of these tables.
- Replacing the event audit. The audit keeps its own snapshots and alerts;
  the ingest only reads its confirmed deletions.

## Anti-goals

- **A Meetup name or id of another person reaching a Wrapped entry, Redis, a
  page or a log line.** The snapshot holds other members' Meetup ids in
  Postgres (it has to); everything built from it keeps today's invariant:
  others appear only as linked Discord ids plus counts. The privacy tests in
  `tst/` must pass unchanged, plus new ones for the snapshot path.
- **RSVP data in Redis.** Nothing from the snapshot is written to Redis or the
  request cache; the ingest client bypasses the request cache.
- **Two jobs on the organizer credential at once.** The ingest takes the
  shared report build lease for each tick's reads, like every other
  organizer job.
- **A Wrapped built from a half-pulled snapshot.** Until the first full pull
  has finished, every build takes the token path.
- Pinging anyone. Alerts are plain; no role mentions.

## What exists today (build on it)

- `src/lib/wrapped/backfill.ts`: the tick scheduler, Postgres-recorded runs
  with a cursor, `RUN_NOW_KEY`, the per-tick call budget
  (`TICK_CALL_BUDGET = 150`), `canStart` (the report window rule plus no
  identity digest), the report build lease for organizer reads, once-a-day
  failure alert, one summary alert per run.
- `src/lib/eventAudit/*`: an hourly organizer snapshot of upcoming and
  recently-past events, `toObservation` validation (ids are digits, URLs
  match `MEETUP_EVENT_URL`, text bounded), and `event_audit_state.deleted_at`
  for deletions confirmed by a null read by id.
- `dashboardPool.ts`: `DASHBOARD_SCHEMA_SQL` under the schema advisory lock,
  idempotent `CREATE TABLE IF NOT EXISTS`, column additions guarded by a
  catalog read, `inDashboardTransaction` with lock and idle timeouts.
- `build.ts`: `WrappedSources { events, hosted }`, `buildWrappedYear(deps,
meetupId, year, sources, options)`, which reads attendee lists through
  `deps.meetup.getEventRsvps`; `computeWrapped` is pure.
- `countedEvents.ts`: the one counted-event rule (cancelled status or title,
  Open House tag for hosting). The snapshot stores raw rows; the rule is
  applied at compute time exactly as today.
- `src/web/routes/wrappedBackfill.ts`: the card and the leadership Run now
  POST (CSRF, Origin, rate limit, live role check, audit, fixed notices).

## PR 1: ingest

### Tables (in `DASHBOARD_SCHEMA_SQL`, under the schema lock)

```sql
-- The group's events as Meetup last listed them (src/lib/snapshot/ingest.ts).
-- host_ids are Meetup member ids. deleted_at is set from the event audit's
-- confirmed deletions; deleted rows are kept but never read by Wrapped.
CREATE TABLE IF NOT EXISTS meetup_events (
  event_id         TEXT PRIMARY KEY CHECK (event_id ~ '^[0-9]{1,20}$'),
  title            TEXT NOT NULL,
  date_time        TIMESTAMPTZ NOT NULL,
  event_url        TEXT,
  status           TEXT NOT NULL,
  host_ids         TEXT[] NOT NULL DEFAULT '{}',
  yes_count        INTEGER,        -- Meetup's totalCount for [YES, ATTENDED]
  waitlist_count   INTEGER,
  listed_at        TIMESTAMPTZ NOT NULL,   -- last seen in a listing
  rsvps_fetched_at TIMESTAMPTZ,            -- NULL: RSVPs never read
  deleted_at       TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS meetup_events_date_idx ON meetup_events (date_time);
CREATE INDEX IF NOT EXISTS meetup_events_hosts_idx ON meetup_events USING GIN (host_ids);
-- One row per event and member: the RSVP as of rsvps_fetched_at.
CREATE TABLE IF NOT EXISTS meetup_event_rsvps (
  event_id   TEXT NOT NULL REFERENCES meetup_events(event_id) ON DELETE CASCADE,
  member_id  TEXT NOT NULL CHECK (member_id ~ '^[0-9]{1,20}$'),
  status     TEXT NOT NULL CHECK (status IN ('YES', 'WAITLIST', 'ATTENDED')),
  fetched_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (event_id, member_id)
);
CREATE INDEX IF NOT EXISTS meetup_event_rsvps_member_idx ON meetup_event_rsvps (member_id);
-- Ingest runs, as wrapped_backfill_runs: at most one open; kind 'full' until
-- the first full pull finishes, then 'incremental'.
CREATE TABLE IF NOT EXISTS meetup_snapshot_runs (
  id             SERIAL PRIMARY KEY,
  trigger        TEXT NOT NULL CHECK (trigger = 'job' OR trigger ~ '^[0-9]{1,20}$'),
  kind           TEXT NOT NULL CHECK (kind IN ('full', 'incremental')),
  started_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at    TIMESTAMPTZ,
  listed_at      TIMESTAMPTZ,      -- when this run's listing phase finished
  events_listed  INTEGER NOT NULL DEFAULT 0,
  events_fetched INTEGER NOT NULL DEFAULT 0,
  rsvps_stored   INTEGER NOT NULL DEFAULT 0,
  failed         INTEGER NOT NULL DEFAULT 0,
  requests       INTEGER NOT NULL DEFAULT 0,
  last_error     TEXT              -- an error class name, never a message
);
CREATE UNIQUE INDEX IF NOT EXISTS meetup_snapshot_runs_open_idx
  ON meetup_snapshot_runs ((true)) WHERE finished_at IS NULL;
```

**No member names** (_my call, flagged for the lead_: the brief says "member
id + name"). Nothing in Wrapped reads a Meetup name, linked members' names
come from Discord, and every unlinked person's name stored is privacy
surface with no reader. The column can be added later, guarded by a catalog
read, when an analytics page needs it. **NO** RSVPs are not stored (the
filter asks for YES, WAITLIST and ATTENDED only).

### Sizing (Postgres essential-0: 1 GB, 20 connections)

Estimated, to be replaced by the first full run's real numbers in PR 1's
description: ~2,500 events (PAST + ACTIVE) and ~20 stored RSVPs per event ⇒
~50,000 RSVP rows. An RSVP row is ~80 bytes on disk with tuple overhead plus
~2 × 50 bytes in the two indexes ⇒ **~9 MB**; events with their indexes
**< 2 MB**. Even 5× the estimate is under 60 MB, a few percent of the plan.
Writes use the existing pool (size 3); no new connections.

### Meetup reads (organizer credential, request cache bypassed)

- **Listing**: a new query `getGroupEventsForSnapshot` (one page, the filter
  exactly as given, no month padding, never cached, logs counts only):
  `id title dateTime eventUrl status eventHosts { member { id } }`,
  `attendance: rsvps(filter: { rsvpStatus: [YES, ATTENDED] }) { totalCount }`,
  `waitlist: rsvps(filter: { rsvpStatus: [WAITLIST] }) { totalCount }`.
  Paged 100 at a time over `status: [PAST]` and then `status: [ACTIVE]`.
  Host ids only, no host names (unlike the audit node).
- **RSVPs**: a new query `getEventRsvpsForSnapshot(eventId, first, after,
filter)`: `pageInfo`, `totalCount`, `edges { node { status member { id } } }`
  with `rsvpStatus: [YES, WAITLIST, ATTENDED]`, 100 per page, every page.
  No names, no profile fields.
- Nodes are validated like `toObservation`: an id that is not digits or a
  start that does not parse drops the node (logged by count); a URL that does
  not match `MEETUP_EVENT_URL` is stored as NULL; titles bounded to
  `TITLE_MAX`; an RSVP status outside the three is dropped.

A live read-only probe is needed before PR 1 is merged, to confirm the
`WAITLIST` filter returns waitlisted members for a past event and to record
the real event count: asked of the lead session first (Heroku one-off tsx
pattern or Hai's Meetup tab), never run without its go-ahead.

### A run, in phases

A run is **due** when none is open and the last finished more than **20 h**
ago (daily), or when staff pressed Refresh snapshot now (`RUN_NOW` key, as
the backfill's). Its kind is `full` while no `full` run has ever finished,
else `incremental`.

1. **List** (one tick, ~25–30 calls): every PAST and ACTIVE page, upserting
   `meetup_events` (title, date, URL, status, hosts, counts, `listed_at`).
   Not resumed mid-listing: a listing that fails leaves the run open and the
   next tick lists again (Meetup cursors are not kept across ticks). When it
   finishes, `listed_at` is set on the run.
   _My call_: the listing is re-read in full on every run, not only "events
   after the watermark". It is ~30 calls a day and it is the only way a past
   event renamed "cancelled", re-hosted or moved is ever seen.
2. **Deletions**: event ids with `event_audit_state.deleted_at` set get
   `meetup_events.deleted_at` (one `UPDATE … FROM`), so a deleted event never
   counts. (The audit confirms deletions of upcoming events only; a past
   event cannot be deleted from Meetup's group listing in practice.)
3. **RSVPs** (many ticks on a full run): the events that need a read,
   oldest first, are
   - PAST, not deleted, `rsvps_fetched_at IS NULL` (never read: the whole
     history on a full run, newly past events after), or
   - PAST, not deleted, `date_time` within the last **14 days**
     (`RSVP_SETTLE_DAYS`, _my call_: hosts mark attendance in the days
     after), and `rsvps_fetched_at` before this run's `started_at`, or
   - PAST, `rsvps_fetched_at` earlier than `date_time` (read before it
     happened, e.g. a status flip).
     This set is computed in SQL each tick, so the phase is resumable with no
     cursor: a fetched event drops out. Each event's pages are read in full,
     then in **one transaction** its rows are replaced (delete + insert) and
     `rsvps_fetched_at` set. A failed event is counted (`failed`), logged by
     error class, skipped for this run (an in-run skip set) and retried next
     run.
     The **watermark** is the newest `date_time` whose RSVPs are stored and
     settled; it is not stored separately because the three rules above are it.
4. **Finish** when the set is empty: `finished_at`, summary log line, and an
   alert for a `full` run only (_my call_: one daily "incremental finished"
   post would be noise; failures still alert).

### Pacing and budget (_my calls_, one constants block in `ingest.ts`)

- Tick every **5 minutes** (`SNAPSHOT_TICK_MS`), the backfill's cadence, in
  its own scheduler (started beside the backfill's in `src/index.ts`).
- **150 Meetup calls per tick** (`SNAPSHOT_TICK_CALL_BUDGET`), counted by a
  wrapper around the client, checked before each event (an event in flight
  finishes its pages). One event in flight.
- The **report build lease** is held for one tick's reads (acquired at the
  start, released in `finally`); a held lease skips the tick. The backfill
  takes the same lease per organizer build, so the two never overlap on the
  credential.
- Guards: `canStartMonthBuild` (no start from 17:45 UTC until 19:00) and
  `identityDigestInProgress`, re-checked between events.
- Full pull: ~2,500 RSVP reads + ~30 listing ⇒ ~17 ticks ⇒ **~1.5 h** of
  ticks, spread over whatever the quiet hour and the lease allow. Incremental:
  ~30 listing + ~20–40 RSVP reads a day.

### Failures and alerts

- A tick that throws (credential unavailable, Postgres, a listing error)
  leaves the run open, records `last_error` (class name only), and posts a
  plain **"Group snapshot is failing"** alert at most once per UTC day (the
  backfill's `alertFailingOnce` pattern). An `OrganizerTokenUnavailableError`
  ends the tick without counting any event failed.
- An open run that has not advanced for **24 h** is reported in that same
  alert's text on the next failure; no separate watchdog (_my call_).
- A full run's finish posts one plain summary: events, RSVP rows, calls,
  failed events, duration.

### Staff visibility (Part 3, in PR 1)

On the dashboard home's **Wrapped backfill** card, one more line:

> Group snapshot: updated 3 h ago (Nov 11, 9:12 AM Pacific) · 2,481 events ·
> 51,204 RSVPs · last run: incremental, 62 calls, 0 failed.

With an open run: "refreshing: 1,204 of ~2,450 events read". Before any run:
"Group snapshot: not pulled yet." A run that last failed shows "last tick
failed (TypeError)" (the class name).

**Refresh snapshot now** (leadership only) beside Run now: same guards as
Run now (router CSRF/Origin/rate limit, live leadership check, audit post
"Group snapshot refresh requested"), sets the snapshot run-now flag; fixed
notices `snapshot-requested`, `snapshot-already-running`,
`snapshot-already-requested` (and the shared `not-leadership`,
`unavailable`, `error`). Nothing echoed.

### Testing (PR 1)

Unit (vitest, network blocked, in-memory store):

- listing upsert: node validation (bad id/date dropped, bad URL → NULL,
  bounded title), PAST then ACTIVE, the counts; a failed listing leaves the
  run open and the next tick lists again;
- the RSVP work set: never-read, within settle days and stale, read before
  the event; deleted excluded; ACTIVE excluded;
- per-tick budget stop between events; an event's pages all read; one
  failed event counted, skipped for the run, retried next run;
- full → incremental kind; daily due gate; run-now flag;
- quiet hour, identity digest and held lease defer; lease released on throw;
- alerts: failing once a day with the class name, summary on a full run
  only, no mentions;
- staff card line in each state; the Refresh POST matrix (leader, not
  leader, Discord unavailable, already running/requested).

Integration (`tst/integration`, Postgres :55432, Redis :56379): the schema
creates idempotently twice; an event's RSVP replace is one transaction
(rows replaced, `rsvps_fetched_at` set); the work-set query against real
rows; the deletion join from `event_audit_state`; no key written to Redis by
a tick other than the lease, the run-now flag and the alert guard.

## PR 2: compute Wrapped from the snapshot

### Sources from the snapshot

A `SnapshotReader` (Postgres) with, for a Meetup member id:

- `isReady()`: a `full` run has finished. False ⇒ every caller uses the
  token path.
- `hasMember(meetupId)`: any stored RSVP row or hosted event for the id.
- `sources(meetupId): WrappedSources`:
  - `events`: PAST, not deleted events where the member's RSVP is YES or
    ATTENDED (the same statuses `getSelfPastRsvpEvents` and the organizer
    history read use), as `EventSummary`-shaped rows (status included, so
    the counted-event rule sees the platform status, not only the title);
  - `hosted`: PAST, not deleted events with the id in `host_ids`, with
    `attendance` = the stored YES + ATTENDED row count (_my call_: the local
    count rather than `yes_count`, so attendance and companions agree; they
    differ only when an event's RSVPs failed to read, and then
    `yes_count` is used).
- `attendees(eventIds)`: `{ byEvent, partial }` from one
  `SELECT event_id, member_id … WHERE event_id = ANY($1) AND status IN
('YES','ATTENDED')`; `partial` is always empty (lists are complete).

`build.ts` gains an `AttendeeSource` seam: `buildWrappedYear` reads attendee
lists through `deps.attendees(events, { firstPageOnly })`, whose Meetup
implementation is today's `readAttendees` and whose snapshot implementation
is the query above. `computeWrapped`, `WrappedInput` and the cached shape do
not change, so **no cache version bump** (_my call_: the stored JSON is
identical in shape; values may differ by a late attendance mark, which is
what a rebuild is for).

A new `buildWrappedFromSnapshot(deps, linkedMeetupId, year)` composes
`sources` + `buildWrappedYear` with the snapshot attendee source. It needs no
Meetup token, so it has no account-mismatch or not-in-group outcome.

### Who uses which path

- **Snapshot path** when `isReady()` and `hasMember(linkedMeetupId)`.
- **Token path** (today's code, unchanged) otherwise: no full pull yet, or a
  member the organizer view never saw (joined after the last run, or whose
  RSVPs the organizer view can't see — the IDEAS.md caveat). A member with
  no RSVP and no hosted event in the snapshot and none on Meetup gets the
  same quiet-year Wrapped from either path.

### On-demand: `/wrapped` and `/host/wrapped`

Unchanged order: linked gate, stored entry (Redis hot copy, then Postgres),
hourly limiter, building lease. Only the build step changes: snapshot path
first, token path as fallback. Consequences:

- A snapshot build needs no stored Meetup token, so the web page's "connect
  your Meetup" page is shown only when the fallback is needed and there is no
  token.
- `refresh` rebuilds from the snapshot, so it reflects Meetup as of the last
  ingest (at most a day old, or the last Refresh snapshot now). The hourly
  limiter is unchanged (it still limits builds).
- Builds from the snapshot are fast; the 10 s DM handover and the 20 s page
  wait stay for the fallback.

### The backfill over the snapshot

- With `isReady()`, the sweep builds each linked member present in the
  snapshot from it: no Meetup call, no organizer lease, no call budget, the
  member's building lease as today. Up to **100** such members per tick
  (`SNAPSHOT_MEMBERS_PER_TICK`, _my call_) ⇒ ~470 members in ~5 ticks
  (~25 min); members missing from the snapshot keep the token path, inside
  the existing `MEMBERS_PER_TICK` and `TICK_CALL_BUDGET`.
- Freshness: a current-year copy is fresh when built after the latest
  finished snapshot run (instead of "under 7 days"), so each daily ingest
  makes the next sweep rebuild the current year once; the past-year rule
  ("built after the year ended") is unchanged.
- The per-run attendee memo remains for the token path only.
- The queue drains through the same build choice.

### Privacy (unchanged invariants, new tests)

The snapshot reader returns other people's Meetup ids only into
`computeWrapped`'s companion ranking and `rankCohort`, exactly where the
token path's attendee lists go; naming goes through `nameRanked`
(linked-and-present only). New tests: a snapshot-built entry's JSON contains
no Meetup id other than the member's own and no stored name; the privacy
tests in `tst/` run against a snapshot-backed build too.

### Testing (PR 2)

Unit: `sources` mapping (deleted and ACTIVE excluded; status carried; hosted
attendance local count, fallback to `yes_count`); path choice (not ready,
member missing → token path; ready and present → snapshot, zero Meetup
calls); the snapshot build and the token build produce equal entries on the
same fixture data; freshness against the latest snapshot run; backfill
snapshot cap and no budget use; the on-demand page and command build without
a token from the snapshot; limiter unchanged on refresh.
Integration: the reader's queries against real rows; a backfill tick over a
seeded snapshot writes the entry `readEntry` serves, with zero Meetup calls.

## Probe results (2026-11-11, read-only, organizer token, between backfill ticks)

- Events: **4,784 PAST, 101 ACTIVE, 273 CANCELLED** (≈ 5,160; twice the
  estimate above).
- RSVPs on PAST events: **56,494 YES/ATTENDED** (avg 11.8, max 192, 16 events
  over 100) and **7,942 WAITLIST** across 1,545 events ⇒ ~64k rows, **~14 MB**
  with indexes. Still ~1.5 % of essential-0.
- WAITLIST is returned on past events: WAITLIST is kept.
- Edges can be fewer than `totalCount` (one event: 46 counted, 41 returned):
  the organizer view hides a few RSVPs. The token path's attendee lists read
  the same connection, so this is not a snapshot-only gap; `yes_count` keeps
  Meetup's number beside the stored rows.
- Full pull ≈ 52 listing pages + ~4,800 event reads ≈ **4,850 calls ⇒ ~33
  ticks ≈ 2.7 h** at 150 calls a tick (one constant to raise if the lead
  wants it faster).
- Organizer-view history counts for four linked members recorded for PR 2's
  parity check (four members, by label only: 114, 13, 84 and 21 past RSVPs; the ids stay out of the public repo).

## After the lead's review of PR 1 (2026-11-11)

- **Per-event RSVP failures are persisted** (`rsvp_failures`,
  `rsvp_failed_at`, `rsvp_error` on `meetup_events`; cleared by a good read).
  An event that failed during a run stays out of that run, across restarts,
  and is read again by the next run. Three failures in a row still end the
  tick (and alert once a day) but no longer re-admit those events, so a
  poison event cannot pin the run. The card shows how many events are
  failing.
- **Short reads are refused** (`ShortRsvpReadError`, stored rows kept): no
  edges while Meetup's `totalCount` or the listing's `yes_count` is above 0,
  or fewer edges than half of `totalCount`. Not "fewer than `totalCount`":
  the probe saw 41 edges for 46 counted on a healthy event (hidden RSVPs).
- A good tick clears the run's `last_error`.

### Notes for PR 2 (reading the snapshot)

- Read events with `status = 'PAST' AND deleted_at IS NULL`. ACTIVE rows
  that vanish from a listing are never delisted (deletions of upcoming
  events come from the event audit); they never count anyway.
- RSVPs settle: an event is re-read once per run for 14 days after it
  happened, then frozen. A host marking attendance later than that is not
  seen.
- CANCELLED events have no RSVP rows (only PAST events are read).
- `SNAPSHOT_RUN_NOW_KEY` is read by the tick but nothing sets it yet: PR 2's
  Refresh snapshot now button will.

### Known limits noted by the lead (re-review of PR 1, 2026-11-11)

- A Meetup outage tick records three failures and parks three healthy events
  until the next daily run: bounded, and visible on the card.
- The card's "ShortListing" hint is cleared by the next good tick.
- `failingEventCount` can include an event that aged out of the settle
  window and is never re-read (rare).

## PR 2 as built (2026-11-12)

- `SnapshotReader` on the repository; `src/lib/snapshot/wrapped.ts` turns it
  into `WrappedSources` and an attendee reader. `build.ts` has an attendee
  seam (`SourceDeps.attendees`); snapshot and token builds produce equal
  entries on the same data (tested).
- `/wrapped` and `/host/wrapped` try the snapshot first: no token, no OAuth
  hop, the same hourly slot. The cross-check uses the member's stored token
  when there is one (`storedTokenSelfCount`, one Meetup call).
- The backfill builds snapshot members with no Meetup call, up to
  `SNAPSHOT_MEMBERS_PER_TICK = 100` a tick, and treats a current-year copy as
  fresh only when built after the latest snapshot run. No cross-check there.
- Leadership **Refresh snapshot now** sets `SNAPSHOT_RUN_NOW_KEY`.
- The `rsvp_*` columns also have a catalog-guarded `ALTER`.
- No `WRAPPED_CACHE_VERSION` bump: the stored shape is unchanged.

## Pace (Hai, 2026-11-12: 2.7 h is too slow)

Two config vars, read at boot (`snapshotTuning`), so the pace changes with a
config change and a restart, no deploy:

| Var                       | Range   | Default | Fast (first full pull) |
| ------------------------- | ------- | ------- | ---------------------- |
| `SNAPSHOT_CALLS_PER_TICK` | 1–10000 | 150     | 5000                   |
| `SNAPSHOT_CONCURRENCY`    | 1–8     | 1       | 1                      |

- **Live evidence (v335, the first ingest ticks, from the lead):** sequential
  `getEventRsvpsForSnapshot` calls run ~75–90 ms apart, so 150 calls take
  ~12 s and the tick idles ~288 s. The budget is the whole bottleneck; at
  5000 calls a tick the remaining full pull finishes in about two ticks
  (~7 min of calls). Concurrency is not needed and stays at 1.
- **Time cap:** a tick stops starting events `SNAPSHOT_TICK_MAX_MS` (4 min)
  after it began, checked at event boundaries (an event in flight finishes),
  so a slow Meetup day cannot overrun the 5-minute interval or the 30-minute
  report lease. The budget is still checked at event boundaries too.
- Concurrency (optional) applies to RSVP reads of different events only;
  listing pages stay one at a time. "Three failures in a row" counts in
  event order across batches, and any good read resets it.
- **429 (rate limited)** ends the tick like a refused token: the event is
  not marked failed, the daily "failing" alert applies, and the next tick
  carries on.
- Probe headroom (read-only, 2026-11-11): ~2.1 s per listing page of 100
  events with two aliased counts, 0.16 s for an ACTIVE page, no 429 or
  query-cost error. Meetup publishes no per-token limit for `gql-ext`.
- The staff card shows the configured pace and the last tick's calls and
  events read (`group-snapshot-last-tick` in Redis: counts only, a day's TTL).
- Unset both vars after the full pull: daily runs need ~60–100 calls. The
  quiet-hour and identity-digest guards and the report lease are unchanged.

## After the lead's review of PR 2 (2026-11-12)

### Parity (read-only probe, 2026-11-12 00:31 UTC, 8 calls, Meetup ids only)

Over the 544 PAST events the first ingest ticks had read (the oldest ones):
the 8 linked members with the most stored rows, organizer view of their own
history (`getMemberRsvpEvents`, YES/ATTENDED, PAST) restricted to those
events, against the snapshot's rows.

| Member   | org history (all) | org, in read events | snapshot | missing in snapshot | extra in snapshot |
| -------- | ----------------- | ------------------- | -------- | ------------------- | ----------------- |
| member A | 96                | 30                  | 30       | 0                   | 0                 |
| member B | 260               | 27                  | 28       | 0                   | 1                 |
| member C | 144               | 28                  | 28       | 0                   | 0                 |
| member D | 189               | 20                  | 20       | 0                   | 0                 |
| member E | 34                | 16                  | 16       | 0                   | 0                 |
| member F | 28                | 15                  | 15       | 0                   | 0                 |
| member G | 47                | 13                  | 13       | 0                   | 0                 |
| member H | 15                | 11                  | 12       | 0                   | 1                 |

- **0 of 160 linked-member RSVPs missing** from the snapshot; it even has 2
  the member-history read lacks. Across those events Meetup counts 5,505
  YES/ATTENDED and the snapshot stores 4,813 (12.6 % hidden): the hidden
  RSVPs are not these current members', so they look like departed or
  deleted accounts. Expect the cross-check fallback rate near zero.
- Caveat: these are 2014–2015 events (the pull reads oldest first); the
  check is cheap to re-run on recent events after the full pull.
- The listing dropped 21 unusable nodes (no usable id or start) of 5,137.

### Changes

- **Per-member path, per-path freshness.** The backfill asks the snapshot
  once per member. Snapshot members: a current-year copy is fresh until the
  snapshot is newer. Token members (not in the snapshot, or flagged): the
  7-day rule as before, so they are not rebuilt daily. A copy built from
  the snapshot is never fresh for a token-path member.
- **`builtFrom: 'snapshot'`** on entries built from the snapshot (additive
  JSON field, in Postgres and Redis; absent = token path; no version bump).
- **Undercount flag** (`wrapped_snapshot_flags`, Meetup id + counts): an
  on-demand cross-check that finds the token counting more than
  `SNAPSHOT_COUNT_SLACK` above the snapshot flags the member durably. From
  then on every path, the backfill included, builds them from Meetup, and
  their snapshot-built years (past ones too) are rebuilt on the token path.
- **Cross-check throttled**: only when the member's hourly slot is free
  (`limiter.isLimited`), so it costs at most one Meetup call per allowed
  build.
- **Hosted attendance** is Meetup's YES + ATTENDED total from the listing
  (`yes_count`), the number the token path reads; the stored rows only when
  the listing had no count. Companions always use the stored rows, so a
  hosted event can show more attendees than named companions plus "others"
  (the hidden RSVPs), exactly as on the token path.
- The snapshot button's refusals have their own text.
- **On-demand paths serve a stored entry without checking for a newer
  snapshot**: `/wrapped` and `/host/wrapped` rebuild only on `refresh` /
  Rebuild (under the hourly limit), and the daily backfill rebuilds the
  current year once per ingest.

## Follow-ups after PR 2 (2026-11-12)

### Parity on recent events (read-only probe, 02:47 UTC, 8 calls)

After the full pull: the 1,410 PAST events of the last 540 days, the 8
linked members (A–H) with the most stored rows there. Each member's
organizer-view history (YES/ATTENDED, PAST) restricted to those events, vs
the snapshot's rows: **998 of 998 present, 0 missing, 0 extra** (A 137, B
135, C 123, D 123, E 101, F 97, G 93, H 89). Meetup counts 17,481 RSVPs on
those events and the snapshot stores 16,265 (7 % hidden, none of them these
members'). With the old-event probe: 0 of 1,158 linked-member RSVPs missing.

### Changes

- **Snapshot members first.** Live (run 3), once the sweep reached members
  not in the snapshot, each tick built 4 token-path members (2 calls each:
  history and hosted, years already fresh) and stopped at the 5th, leaving
  the snapshot members behind them waiting (13–35 a tick instead of 100).
  The room accounting was right (4 members a tick); the order was the
  problem. Now, with a snapshot, the sweep's single id-ordered pass builds
  snapshot members (up to 100) and moves the cursor past a token-path member
  who needs a build, recording them in `wrapped_backfill_deferred`; every
  tick then drains deferred members with the token room left. The run
  finishes when the pass is done and nothing is deferred. Without a
  snapshot, the pass is as before.
- **A snapshot read error ends the tick** (the backfill reads the snapshot
  strictly), instead of sending a snapshot member down the token path to
  overwrite their entries. On-demand builds still fall back.
- **Events whose attendees left Meetup**: a read that is short again in a
  later run (the event's last error was the short read) is accepted as
  final: the rows Meetup shows are stored, the failure cleared, and
  `rsvps_hidden` set. The card counts them separately ("N events have RSVPs
  Meetup no longer shows").
- **The undercount flag clears** when a later on-demand cross-check agrees
  (the snapshot caught up); the backfill never clears it (no cross-check).
- **Rate limits**: one rate-limited tick records `RateLimited` and alerts
  nobody; a second in a row (the run's last error still `RateLimited`) gets
  the daily "failing" alert. A failed tick now writes the card's last-tick
  line too, with its error.

## Left to the builder

- File layout (suggested: `src/lib/snapshot/{ingest,job,reader}.ts`,
  `src/lib/repositories/postgresSnapshotRepository.ts`, the two queries in
  `queries.ts` and methods on `GqlMeetupClient`).
- Exact copy of the card line, notices and alerts.

## Decisions after the builder check (2026-11-11)

A fresh reader planned from the draft above and asked five questions. Three
are _my calls_; two went to the lead (below).

1. **Partial organizer visibility** (_my call_). `hasMember` alone could hide
   an undercount if Meetup shows organizers only some of a member's RSVPs.
   On-demand builds (`/wrapped`, `/host/wrapped`) that have the member's
   usable token make one cheap cross-check, `getSelfPastRsvpCount`, against
   the snapshot's count of that member's YES/ATTENDED past rows; Meetup
   higher than local by more than `SNAPSHOT_COUNT_SLACK = 2` (events newer
   than the last ingest) ⇒ token path, logged by Meetup id. The backfill
   does not cross-check (it would cost a call per member); a member it
   undercounts is corrected on their next on-demand build. The live probe
   also compares the two counts for a handful of linked members.
2. **Events that leave the listing** (_my call_). After a listing phase that
   completed, PAST events not seen in it (`listed_at` before the phase's
   start) get `deleted_at`, but only when the listing returned at least
   **95 %** of the previously stored non-deleted PAST events; otherwise
   nothing is marked and the run's `last_error` says `ShortListing`. The
   listing reads `status: [PAST, CANCELLED]` so a cancelled-after-the-fact
   event is stored with its status (the counted-event rule then drops it,
   as the token path does by title and status).
3. **WAITLIST** (_my call_). Stored if the probe shows the filter returns
   waitlisted members on past events; if it does not, WAITLIST is dropped
   from the filter, the CHECK and `waitlist_count`. Either way the probe
   does not block anything Wrapped needs.

### Answered by the lead (2026-11-11)

4. **Names**: ids only, as proposed. No name column; added later behind a
   catalog-guarded `ALTER` if an analytics page needs one.
5. **Retention**: RSVP history is kept indefinitely; unlinking or a deletion
   request does not purge snapshot rows (they are the organizer's view of the
   group, like the report snapshots). Revisit with the analytics work.
