# Staff Dashboard — Design

**Date:** 2026-10-15
**Status:** Approved (Hai, 2026-10-15)

## Problem

The bot's reports are slash commands that hand one person a `.txt`, `.csv` or
`.html` file. That works for a single run, but:

- **Effort.** Mods run commands, download files, and copy results into
  spreadsheets and Notion by hand. Stacey wants to run no-shows weekly.
- **No history.** Each run shows one month. Nobody can see trends: no-shows
  per month, hosting over time, how many members have linked Meetup.
- **No shared state.** Who was warned, who is on hold and why, and who was
  suspended live in a spreadsheet and in people's heads. The no-show →
  warning → suspension workflow is spread over a report, a CSV round trip, and
  manual Meetup messages.

Goal: one staff website, hosted by the bot, where mods and the leadership team
browse every report, see trends, and work the monthly no-show list together.

## Decisions (from brainstorming, 2026-10-14/15)

| Topic | Decision |
|---|---|
| Purpose | Ease for staff, trends over time, shared workspace. Not member-facing (yet). |
| Access | Discord members with the **Moderator** or **1.5 Leadership Team** role. Event Organizers are excluded, matching the moderation commands. |
| Scope of v1 | Every report as a read-only page; **only the no-show workspace is editable.** |
| Hosting | Inside the existing bot (Express on Heroku), server-rendered pages. No separate app. |
| Report data | A scheduled job builds each month's reports with the shared organizer Meetup credential and saves them. |
| Live Meetup details | Event descriptions etc. are fetched live with the organizer credential and only cached in Redis (~12 h); never stored in Postgres. No second (Meetup) login. |
| Backfill | All time: every month since the group's first event. |
| Messaging members | Meetup's API has no messaging mutation (checked 2026-10-15: 16 mutations, none sends a message). The workspace gives **Copy warning / Open on Meetup / Mark as sent** buttons; a person sends the message from the shared organizer account. No browser automation. |
| Holds | A workspace row can be put **on hold**, and every row has a free-text **Notes** field. |
| Notifications | Build results and the "reports ready" notice go to #meetup-bot-alerts as plain embeds. Nothing pings: staff have notifications on for the channel (Hai, 2026-10-16). |
| Templates | Drafted below, signed "1.5 Gen Asians Organizers", linking the public policy and appeal form. Suspended members lose their existing RSVPs. |
| Commands | All existing slash commands keep working. |

## Architecture

```
Discord login ──► Express (src/app.ts) ──► dashboard routes (src/web/)
                                              │
                         ┌────────────────────┼──────────────────────┐
                         ▼                    ▼                      ▼
                 report services       workspace service       existing repos
              (src/lib/reports/)     (no-show actions)     (suspensions, identity,
                         │                    │              member links)
                         ▼                    ▼
                 report_snapshots      noshow_workspace_rows
                     (Postgres)          + _events (Postgres)
                         ▲
        scheduled build job (in-process timer) + one-off backfill script
                         │
                 Meetup GraphQL (organizer credential)
```

### Units

1. **Report services** (`src/lib/reports/`). Pure functions that build a
   month's Hall of Fame and no-show results from Meetup data, extracted from
   `getEventStats.ts` and `noShowReport.ts`. No Discord types. The slash
   commands and the dashboard both call them, so their output can't drift.
2. **Snapshot repository.** Saves and reads built reports
   (`report_snapshots`).
3. **Build job.** Builds finished months on a schedule, saves snapshots,
   reports to Discord. Also used by the backfill script.
4. **Workspace service.** The no-show workflow: statuses, notes, holds,
   template rendering, recording suspensions. Uses the existing suspension
   repository for suspensions.
5. **Web layer** (`src/web/`). Discord OAuth login, session, role gate,
   CSRF, and page handlers. Pages are server-rendered templates with a small
   amount of client JavaScript (charts, copy-to-clipboard).

Each unit is testable alone: report services with fixture Meetup data,
repositories against a throwaway Postgres, the web layer with a faked session
and services.

## Sign-in and access

- **Discord OAuth2** (`identify` scope only) on the bot's existing Discord
  application. Hai adds one redirect URI in the Discord developer portal
  (`https://meetup-discord-bot.herokuapp.com/dashboard/auth/callback`).
