# Audit trail for Meetup event changes — design

Status: Hai's brief 2026-11-10, written up from the brief (the questions were
skipped: the brief is detailed and Hai is not in the session; every call below
that is not from the brief is marked _my call_). Builds on the report build
job (`2026-09-24-monthly-reports-automation-design.md`) and the staff
dashboard (`2026-10-15-staff-dashboard-design.md`).

## Why

Hosts sometimes DELETE an event when they mean to cancel it. Members who
RSVP'd get no cancellation and keep a calendar entry for an event that no
longer exists, and leadership cannot tell who deleted what. We want a record
of every status change, host change and RSVP movement on upcoming events, and
a place to see it.

## Goals

1. **A snapshot of every upcoming event, on a schedule**, read with the
   organizer credential: id, title, status, start, duration, venue id, hosts,
   RSVP yes count, waitlist count, RSVPs-closed flag, photo id. Kept as the
   latest per event plus the full history for about six months.
2. **A change row for every change that matters**: created, cancelled,
   deleted, host changed, start moved, title changed, RSVP drop (25 % or 5
   people), RSVPs closed. Each row keeps the previous and new value, the
   hosts at the time (the "likely actor": Meetup's API does not say who
   edited an event) and the last-known RSVP count.
3. **A deletion is never a guess.** An event is recorded as deleted only when
   it was upcoming, its start is still in the future, it is missing from the
   listing, and a direct read of that event by id says Meetup has no such
   event.
4. **Alerts leadership reads**: a plain post to #meetup-bot-alerts for every
   deleted and cancelled event and for every host change, naming the event,
   its hosts, its start and the RSVP count at the last snapshot. Nothing for
   RSVP movement, title or start changes, or new events.
5. **A place to see it**: a staff dashboard page "Event changes", reverse
   chronological with filters, linking to the Meetup event, and a per-event
   history page. A "Snapshot now" button for the impatient.
6. **A hook for the host dashboard**: a repository read
   `recentChangesForHost(meetupId)` so a later PR can show a host "your
   event X was deleted on … with N RSVPs". No host UI in this PR.

## Non-goals

- Who made the change. Meetup's GraphQL API does not expose an editor or a
  last-edited time on events (checked against the queries this repo already
  uses; nothing in the schema the repo knows names one). The columns exist
  (`actor`, `last_edited_at`) and stay null; the hosts at the time are
  recorded as the likely actors.
- Restoring or re-creating a deleted event, or messaging the RSVPs.
- Description, venue address, fee or photo content. Only the venue id and
  photo id are kept, so a description edit is never stored.
- Draft and proposed events: only published (ACTIVE) upcoming events and the
  last two days of PAST events are listed.

## Anti-goals

- A false "deleted" from a Meetup outage, a pagination stall or a filter
  quirk. Every vanished event is confirmed one by one; an outage during the
  confirmation records nothing and the next run tries again.
- An alert storm. One outage, one bulk change or one misbehaving run must
  not post dozens of alerts: alerts are rate-limited per event and per kind,
  and a run with more alertable changes than a cap posts one summary instead.
