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
- Suspension length: 30 days × 2^(prior suspension count). Prior suspensions
  are not derivable from Meetup, so they are stored (see `suspension_records`).
- Suspensions should land 3–5 days before the member's next RSVP'd event; the
  report prints the next event date and a recommended act-by date.

## Phase 1 — Hall of Fame accuracy and ready-to-post output

Changes to `meetup_get_host_event_stats` in
`src/commands/meetup/getEventStats.ts`:

1. **Cancelled-event filtering.** Skip events whose `status` is a cancelled
   state or whose title matches `/cancell?ed/i` (case-insensitive), in the same
   way `[Open House]` events are skipped today. `status` is already fetched by
   `getGroupEvents`. The reported totals then need no manual correction.
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

1. Run one additional paginated `getGroupEvents` scan of the group's past
   events **before** the report month and collect every `eventHosts` member ID
   into a "has hosted before" set. Cancelled events are excluded here too, so
   someone whose only prior "event" was cancelled still counts as new.
2. Any host in the report month absent from that set is flagged 🆕 in the
   ready-to-post output.
3. Each new host's co-hosts (from the events they hosted this month) are
   listed next to the flag, so the "ask the co-host whether they can host
   solo" step is a one-line read.

Self-correcting and backfill-free; the cost is one extra full-history query
per monthly run.

**Why a full-group scan rather than per-host history:** Meetup's GraphQL only
exposes hosted-event history on `self` (`memberEvents(isHosting: true)`), so
the bot cannot query an arbitrary member's hosting history. The group scan is
also cheap: `eventHosts` is returned on each event page (no per-event
sub-requests, unlike RSVP fetches), so the whole history costs
ceil(events / 100) sequential requests once a month.

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

**Recording:** new command `/meetup_record_suspension` with two input modes,
replacing the spreadsheet going forward:

- **Bulk IDs (common case):** a comma-separated `members` option plus an
  optional date (default today). Duration is auto-deduced per member as
  30 days × 2^(prior suspension count). The reply echoes each member's
  computed duration and prior count so mistakes are caught immediately.
- **CSV attachment (exceptions, notes, and backfill):** rows of
  `member_id, duration_days, suspended_at, notes` for cases with non-standard
  durations or annotations.

**Backfill:** the CSV mode doubles as the one-time import — export the
existing spreadsheet to the same column format and upload it. No separate
backfill script.

## Error handling

- Meetup API failures surface through the existing `discordCommandWrapper`
  error path; partial results are not posted.
- A member with upcoming RSVPs already inside the 3–5 day window is flagged
  "act now" rather than given a past act-by date.
- Unknown member ID passed to `/meetup_record_suspension` is rejected with a
  clear message before inserting.

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