- After login the bot fetches the user's guild member record with the bot
  token and admits them only if they hold **Moderator** or
  **1.5 Leadership Team**. The role check result is cached in the session for
  10 minutes; after that it is re-checked, so losing a role locks someone out
  within 10 minutes.
- Session: signed, `HttpOnly`, `Secure`, `SameSite=Lax` cookie; server-side
  session state in Redis (already available); 12-hour lifetime.
- Every state-changing request needs a CSRF token. Pages send
  `Cache-Control: no-store`. Login and actions are rate-limited.
- Errors render a generic page; details go to logs only.

## Data

### `report_snapshots`

One row per report type, month and build.

| Column | Notes |
|---|---|
| `id` | serial |
| `report_type` | `hall_of_fame` or `no_show` |
| `period` | first day of the month (Pacific) |
| `built_at`, `built_by` | `built_by` = `job`, `backfill`, or a Discord user id for manual refresh |
| `source_complete` | true when the build read Meetup completely. Attendance is never inferred (ruling 2026-10-16: the organizer account sees NO_SHOW RSVPs, Meetup returns no ATTENDED for this group), so every build so far stores true; a finished month with RSVPs but zero no-shows is stored complete and its build alert adds "check that attendance was taken" |
| `payload` | JSONB, the report service's result |
| `superseded_by` | id of a newer build of the same month, or null |

Rebuilding a month inserts a new row and points the old one at it, so history
someone already acted on is kept.

### Workspace tables

`noshow_workspace_rows`: one row per member per report month.

| Column | Notes |
|---|---|
| `period`, `meetup_member_id` | unique together |
| `classification` | `warning` or `suspension` (from the snapshot) |
| `status` | `new`, `warning_copied`, `warning_sent`, `on_hold`, `suspended`, `skipped`, `voided` |
| `notes` | free text, shown on the row and carried into the suspension record |
| `suspension_record_id` | link to `suspension_records` once suspended |
| `version` | integer for optimistic locking |
| `updated_at`, `updated_by` | Discord user id |

`noshow_workspace_events`: append-only history of every change (who, when,
old → new status, note text). This is the audit trail; it is never edited.

### Existing data, read in place

- Suspension records (`suspension_records`), identity changes and thumbnails
  (`member_identity*`), and Meetup link records are read directly.
- **Link progress** needs one new small table, `link_progress_daily`
  (`day`, `linked`, `unlinked`, `reverify_tagged`, `onboarding`), written once
  a day by the build job. History starts the day it ships.

### What is never stored