- A role ping or raw Meetup text in Discord (issue #112). Alerts are embeds
  with `allowedMentions: { parse: [] }`; titles and names go through
  `alertText`; errors are described by class name or HTTP status only.
- Draining the organizer token. The snapshot shares the report build lease
  (the token's critical section) and backs off when the token is unavailable.
  One listing read per run plus at most a handful of confirmation reads.

## What exists (build on it)

- `src/lib/reports/buildJob.ts`: the 15-minute tick, the Redis lease
  (`acquireBuildLease` / `releaseBuildLease`), the quiet hour and identity
  digest guards, `requestRebuild` as the manual-trigger pattern, alert
  bookkeeping and `describeBuildError`.
- `withOrganizerMeetup` (`src/lib/reports/organizerMeetup.ts`): the
  organizer credential with one refresh-and-retry on 401;
  `OrganizerTokenUnavailableError` when there is no usable token.
- `GqlMeetupClient.getGroupEvents` and `getPaginatedData`: the listing with
  pagination caps and stall detection. The listing query is widened for this
  job (below).
- The repository style of `postgresPromotedHostRepository.ts`: idempotent
  `*_SCHEMA_SQL`, `ensure*Schema` under `(DASHBOARD_LOCK_CLASS,
SCHEMA_LOCK_KEY)`, `instance()` with retry on a failed ensure, an
  append-only history trigger.
- The page kit (`src/web/pageKit.ts`, `links.ts`, `html.ts`), the identity
  changes page (`src/web/routes/identity.ts`) as the model for a filtered
  reverse-chronological list with a `before` cursor, and `PAGE_SIZE = 50`.
- `logAlert` (`src/lib/helpers/discordLogger.ts`): the plain alert, embed only,
  `allowedMentions: { parse: [] }`; `src/lib` must not import `src/web`.
- `acquireBuildLease` / `releaseBuildLease` / `identityDigestInProgress` in
  `src/lib/reports/buildLease.ts`.
- `MEETUP_EVENT_URL` in `src/lib/hosts/hostEvents.ts` (module-private today;
  moved to `src/lib/eventAudit/meetup.ts` and re-exported from there).

## The Meetup read

Two queries are added to `queries.ts`, both returning the same event shape
(`AuditEventNode`):

```graphql
id title status dateTime duration eventUrl
going waiting
rsvpSettings { rsvpsClosed }
venue { id }
featuredEventPhoto { id }
eventHosts { member { id name } }
```

- `getGroupEventsForAudit($urlname, $first, $after, $filter)`: the group's
  events with that node, paged with `getPaginatedData`. Called twice per run:
  `status: ['ACTIVE']` (upcoming, every page) and `status: ['PAST'],
afterDateTime: now − 2 days, beforeDateTime: now` (the recent past, so an
  event whose start passed between runs is seen leaving the upcoming list for
  the right reason). A new `GqlMeetupClient.getGroupEventsForAudit` sends the
  filter as given (no one-month padding, no cache: `bypassCache` is already
  how the organizer client is made).
- `getEventForAudit($eventId)`: one event with the same node, or `null`
  when Meetup has no such event. Used only to confirm a vanished event.
  **Not found** is: a 200 answer whose `data.event` is `null`, with or
  without GraphQL `errors` alongside (graphql-request throws the latter as a
  `ClientError`; its `response.status` is 200 and `response.data.event` is
  `null`). Anything else (a 4xx/5xx, a network error, a 200 with no `data`)
  is an outage: it throws, and the event is left alone this run. _My call_:
  the repo has never seen a live deleted-event answer; `getEventForCopy`
  documents `undefined when Meetup has no such event`. The PR asks for one
  live check after deploy (delete a test event, watch the next run).

`going`, `waiting` and `rsvpSettings.rsvpsClosed` are the fields Meetup's
current schema documents for an event's RSVP counts and open state; the
other fields are already used by this repo. They cannot be verified from
this session (tests block the network, no credential here), and one unknown
field would fail the whole listing. So the reader has a **fallback**: when
the full query is refused as invalid (a `ClientError` with HTTP 400, or
HTTP 200 whose `errors` mention `Cannot query field`), the run retries at
once with `getGroupEventsForAuditCore` / `getEventForAuditCore`, the same
node without `going`, `waiting` and `rsvpSettings` and with the proven
`rsvps { yesCount }` for the yes count; `waitlist` and `rsvpsClosed` are
then null. The fallback is remembered for the process (no second 400 per
run) and alerted once a day: "Event snapshots are running without waitlist
and RSVP-open data; the Meetup query needs a fix." Snapshots and deletion
detection therefore never depend on the unverified fields. _My call_.

### Mapping to an observation

Each node becomes an `EventObservation`, or is dropped with one process log
line (never Discord) when it fails validation:

| field          | from                       | rule                                            |
| -------------- | -------------------------- | ----------------------------------------------- |
| `eventId`      | `id`                       | `^[0-9]{1,20}$`, else dropped                   |
| `title`        | `title`                    | string, trimmed, cut to 300 chars; `''` allowed |
| `status`       | `status`                   | one of `EventStatus`, else `'UNKNOWN'`          |
| `startAt`      | `dateTime`                 | parses as a date, else dropped                  |
| `duration`     | `duration`                 | `^P[0-9A-Z.]{1,30}$` (ISO 8601) or null         |
| `eventUrl`     | `eventUrl`                 | the host dashboard's `MEETUP_EVENT_URL` or null |
| `venueId`      | `venue.id`                 | `^[0-9]{1,20}$` or null                         |
| `photoId`      | `featuredEventPhoto.id`    | `^[0-9]{1,20}$` or null                         |
| `hosts`        | `eventHosts[].member`      | `{ id, name }`, id all digits, name cut to 100  |
| `rsvpYes`      | `going`                    | non-negative integer or null                    |
| `waitlist`     | `waiting`                  | non-negative integer or null                    |
| `rsvpsClosed`  | `rsvpSettings.rsvpsClosed` | boolean or null                                 |
| `lastEditedAt` | —                          | always null in v1 (not exposed)                 |

## Schema

Idempotent, in `EVENT_AUDIT_SCHEMA_SQL`, under the dashboard schema lock,
in `src/lib/repositories/postgresEventAuditRepository.ts`:

```sql
CREATE TABLE IF NOT EXISTS event_audit_runs (
  id            BIGSERIAL PRIMARY KEY,
  started_at    TIMESTAMPTZ NOT NULL,
  finished_at   TIMESTAMPTZ,
  requested_by  TEXT NOT NULL CHECK (requested_by = 'job' OR requested_by ~ '^[0-9]{17,20}$'),
  listed        INTEGER,            -- events in the listing
  confirmed     INTEGER,            -- getEvent reads made
  changes       INTEGER,
  outcome       TEXT CHECK (outcome IN ('saved', 'failed'))
);
CREATE TABLE IF NOT EXISTS event_snapshots (
  id               BIGSERIAL PRIMARY KEY,
  run_id           BIGINT NOT NULL REFERENCES event_audit_runs(id),
  meetup_event_id  TEXT NOT NULL CHECK (meetup_event_id ~ '^[0-9]{1,20}$'),
  taken_at         TIMESTAMPTZ NOT NULL,
  title            TEXT NOT NULL CHECK (length(title) <= 300),
  status           TEXT NOT NULL CHECK (length(status) <= 32),
  start_at         TIMESTAMPTZ NOT NULL,
  duration         TEXT CHECK (duration IS NULL OR duration ~ '^P[0-9A-Z.]{1,30}$'),
  event_url        TEXT CHECK (event_url IS NULL OR length(event_url) <= 200),
  venue_id         TEXT CHECK (venue_id IS NULL OR venue_id ~ '^[0-9]{1,20}$'),
  photo_id         TEXT CHECK (photo_id IS NULL OR photo_id ~ '^[0-9]{1,20}$'),
  hosts            JSONB NOT NULL,     -- [{ "id": "…", "name": "…" }]
  rsvp_yes         INTEGER CHECK (rsvp_yes IS NULL OR rsvp_yes >= 0),
  waitlist         INTEGER CHECK (waitlist IS NULL OR waitlist >= 0),
  rsvps_closed     BOOLEAN,
  last_edited_at   TIMESTAMPTZ,
  UNIQUE (meetup_event_id, run_id)
);
CREATE INDEX IF NOT EXISTS event_snapshots_event_taken_idx
  ON event_snapshots (meetup_event_id, taken_at DESC);
CREATE INDEX IF NOT EXISTS event_snapshots_taken_idx ON event_snapshots (taken_at);
-- One row per event ever seen: its latest snapshot and whether it is gone.
CREATE TABLE IF NOT EXISTS event_audit_state (
  meetup_event_id     TEXT PRIMARY KEY CHECK (meetup_event_id ~ '^[0-9]{1,20}$'),
  latest_snapshot_id  BIGINT NOT NULL REFERENCES event_snapshots(id),
  first_seen_at       TIMESTAMPTZ NOT NULL,
  last_seen_at        TIMESTAMPTZ NOT NULL,
  deleted_at          TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS event_changes (
  id               BIGSERIAL PRIMARY KEY,
  run_id           BIGINT NOT NULL REFERENCES event_audit_runs(id),
  meetup_event_id  TEXT NOT NULL CHECK (meetup_event_id ~ '^[0-9]{1,20}$'),
  detected_at      TIMESTAMPTZ NOT NULL,
  kind             TEXT NOT NULL CHECK (kind IN ('created','cancelled','deleted','host_changed',
                                                 'start_moved','title_changed','rsvp_drop','rsvps_closed')),
  old_value        JSONB,
  new_value        JSONB,
  -- The event as last seen, so a row stands on its own on the page and in the alert.
  title            TEXT NOT NULL CHECK (length(title) <= 300),
  start_at         TIMESTAMPTZ NOT NULL,
  event_url        TEXT CHECK (event_url IS NULL OR length(event_url) <= 200),
  -- Hosts at the time, the likely actors. For host_changed: the union of the
  -- old and new hosts (both may have acted; the host hook must find a host
  -- who was removed). old_value / new_value keep the two lists apart.
  hosts            JSONB NOT NULL,
  rsvp_yes         INTEGER CHECK (rsvp_yes IS NULL OR rsvp_yes >= 0),
  waitlist         INTEGER CHECK (waitlist IS NULL OR waitlist >= 0),
  actor            TEXT CHECK (actor IS NULL OR actor ~ '^[0-9]{1,20}$'),  -- never set in v1
  alerted_at       TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS event_changes_detected_idx ON event_changes (detected_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS event_changes_event_idx ON event_changes (meetup_event_id, id DESC);
CREATE INDEX IF NOT EXISTS event_changes_hosts_idx ON event_changes USING GIN (hosts jsonb_path_ops);
```

`event_changes` and `event_snapshots` are append-only (the
`promoted_host_events` trigger pattern), except `event_changes.alerted_at`,
which the alert step sets once, and the retention delete. _My call_: the
trigger refuses UPDATE of any column but `alerted_at`, and refuses DELETE
unless the row is older than the retention period, so the audit cannot be
edited by a bug.

`old_value` / `new_value` per kind:

| kind            | old                            | new                         |
| --------------- | ------------------------------ | --------------------------- |
| `created`       | null                           | `{ title, startAt, hosts }` |
| `cancelled`     | `{ status }`                   | `{ status }`                |
| `deleted`       | `{ status, startAt, rsvpYes }` | null                        |
| `host_changed`  | `{ hosts }`                    | `{ hosts }`                 |
| `start_moved`   | `{ startAt }`                  | `{ startAt }`               |
| `title_changed` | `{ title }`                    | `{ title }`                 |
| `rsvp_drop`     | `{ rsvpYes, waitlist }`        | `{ rsvpYes, waitlist }`     |
| `rsvps_closed`  | `{ rsvpsClosed: false }`       | `{ rsvpsClosed: true }`     |

### Retention

At the end of each saved run, in bounded statements (at most 5000 rows
each): snapshots older than 180 days that are not an event's
`latest_snapshot_id`, then changes older than 180 days, then state rows
whose latest snapshot is older than 180 days (with that last snapshot). _My
call_: changes share the six-month retention; the brief gives it for
snapshots only, and an audit page that goes back further than its evidence
would be odd.

## The run

`runEventAudit(deps, requestedBy)` in `src/lib/eventAudit/run.ts`, under
the lease (below). Read-only against Meetup until every Meetup read is done
(so `withOrganizerMeetup` may re-run it on a 401), then one Postgres
transaction, then alerts.

1. **List**: upcoming (ACTIVE) and the last two days of PAST, mapped to
   observations, de-duplicated by event id (upcoming wins).
2. **Load state**: every `event_audit_state` row with `deleted_at IS NULL`,
   with its latest snapshot.
3. **Vanished**: state rows not in the listing whose latest snapshot has a
   start in the future (by the run's clock) and a non-past, non-cancelled
   status. Each is read by id with `getEventForAudit`, oldest start first,
   at most `CONFIRM_CAP = 25` per run (_my call_: a listing outage that
   drops everything then costs 25 reads, not hundreds, and the rest wait for
   the next run). The answer decides:
   - `null` → `deleted`: a `deleted` change, `deleted_at` set, no snapshot.
   - a node → it is still there (cancelled, filtered out, or a listing gap):
     treated as listed, so it is snapshotted and diffed like any other. A
     cancelled event is found this way, since Meetup's ACTIVE filter leaves
     cancelled events out.
   - a thrown error (outage, 5xx) → nothing recorded for that event; the
     run continues and the event is tried again next run. The run outcome
     is still `saved`.
4. **Diff** (`diffEvent(previous, next)` in `diff.ts`, pure): with no
   previous snapshot → `created`, unless this is the **first run ever**
   (no state rows at all), which writes snapshots only, as the baseline
   (_my call_: otherwise the first run posts every event as new). Otherwise
   each rule in the table above, in that order; one observation can yield
   several changes (a host change and a start move at once). The RSVP
   rule: `prev.rsvpYes − next.rsvpYes ≥ 5` or `≥ 25 % of prev.rsvpYes`
   (with `prev.rsvpYes ≥ 1`), consecutive snapshots only. A status
   becoming one of `CANCELLED`, `CANCELLED_PERM`, `AUTOSCHED_CANCELLED` from
   anything else is `cancelled`; a cancelled event is not "deleted" when it
   later vanishes, and nothing further is recorded for it.
5. **Write**: in one transaction: the run row, every snapshot, the state
   upserts, every change. A failure rolls everything back; the run row is
   then written alone as `failed` (best effort) and the failure is alerted
   once a day (`describeBuildError`).
6. **Alert** (after commit): for every `deleted`, `cancelled` and
   `host_changed` change with `alerted_at IS NULL`, in order, if the Redis
   key `event-audit-alerted-<eventId>-<kind>` can be set (TTL 6 h), post
   the alert and set `alerted_at`. A failed post leaves the row for the next
   run and removes the key. If one run has more than `ALERT_CAP = 10`
   alertable changes, one summary alert is posted instead ("N events were
   deleted, cancelled or changed hosts in one pass; see the Event changes
   page") and every row is marked alerted (_my call_).
7. **Prune** (retention), then finish the run row (`saved`, counts, duration
   logged).

### Alert text

Embed, no content, `allowedMentions: { parse: [] }` (what `logAlert` does):

```
Event deleted: <alertText(title)>
Hosts: <alertText(name)> (id), …
Start: Nov 20, 2026 7:00 PM
RSVPs at the last snapshot: 23 going, 2 on the waitlist
Likely actor: one of the hosts above; Meetup does not say who.
History: <origin>/dashboard/events/<id>
```

`Event cancelled: …` and `Event hosts changed: …` (with "Hosts before: … /
Hosts now: …") follow the same shape. The Meetup link is included only for
cancelled and host-changed events (a deleted event's page is gone) and only
when the stored URL matched `MEETUP_EVENT_URL`.

## Scheduling

`src/lib/eventAudit/job.ts`, `startEventAuditScheduler(client)` from
`index.ts` next to the report build scheduler:

- A tick every 15 minutes (the build job's `BUILD_TICK_MS`; one tick runs
  at a time in the process, as there). A tick does nothing in the quiet
  hour, while the identity digest runs, or when the build lease is held
  (`acquireBuildLease` refused: a report build or manual refresh is using
  the organizer token). Unlike the build job it has no 16:00 UTC floor: it
  runs around the clock.
- **Due**: no run row at all, or the latest `saved` run started 55 or more
  minutes ago (hourly; Postgres is the durable fact, as `loadBuiltAt` is
  for the build). A failed run backs the job off for 30 minutes (Redis key).
  _My call_ on cadence, from the brief's "hourly if cheap": one run is one
  or two listing pages plus the recent PAST page and the odd confirmation,
  a few seconds; the run row's `listed`, `confirmed` and the logged
  duration are the measurement the brief asks for, and the PR reports the
  numbers from the integration fixtures.
- The lease is the **build lease**: the snapshot and a report build never
  overlap, and neither does a manual refresh. A run that cannot get the
  lease is skipped, not queued.
- `OrganizerTokenUnavailableError` is a failed run with no alert of its own
  (`getOrganizerAccessToken` already alerts once per episode); the backoff
  applies.
- **Snapshot now**: `requestEventAudit(deps, requestedBy)` mirrors
  `requestRebuild`: a Discord id requester, the quiet hour and digest checks,
  the lease, a 2-minute cooldown key (`event-audit-cooldown`), then the run
  in the background with `done`. Codes: `started`, `quiet-hour`,
  `identity-sweep`, `busy`, `cooldown`, `bad-requester`, plus the route's
  `error` and `unavailable`, each with fixed text.

## The pages

Same gate as every staff page (the dashboard router's role check), on
`DASHBOARD_PATHS`:

- `eventChanges: '/events'` (GET): "Event changes". Filters: kind
  (select, all or one), host (Meetup id, digits), from/to (Pacific calendar
  days), `before` cursor (change id). Columns: Detected (Pacific), Change,
  Event (title linked to Meetup when the URL passed `safeHref`, else plain,
  with "History" linking to the event page), Start, Hosts (names linked to
  Meetup profiles by id; "Only this host" filter link), Details (old → new,
  fixed wording per kind), RSVPs (last known going / waitlist). 50 per page,
  "Older" link. A "Snapshot now" form (POST, CSRF, the router's unsafe-method
  guard) at the top with the last run's time and outcome, and the
  `?result=` notice in fixed text.
- `eventHistory: '/events/:eventId'` (GET): one event: its latest snapshot
  as a card (title, status, start, hosts, RSVPs, Meetup link, "deleted on …"
  when gone), its change rows newest first, and its snapshot rows newest
  first (at most 200). An unknown id is 404.
- `eventSnapshot: '/events/snapshot'` (POST): Snapshot now; redirects to the
  list with `?result=<code>`.
- Nav item "Event changes" after "Identity changes".

Every value rendered is escaped (`memberText` for titles and names); links
only through `safeHref`, `meetupProfileUrl` and `localUrl`. Reads go through
`load` with the page deadline; failures are the 503 page.

## The host dashboard hook

`PostgresEventAuditRepository.recentChangesForHost(meetupId, { limit = 20,
since? })`: change rows whose `hosts` (old or current) include the member
(`hosts @> '[{"id":"…"}]'`, the GIN index), newest first. Returned as
`EventChange` rows; nothing in `src/web/host` changes.

## Tests

- Unit (`tst/lib/eventAudit/`): `diff.test.ts` on fixtures for every kind,
  the RSVP thresholds (4 of 20 no; 5 of 100 yes; 3 of 10 yes; 0→0 no),
  several changes at once, cancelled-then-vanished, first-run baseline;
  `run.test.ts` with fake Meetup and store: deleted vs still-there vs
  outage, the confirmation cap, the alert cap and per-event rate limit, a
  failed write records a failed run and alerts once; `job.test.ts`: due
  rule, lease refused, quiet hour, backoff, `requestEventAudit` codes;
  `meetup.test.ts`: node mapping and validation; `alerts.test.ts`: no raw
  text, `alertText` applied, no mentions (the no-pings scan covers the file).
- Integration (`tst/integration/postgresEventAuditRepository.test.ts`):
  schema twice, a run round-trip (snapshots, state, changes), the
  append-only trigger, retention, `recentChangesForHost`, the list filters
  and cursor.
- Routes (`tst/web/routes/eventChanges.test.ts`): the list with filters and
  escaping of a hostile title and host name, the history page, 404, the
  Snapshot-now codes, the access matrix picks the routes up by construction,
  the responsive test's table list gains the page.
- Lint, `tsc`, prettier clean. Screenshots at 360 and 1280 px, light and
  dark, under `docs/superpowers/screenshots/event-changes/`, noted in the PR.

## Left to the builder

- Exact fixed texts of the result notices and the Details column.
- Whether the run's two listing reads share one `withOrganizerMeetup` call
  (they should: one token read, one 401 retry for the whole run).
- The shape of the in-memory fakes for the unit tests.
