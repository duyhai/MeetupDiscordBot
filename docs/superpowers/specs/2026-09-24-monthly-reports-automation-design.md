# Monthly Reports Automation — Design

**Date:** 2026-09-24
**Status:** Approved

## Problem

Two monthly moderator processes are slow and error-prone because the bot's
reports are raw data dumps that require manual post-processing:

**No Show reports** — `/meetup_get_noshow_event_stats` lists the month's
no-shows, but the moderator must then check each member's 12-month history by
hand on their Meetup profile, decide warning vs suspension, look up prior
suspensions in a spreadsheet to compute the doubled penalty, and check upcoming
RSVPs to pick a suspension date. Melissa executes warnings/suspensions.

**Hall of Fame** — `/meetup_get_host_event_stats` includes cancelled events
(the raw totals must be corrected by hand against the Meetup calendar), the
output needs reformatting through ChatGPT before posting, and new hosts are
found by comparing host IDs against a hand-maintained master list. Recurring
events share a title, which reads as "duplicates" in the raw list.

Goal: the bot computes everything computable; humans keep only the judgment
and outreach steps (Melissa still sends warnings and executes suspensions).

## Policy encoded

- 1 no-show in the trailing 12 months → warning.
- 2+ no-shows in the trailing 12 months → suspension candidate.
- **The 12 months are measured back from today** — the day the report runs —
  not from the report month.
- **Only no-shows after the member's most recent suspension count.** The
  no-shows that led to a suspension never count toward the next one; without
  this, they stay inside the 12-month window and suspend the member again,
  at double the length, for the same no-shows. So the counting window starts
  at whichever is later: 12 months ago, or the member's last suspension date.
- Suspension length: 30 days × 2^(prior suspension count). Prior suspensions
  are not derivable from Meetup, so they are stored (see `suspension_records`).
- **Prior suspensions count forever** — they never stop doubling the next
  penalty. "Prior" means dated before the suspension being recorded, so a
  back-dated entry is not doubled by a later suspension already on file.
- Suspensions should land 3–5 days before the member's next RSVP'd event; the
  report prints the next event date and a recommended act-by date.

_Policy decisions confirmed 2026-09-27: window from today, reset after a
suspension, prior suspensions never expire, unknown member IDs skipped (revised 2026-09-26: recorded and flagged; CSV is the only input)._

## Phase 1 — Hall of Fame accuracy and ready-to-post output

Changes to `meetup_get_host_event_stats` in
`src/commands/meetup/getEventStats.ts`:

1. **Cancelled-event filtering.** The existing query already excludes
   platform-cancelled events (it filters to `PAST`/`ACTIVE`/`AUTOSCHED`, and
   the live schema has distinct `CANCELLED`/`CANCELLED_PERM`/
   `AUTOSCHED_CANCELLED` statuses), so the inflated counts come from events
   that were *renamed* "cancelled" instead of being cancelled on the platform.
   Fix: skip events whose title matches `/cancell?ed/i` (case-insensitive), in
   the same way `[Open House]` events are skipped today, and defensively skip
   any cancelled `status` that slips through. The reported totals then need no
   manual correction.
2. **Recurring-event grouping.** In the formatted output, group each host's
   events by title: a title occurring N times renders as one line —
   `Title ×N` followed by the dates. Every occurrence still counts toward the
   host's total and the group total; nothing is dropped.
3. **Defensive host dedupe.** Dedupe each event's `eventHosts` by
   `member.id` before tallying, guarding against the API listing a member
   twice for one event.
4. **Ready-to-post output.** Alongside the existing detailed attachment, emit
   a second block that is the finished Hall of Fame post: ranked hosts,
   collapsed recurring events, and host/event totals computed from the same
   data (so quoted numbers can never disagree). This replaces the ChatGPT
   formatting step.

## Phase 2 — New-host detection (stateless)

No stored host list. During the same command run:

1. For each distinct host in the report month, issue one lightweight
   "has hosted before" check:
   `groupByUrlname.events(first: 1, filter: { hostId, beforeDateTime: <month start>, status: [PAST] })`
   and read `totalCount`. Introspection of the live schema (2026-09-25)
   confirms `GroupEventFilter` accepts `hostId`, `beforeDateTime`, and
   `status`. These checks run in parallel; ~20–40 tiny requests per monthly
   run. Restricting to `PAST` means someone whose only prior event was
   cancelled still counts as new.