Event descriptions, tokens, and anything from DMs are not written to
Postgres. Descriptions are fetched live and cached in Redis for at most 12
hours. (Meetup's API exposes no DMs anyway.)

## Pages

All pages are read-only except the workspace.

1. **Home.** Latest month at a glance: no-show counts and open workspace
   items, events and hosts, identity changes in the last 7 days, link
   progress. Links to every page.
2. **No-show workspace** (editable, see below). One month at a time; month
   picker.
3. **No-show history.** Per month: warnings, suspension candidates, outcomes
   from the workspace. Per member: every no-show and every action.
4. **Suspension records.** Active and past, with void reasons; same data as
   `/meetup_list_suspensions`.
5. **Hall of Fame / hosting.** Per month: hosts and counts, new hosts, the
   browsable grouped list. Copy-ready text for posting.
6. **Identity changes.** Filter by date, platform, member. Before/after
   thumbnails served one image per request from Postgres.
7. **Link progress.** Linked vs unlinked over time, Reverify and Onboarding
   counts.
8. **Trends.** Charts: no-shows per month, suspensions per month, events and
   distinct hosts per month, new hosts per month, link progress.

Lists are paginated (50 rows). Member names link to their Meetup profile
(`https://www.meetup.com/members/<digits>/`) and, when linked, their Discord
profile (`https://discord.com/users/<digits>`). All member-supplied text is
HTML-escaped, wrapped in `<bdi>`.

## No-show workspace

The workspace covers every month from 2026-09 onward, the open (current)
month included, so the list can be worked weekly. Older months stay
read-only history. For the selected month, one card per member from the
no-show snapshot:

- Classification, counted no-shows (since the later of 12 months ago and the
  last suspension), prior suspensions, recommended length and fee.
- Upcoming RSVPs, earliest first, with 💵 marks (fee on Meetup or payment in
  the description, fetched live), and the act-by date.
- Status, notes, history.

Actions:

| Action | Effect |
|---|---|
| **Copy warning** | Renders the warning for this member and copies it. Status → `warning_copied`. |
| **Copy suspension message** | Renders the suspension message and copies it. Changes no status and writes nothing. A suspended card's message is built from its linked record alone (its date and length, the fee from the live records before it), never from the report's no-shows, and it never shows a warning box, even after a rebuild reclassifies or drops it. A voided card shows no message. |
| **Open on Meetup** | Opens the member's Meetup profile in a new tab; the sender uses Message there while signed in as the organizer account. |
| **Mark as sent** | Status → `warning_sent`. Records who and when. |
| **Put on hold** | Status → `on_hold`; a note is required (e.g. "paid for Halloween, revisit after 3rd no-show"). |
| **Record suspension** | 1.5 Leadership Team only. Confirm step with the suspension date (default today; from the month's first day through today, Pacific). The length and fee are computed by the policy from the member's suspensions dated before the chosen day, and the page reloads them when the date changes. Writes a `suspension_records` row with the command's SQL, carrying the notes; status → `suspended`. Refused if the range overlaps a live suspension of the member (an override may come later). |
| **Link suspension** | 1.5 Leadership Team only. Links a live suspension recorded outside the workspace (e.g. with `/meetup_record_suspension`) dated in the month (its 1st through its last day); status → `suspended`; a record another row already links is never offered. |
| **Skip** | Status → `skipped`; note required. |
| **Void** | 1.5 Leadership Team only. For a recorded suspension: reason required; uses the command's void SQL. |
| **Notes** | Edit at any time. |

Recording, linking and voiding suspensions are for the 1.5 Leadership Team
only (Hai, 2026-10-16 and 2026-10-17). The role is checked live against
Discord at the moment of the action; if Discord cannot be reached the action
is refused and nothing changes. The month page shows those controls from a
60-second cache of that answer, for display only. Moderators see the
workspace and do everything else.

Every action writes a `noshow_workspace_events` row and logs to the staff
moderation channel (`MODERATION_LOG_CHANNEL_ID`) with who did it, as the
commands do, with no pings. Concurrent edits: each action sends the row's
`version`; a stale version is refused with "someone just updated this,
reload".

The CSV export stays available for anyone who prefers the old flow; the CSV
upload command keeps working.

## Message templates

Rendered per member. `{fee}` and `{suspension_days}` come from prior
suspensions: 30 days and $10 the first time, doubling each time
(60/$20, 120/$40, ...). For event hosts the policy waives the fee, so their
messages leave the fee sentence out (see below); "host" means the member has
hosted at least one PAST event in the group. `{policy_link}` and
`{appeal_link}` are configuration values.

**Warning (1 no-show)**

> Hello {first_name}, our records show you RSVP'd to {event_title} on
> {event_date} but were marked as a no-show. Cancellations within 48 hours
> also count as no-shows, so please update your RSVP at least 2 days ahead if
> your plans change. This is a friendly warning: a second no-show results in a
> {suspension_days}-day suspension from the group and a ${fee} admin fee to
> rejoin, which you can donate to any Asian charity of your choice (or pay to
> 1.5 Gen Asians). Our Attendance & No-Show Policy: {policy_link}. If you think
> this was a mistake, you can appeal here: {appeal_link}. Thank you!
> 1.5 Gen Asians Organizers

**Suspension (2+ no-shows)**

> Hello {first_name}, our records show {no_show_count} no-shows:
> {no_show_list}
>
> Under our Attendance & No-Show Policy ({policy_link}), you are being
> suspended from the group for {suspension_days} days. Your current RSVPs will
> be removed. After {end_date}, you can reapply to join on Meetup. Rejoining
> requires a ${fee} admin fee, which you can donate to any Asian charity of
> your choice (or pay to 1.5 Gen Asians). If you think this was a mistake, you
> can appeal here: {appeal_link}. Thank you for understanding.
> 1.5 Gen Asians Organizers

`{no_show_list}` is one line per counted no-show: title and Pacific date.
`{end_date}` is the last suspended day (the suspension date plus
`{suspension_days}`, minus one). When the host waiver applies, the fee is
left out: the warning's penalty clause ends at "…a {suspension_days}-day
suspension from the group.", and the suspension message drops the
"Rejoining requires…" sentence.

## Build job and notifications

- **Schedule.** Runs in-process on the existing 15-minute tick pattern with a
  Redis lease (30 minutes). From 16:00 UTC it builds the current month daily,
  rebuilds the previous month daily on the 2nd–7th (with catch-up if those
  days were missed), and writes `link_progress_daily`. No month build starts
  between 17:45 and 19:00 UTC, and the link-progress member pass runs only in
  hours 16 and 19–23 UTC, so neither overlaps the 17:00 unlinked digest or the
  18:00 identity sweep.
- **Manual refresh.** "Refresh from Meetup" on the workspace and report pages
  queues a rebuild of that month (one at a time; refused while one is
  running). At most 4 manual rebuilds per UTC hour across all staff and
  months; the job's own builds do not count.
- **Alerts.** Each build posts to #meetup-bot-alerts: reports and month
  built, duration, failures with the error. A failed build retries on the next
  tick and stays flagged until it succeeds. Credential failures surface the
  same way as for the identity sweep.
- **Report ready.** When a finished month's reports are first built, the bot
  syncs that month's workspace, then posts a plain alert in #meetup-bot-alerts
  (`BOT_ALERTS_CHANNEL_ID`) with `allowedMentions: { parse: [] }`, linking
  the month's workspace, Hall of Fame and no-show history. It is delivered at
  least once: a crashed claim is reclaimed after 30 minutes and a failed post
  is retried on the next tick, after checking the channel for it.

## Backfill

A one-off script (`scripts/backfillReports.ts`), run as a Heroku one-off dyno,
builds every month from the group's first event to last month. It is
resumable (skips months that already have a snapshot unless `--force`),
rate-limited, logs progress to #meetup-bot-alerts every 12 months processed,
and refuses to start during 17:45–19:00 UTC (the unlinked digest and the
identity sweep). Months with zero no-shows are saved as complete, like the
daily job's builds; attendance is never inferred from ATTENDED RSVPs.

## Failure handling

- **Meetup down or slow.** Pages render from snapshots. Live extras (💵
  marks, descriptions, refresh) show "Meetup unavailable, try again later".
- **Postgres down.** Error page; nothing partial is written (each action is
  one transaction: row update + event row).
- **Discord API down at login.** Login fails with a retry message; existing
  sessions keep working until their role re-check is due.
- **Memory.** 512 MB dyno with R14 history: everything paginated, thumbnails
  streamed one per request, no whole-month HTML assembled in memory, backfill
  in a separate dyno.

## Testing

- Report services: unit tests with recorded Meetup fixtures; the existing
  command tests keep passing on top of the extracted functions.
- Repositories: integration tests against throwaway Postgres containers
  (never the dev stack on 5432).
- Workspace: every status transition, required notes, optimistic-lock
  conflict, suspension recording parity with `/meetup_record_suspension`,
  moderation log entries, template rendering (fee doubling, host waiver,
  escaping).
- Web: per route, signed-out → login redirect, wrong role → 403, allowed → 200;
  CSRF rejection; role re-check expiry.
- Manual: Hai and Stacey walk through one month end to end before launch.

## Rollout

Four PRs, each reviewed before merge, none merged 18:00–19:00 UTC:

1. **Sign-in and shell.** OAuth, session, role gate, CSRF, empty home page.
2. **Snapshots and job.** Report service extraction, `report_snapshots`,
   build job, alerts, report-ready notice, `link_progress_daily`.
3. **Read-only pages and trends**, then run the backfill.
4. **No-show workspace.** Statuses, notes, holds, templates, the three
   message buttons, suspension recording, moderation logging.

## Open items

- **Public links.** `policy_link` and `appeal_link` need public URLs members
  can open (the wiki links shared are workspace links). The appeal form is
  `https://forms.gle/tPiPYQ2DpAVZPL1T9`.
- **12-month window.** The bot counts no-shows from the last 12 months and
  since the last suspension; the public policy page does not mention a
  window. Either the policy page gains a line or the templates say it.
- ~~**Notify channel.**~~ Resolved: #meetup-bot-alerts.
- **Host waiver.** The policy waives the fee for event hosts but doesn't
  define "host". This spec assumes at least one past hosted event in the
  group; confirm or set a threshold.
- **Template review.** Melissa and Stacey read the templates before launch.

## Out of scope

- Member-facing pages, the public community site.
- Sending messages to members automatically (no Meetup API; no browser
  automation).
- Editing anything other than the no-show workspace.
- A second login provider.