2. Any host whose prior count is 0 is flagged 🆕 in the ready-to-post output.
3. Each new host's co-hosts (from the events they hosted this month) are
   listed next to the flag, so the "ask the co-host whether they can host
   solo" step is a one-line read.

Self-correcting and backfill-free.

**Fallback:** introspection proves the filter fields exist, not that the
resolver honors the combination. The implementation verifies the `hostId` +
`beforeDateTime` combination against the live API first; if it does not
filter correctly, fall back to one paginated full-history `getGroupEvents`
scan collecting `eventHosts` into a "has hosted before" set (host data rides
along on event pages, so this costs ceil(events / 100) requests with no
per-event sub-queries). Querying another member's hosting history directly is
not an option: there is no `member(id)` root query.

## Phase 3 — No Show report command and suspension history

### New command: `/meetup_run_noshow_report year month`

1. Pull the report month's NO_SHOW RSVPs (existing logic from
   `meetup_get_noshow_event_stats`).
2. Scan the trailing 12 months of events once, fetch NO_SHOW RSVPs per event
   (reusing the existing parallel fetch pattern), and tally per flagged
   member. This replaces the per-member profile checks.
3. Classify each flagged member per the policy above.
4. For suspension candidates: look up prior suspensions in
   `suspension_records`, compute the recommended penalty
   (30 days × 2^(prior count)), fetch the member's upcoming YES RSVPs, and
   compute the act-by date: next event date minus 3 days (the latest date the
   suspension should be applied; the 3–5 day window guidance is printed
   alongside it).
5. Output one report grouped **Warnings** / **Suspension candidates**. Each
   row: member link + ID, 12-month no-show count with the events, prior
   suspension count, recommended penalty, next RSVP'd event, act-by date.
   Delivered as a private attachment like the existing commands; the moderator
   hands it to Melissa.

Warnings are not logged: the classification is purely count-based and
recomputed from Meetup each run.

### Storage: `suspension_records`

New Postgres table alongside the existing repositories
(`src/lib/repositories/`), following the current repository pattern:

- `member_id` (Meetup member ID), `member_name`, `suspended_at`,
  `duration_days`, `notes`, `created_at`.

**Recording:** new command `/meetup_record_suspension`, replacing the
spreadsheet going forward. Its one input is a CSV attachment
(`ApplicationCommandOptionType.Attachment`; the bot fetches the attachment
URL and parses it) with rows of
`member_id, member_name, duration_days, suspended_at, notes`.

- **Monthly:** the No Show report emits a suggested-suspensions CSV in this
  format with recommended durations pre-filled. The moderator deletes the
  rows Melissa didn't act on, sets each `suspended_at` to the date she
  actually suspended, and uploads it.
- **Rows are recorded as written.** A row whose duration isn't
  30 days × 2^(prior suspensions dated before it) is still recorded, but
  flagged in the summary so a mistake — or a stale suggestion, if records
  changed since the report ran — is caught immediately. Exceptions stay
  possible.
- **Re-uploading is safe.** The dates are in the file, so a retried upload
  reports its rows as already on file rather than recording (and doubling)
  them again.

_An earlier design also had a bulk-IDs mode with auto-computed durations;
it was dropped (2026-09-26) because the report's CSV covers that case._

**Backfill:** the CSV mode doubles as the one-time import — export the
existing spreadsheet to the same column format and upload it. No separate
backfill script.

## Error handling

- Meetup API failures surface through the existing `discordCommandWrapper`
  error path; partial results are not posted.
- A member with upcoming RSVPs already inside the 3–5 day window is flagged
  "act now" rather than given a past act-by date.
- A member ID that is not a current member of the group is **still
  recorded**, and listed in the summary as "not a current member". Backfill
  legitimately contains members who have since left, and their suspensions
  must keep counting if they rejoin; the flag is how a mistyped ID gets
  caught. The membership lookup must not degrade silently: if it fails or
  Meetup authorization isn't completed, nothing is recorded (otherwise every
  row would be flagged).

## Testing

- Unit tests for the pure logic (cancelled filtering, recurring-event
  grouping, host dedupe, 12-month tally, classification, penalty doubling,
  act-by date) with mocked Meetup responses, matching existing test patterns.
- Repository tests for `suspension_records` following the existing Postgres
  repository tests.
- Manual validation: run each phase against a recent past month and compare
  with the moderator's last hand-built reports.

## Out of scope

- Sending warnings or executing suspensions (Melissa does this by preference).
- Co-host outreach (human step; the report only surfaces who to ask).
- Any Notion/spreadsheet sync beyond the one-time CSV backfill.
