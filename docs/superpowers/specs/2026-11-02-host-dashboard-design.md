# Host dashboard — design

Status: brainstormed with Hai 2026-10-26 → 2026-11-02. Builder-checked.

## Why

Hosts plan and run events today through a mix of Discord commands, Meetup's
own UI, and asking organizers for help. The pain points Hai named:

- **Picking a day is guesswork.** A host can't easily see what's already on
  the calendar in the coming weeks, which days are crowded or quiet, or where
  the holidays fall.
- **Hosts can't see their own pattern.** There's no view of how often and
  what kinds of events someone has hosted, so nobody notices "three board-game
  nights in a row, maybe mix it up".
- **Announcing needs an organizer.** Hosts ask organizers to send Meetup's
  announcement email for their event. Only organizers can.
- **The create flow doesn't fit repeat events.** `/meetup_request_event` only
  takes a date and a title; the approved event gets the generic template.
  Hosts often want an exact copy of an event they ran before. Even organizers
  work around the flow: they file a fake request and approve it themselves,
  or copy the template event by hand on Meetup.
- **Comments are scattered** across each event page.
- **There's no step between Guest Host and organizer.** Experienced,
  trustworthy hosts still go through approval for every event.

The staff dashboard (`2026-10-15-staff-dashboard-design.md`) gave leadership
one place to work. This gives hosts one too, and adds the leadership-side
pieces hosts feed into.

## Goals

1. Hosts sign in with **Discord or Meetup** and land on a host home page.
2. A **calendar** of the coming weeks: all group events, busy/quiet days,
   holidays, so the host can pick a day.
3. A **hosting history heat map** (GitHub-contribution style) for the host,
   filterable by event type.
4. **Create an event**, either fresh or as an **exact copy of one of the
   host's past events**.
5. **Two host tiers:**
   - **Regular host** — the request goes into an **approval queue on the
     leadership dashboard**. Approval publishes it with the `[Guest Host]`
     tag, as today.
   - **Promoted host** — publishes directly, no approval, titled
     **`[Community Host] `** instead of `[Guest Host] ` (Hai, 2026-11-02, "for now";
     chosen over Star/Resident/Homegrown because it says "one of us" without
     implying leadership or diminishing guest hosts). Keep the prefix in one
     constant so it's a one-line change. Not to be confused with the
     Community Ambassador role. Leadership is still notified. Promoted hosts are *not* Meetup
     organizers and don't represent the group.
6. **Host-triggered announcement**: a button that sends Meetup's announcement
   email for the host's own event. Not automatic; the host chooses when.
7. **All comments on the host's events in one place.**
8. **No-show marking**: for each past event, a link straight to Meetup's
   attendance page for that event. The no-show report keeps reading Meetup's
   marks as it does today.
9. Leadership side:
   - **Approval queue.**
   - **Promotion candidates list**: regular hosts with **20+ counted hosted
     events in the last 18 months** who have been group members for a year
     or more; organizers are left out (leadership, 2026-11-10). Leadership
     decides; the list is there to look at.
   - **Promote / demote**, with a recorded reason, who did it, and when.
   - **Flagged comments**: comments on hosts' events that read like
     complaints are flagged (by Hai's scheduled task, see below). Flagged ones
     are shown first; "show all" expands to every comment.
   - **Per-host heat map** (same component as the host's own).

## Non-goals

- Making anyone a Meetup organizer, or changing anyone's Meetup group role.
  `updateGroupMembershipRole` exists in the API; this project never calls it.
- Automatic announcements on publish (Hai: announcing stays a deliberate act).
- Writing attendance or no-shows to Meetup. The API has no mutation for it
  (checked 2026-10-31: the only RSVP mutations are open/close RSVPs).
- Storing host-marked no-shows in our own database (Hai chose the Meetup link
  over that, 2026-10-31).
- Per-event ratings and reviews from the API. The API only exposes
  group-wide totals (`GroupStatsEventRatings`: average, totalRatings,
  totalReviews), with no per-event data and no review text.
- Replacing the Discord `/meetup_request_event` command. It keeps working.
- Members who aren't hosts. Non-hosts are refused, as non-staff are on the
  staff dashboard.

## Anti-goals (would make this a failure even if it works)

- A promoted host's event that looks like it came from the group's
  organizers. They don't represent the group.
- A host being able to act on someone else's event (announce, copy into
  their name, read private comments on events they don't host).
- The announce button sending more than once for an event because of a
  double-click or retry. Members get the email; a duplicate is noisy and
  can't be taken back. (Hai, 2026-11-10: Meetup refuses a second
  announcement itself, so it is the backstop; the dashboard records each
  event's status and keeps quick double-clicks to one call.)
- Approval racing: two leaders approving the same request and creating two
  events (the Discord flow already guards this with a lock; keep that
  guarantee).
- Role pings in `#meetup-bot-alerts`. Staff have channel notifications on;
  post plain alerts only.

## Later, separate piece: Hai's scheduled review task

Meetup reviews aren't in the API, so a **scheduled Claude task run from Hai's
side** reads them on Meetup's site and records anything worrying against the
host. The same task does the complaint flagging of comments (see Comments).
Hai: not scalable, but fine at our size. The task itself is out of scope for
this build; this build only gives it a way in: the host's "issues" list
accepts entries from any source, and there's a write path for flags.

## What exists today (build on it)

- **Staff dashboard** at `/dashboard` (`src/web/*`): Discord OAuth, stateless
  HMAC'd OAuth cookie, session revocation, `SafeUrl`/`SafeHtml` guards,
  strict nonce CSP, HSTS, rate limiting, Two-Tone design (blurple = action,
  coral = attention, green = done), page kit, charts.
- **Event creation** (`src/commands/meetup/createEvent.ts`):
  `/meetup_request_event` posts a request message with Approve/Deny buttons.
  Approve (the clicker's own Meetup membership must be `LEADER`, under a
  Redis lock keyed on the message) uses **the clicker's own Meetup token**
  (`withMeetupClient`, token stored in Redis by Discord id) and creates the event from `createEventTemplate` with
  `GUEST_HOST_EVENT_DESCRIPTION`, title prefixed `[Guest Host] `, start 19:00,
  `eventHosts: [host]`, then closes RSVPs and re-applies `rsvpSettings`
  (closing wipes them). `createEventWithPhotoFallback` retries once without
  the featured photo on a photo error only.
- **`/meetup_announce_event`** (`src/contextMenu/meetup/announceEvent.ts`)
  calls `announceEvent`, also with the invoker's own token.
- **Organizer credential** (`getOrganizerAccessToken`): one stored Meetup
  organizer token, advisory-locked refresh, account check against
  `MEETUP_ORGANIZER_MEMBER_ID`. Today it is used **only for reads** (identity
  sweep, reports). This project makes it the writer for every dashboard
  Meetup action (*my call*: promoted hosts and host-triggered announcements
  have no organizer clicking, so nothing else can do the write; approvals
  use it too so there's one path). **Verify first** that its OAuth grant
  allows `createEvent`, `editEvent`, `closeEventRsvps` and `announceEvent`;
  if it doesn't, stop and bring it back. The Discord commands keep using the
  clicker's own token, unchanged. Hosts never get organizer rights.
- **Identity links**: Discord ↔ Meetup member links in Postgres; Meetup
  OAuth connect flow (`/connect/meetup/callback`).
- **Guest Host role** is granted by `getUserRoles` to anyone with a past
  hosted event, except `GUEST_HOST_BLACKLIST`.
- **Meetup API capabilities confirmed** (introspection, 2026-10-30/31):
  `Event.comments(first, after, sortOrder)` with replies, member, created,
  `isPrivate`; `announceEvent(input: {eventId})`; `createEvent`, `editEvent`,
  `publishEventDraft`, `deleteEvent`.

## Users and tiers

| Who | How we know | Can |
|---|---|---|
| Regular host | Guest Host role in Discord, or ≥1 past hosted event on Meetup, and not blacklisted | Everything on the host side; creating an event files a request |
| Promoted host | Row in the new `promoted_hosts` table (active) | Same, but create publishes directly, titled `[Community Host] ` |
| Leadership | **1.5 Leadership Team** role (1347289004932075521) only, checked live like the no-show workspace's record/void | Approve/deny, promote/demote. Moderators keep read access to these pages through the staff-dashboard gate but can't act |

A leader who is also a host sees both sides.

*Builder's call:* whether "promoted" is also mirrored as a Discord role. The
source of truth is the table either way.

## Sign-in

- **Discord**: reuse the staff dashboard's Discord OAuth.
- **Meetup**: a new Meetup OAuth sign-in on the same app. It resolves the
  Meetup member to a host through the identity links, or directly by Meetup
  member id if they haven't linked Discord.
- Either path ends in the same session shape: one person, their Meetup member
  id, their tier.
- Same session rules as the staff dashboard: revocation, CSRF on every state
  change, `no-store`, rate limits. The tier is re-checked on the same
  10-minute cadence, so a demotion takes effect within 10 minutes.
- Meetup sign-in uses the member's token only to learn who they are. Every
  Meetup action is done with the organizer credential.
- *My call, Meetup-only sign-in:* allowed (Hai: "log in from either"). A
  Meetup member with no linked Discord is eligible if they have ≥1 past hosted
  event on Meetup. The blacklist gains a Meetup-member-id list alongside the
  Discord one, checked on both paths. Sessions are keyed by Meetup member id
  (dashboard sessions are keyed by Discord id today, so the host session
  store and revocation need that key). The host home nudges unlinked hosts to
  link Discord, without requiring it.

## Host pages

Both sites (host and staff) have an Auto / Light / Dark theme toggle in the
header: Auto follows the device's setting; a choice is kept in that browser.

1. **Home**: upcoming events they host (with status: pending approval,
   published, announced), recent comments, quick actions.
2. **Calendar**: group events a month at a time (this month to a year
   ahead), a busy/quiet shading per day, and US holidays (plus whatever
   cultural dates leadership wants to add; *builder's call* on the source,
   a static list is fine to start). Each day opens a popover listing all
   its events; a + on each day the form accepts opens the create form.
3. **History**: heat map of hosted events by day, a calendar year at a time,
   filterable by event type, with the list of past events below it; a day
   on the map filters the list to that day.
   - *Builder's call:* what "event type" is. Meetup has no reliable type
     field, so start with a small fixed set of types assigned by keyword
     from the title, plus manual correction by the host or leadership.
4. **Create**: a fresh event or "copy" from a past event. The host picks the
   date on the calendar.
   - *My call, fresh event:* the host fills in title, description, start
     time, duration, RSVP limit and guest limit; the description starts
     pre-filled with `GUEST_HOST_EVENT_DESCRIPTION` for both tiers, and
     regular hosts' get the Host Tip in front as today.
   - *My call, copy:* keeps the title (minus any `[Guest Host] ` prefix),
     description as written, duration, start time, RSVP settings and
     featured photo; no tip is added (it's already in there or the host
     removed it). Venue is copied only if the API supports setting it:
     `CreateEventInput` has no venue field today, so check `createEvent`'s
     input type; if it can't, the host is told to set the venue on Meetup.
   - Approval publishes exactly what the host submitted. *My call:*
     leadership can't edit a request; they approve, or deny with a reason
     and the host resubmits.
5. **Comments**: every comment and reply on the host's events, newest first,
   grouped by event.
6. **Per-event actions**: announce (once), view on Meetup, and for past
   events "take attendance on Meetup".

## Creating and publishing

- **Regular host**: the request is stored (new `event_requests` table) and
  appears in the leadership approval queue. Approve creates the event the
  same way the Discord approve does today: organizer credential,
  `[Guest Host]` prefix, `eventHosts: [host]`, RSVPs closed and settings
  re-applied, photo fallback, a lock per request. Deny records the reason and
  shows it to the host.
- **Promoted host**: publish runs the same create path with the
  `[Community Host] ` prefix instead, immediately. A plain alert goes to `#meetup-bot-alerts` (no pings).
- The Discord `/meetup_request_event` flow keeps working. *Builder's call:*
  whether its requests also show in the dashboard queue.
- Create is idempotent per request: a retry after a partial failure must not
  create a second event. Reuse the existing failure messages' approach
  (say what was created and what to fix by hand).

## Announcing

- A button per upcoming event, visible to that event's host (and leadership).
- Calls `announceEvent` with the organizer credential.
- Meetup is the backstop against double announcements: it refuses a
  second one (Hai, 2026-11-10). The dashboard records each event's status
  (one row per event, claimed before the call, so quick repeat clicks make
  one call) and disables the button once Meetup confirms it. Anything not
  confirmed (refused, no answer, or a send cut off for 2 minutes) can be
  tried again. If Meetup says the event is already announced, treat that
  as done.
- "Own" events are the host's ACTIVE events from Meetup's hostId filter:
  co-hosted events count, and so does an event that has started but not
  ended.
- *Builder's call:* whether regular hosts can announce before approval
  (they can't; the event doesn't exist yet).
- **Guardrails (leadership, Stacey and Hai, 2026-11-10;
  `src/lib/hosts/announceSchedule.ts`):**
  - Pre-checks before anything is sent: refused while RSVPs are not open
    (Meetup's `rsvpSettings.rsvpsClosed` and `rsvpState`; when Meetup gives
    neither, the host is told to check on Meetup, never treated as open);
    refused when the event is within 7 days of its start and was created
    more than 7 days before it (Meetup's own rule, checked from
    `Event.createdTime`, which the API exposes). More than 3 weeks out is a
    warning by the button, not a block. The guidelines are shown by the
    button: open RSVPs first, 2–3 weeks ahead, space out from other
    announcements, not 10–4 Mon–Fri.
  - Hold and spacing (Meetup emails the group per announcement, not as a
    digest): a request made 10:00–16:00 Mon–Fri Pacific is held until 16:00;
    anything within 30 minutes of another announcement (held, sending or
    sent) goes 30 minutes after it, and a push that lands in the hold is
    held again. An event starting within 3 days skips both. A held
    announcement is a `held` row with `due_at` in `event_announcements`;
    the page shows "scheduled for …" and any host of the event can cancel
    it. A tick every minute (`announceTick.ts`: Redis lease,
    compare-and-set claim per row, so a re-tick or a restart never sends
    twice) sends at most one due row per tick and defers a row that would
    go within 30 minutes of the last one actually sent; a due row that
    cannot be read (Meetup down, organizer login gone) stays held and is
    alerted once a day once it is 15 minutes late. Plain alert on send and
    on failure. Approved website requests are untouched.
  - **Recreate and announce**, for the 7-day refusal, offered only when
    nobody but the hosts has RSVPed (YES or waitlist): claim the old event
    in `event_recreations` (so two clicks make one copy), copy it through
    the copy path's settings (title verbatim, description, time, all
    hosts, limits, photo, venue, directions), create it with the organizer
    credential (no approval: the content is unchanged; a plain alert and an
    activity line still go out), announce the copy under the same hold
    rules, then cancel the old event (Meetup's `deleteEvent` with
    `removeFromCalendar: false`, which its schema documents as cancel;
    never a delete). The cancel step is behind `ANNOUNCE_RECREATE_CANCEL=1`
    until Hai has tried it on a throwaway event; off, the old event is left
    and the alert asks leadership to cancel it by hand. A failure before
    the copy exists releases the claim and leaves the old event untouched; a
    copy whose announcement did not go out also leaves the old one in
    place, and the alert says both exist. A dropped featured photo is said
    in the alert.

## No-shows

- Past events show "Take attendance on Meetup", linking to that event's
  attendance page on Meetup.
- **Verify first:** that Meetup lets an event's hosts (not just organizers)
  take attendance. If it doesn't, stop and bring it back to Hai. The fallback
  he didn't choose was storing host marks in our own database.
- The no-show report and workspace are unchanged.

## Comments and the complaint sweep

- Read with `Event.comments` (and replies) using the organizer credential.
- **Daily sweep** (bot job) over hosts' recent and upcoming events stores
  comments (new `event_comments` table, keyed by Meetup comment id). The bot
  does no classifying and adds no AI dependency.
- **Flagging is done by Hai's scheduled Claude task** (Hai, 2026-11-02), which
  reads the stored comments and marks complaints. *Builder's call:* the write
  path for it (a narrow authenticated endpoint, or a script run as a Heroku
  one-off like the repo's other operational scripts). Flags are a hint for a
  human, never an action. Until the task exists, the page simply shows no
  flags and "show all" still works.
- Private comments (`isPrivate`) are shown only to that event's hosts and
  leadership.
- The host's **issues** list on the leadership side combines flagged
  comments, anything leadership records by hand, and later the review
  sweep's findings.

## Who can do what on the leadership side

Approve, deny, promote and demote are **1.5 Leadership Team only** (Hai,
2026-11-02), checked live at the moment of the action, the way the no-show
workspace's record/link/void are. Everyone else let into the staff dashboard
(Moderators) can view the queue, candidates and flagged comments.

## What counts as a hosted event

One rule, in `src/lib/helpers/countedEvents.ts`, everywhere a host's events
are counted: the monthly reports, the Guest Host badge count and role, the
host dashboard (history, heat maps, candidates), Where-have-we-met and
Wrapped (leadership, 2026-11-10). An event counts as hosted unless it is
cancelled (Meetup's cancelled statuses, or a title saying "cancelled") or
an **Open House**: a drop-in session the group tags in the title,
"[Open House] …" or "… (Open House)". The tag form was verified against
every past group event on 2026-11-10 (73 of the 74 titles containing "open
house" carry it; "Theodor Jacobsen Observatory Open House", an outing, keeps
counting). Attended events exclude only cancelled ones: going to an Open
House is still going to a group event (builder's call). My history shows
the counted events and offers "show excluded". The 18-month and one-year
windows below are computed in UTC on purpose: a local-time month subtraction
across a DST change moves the window by an hour.

## Promotion

- **Candidates list** (leadership): regular hosts with 20+ counted hosted
  events in the last 18 months who joined the group a year or more ago,
  less organizers (Meetup LEADER status or the Organizer Discord role).
  Each with their heat map, the 18-month and all-time counts, when they
  joined, last hosted date, and issues (flagged comments first, "show all"
  to expand). Decided 2026-11-10 (was: 20+ hosted events all time among
  the past year's hosts).
- **Reviewer checklist** on each queue card (2026-11-10): five tick-boxes
  the reviewer confirms before approving: exact location in the title,
  non-default photo, RSVPs open, starts 7 or more days out, title and
  description reasonable. A memory aid, not a gate: Approve stays enabled.
  The ticked set is recorded with the decision (`event_request_events`
  detail) and shown in the request's history. No automatic detection.
- **Promote / demote**: leadership only, with a required reason. Stored with
  who and when (append-only history, like the no-show workspace).
- Demotion stops direct publishing within the 10-minute tier re-check.
  Already-published events stay.

## Notifications

All plain messages in `#meetup-bot-alerts` (1537755631602237473), no role
pings:
- new request in the queue;
- a promoted host published an event;
- a host announced an event;
- promote/demote.

## Testing

Follow the repo's existing patterns: vitest unit tests, integration tests
against the throwaway Postgres/Redis containers, nock with the network
blocked. Must-cover: tier resolution from both sign-in paths, a host acting
only on their own events, approve/announce idempotency under concurrent
clicks, `[Guest Host] ` for regular and `[Community Host] ` for promoted, copy fidelity, and
demotion taking effect.

## Suggested order (my guess, builder may adjust)

1. Sign-in (both paths) and the host home page with calendar and history.
2. Create/copy, the approval queue, and promoted direct-publish.
3. Promotion (candidates list, promote/demote), comments with the sweep, and
   announcing.

## Open items

- Confirm hosts can take attendance on Meetup (see No-shows).
- Holiday/cultural date list: leadership to supply extras.
- Hai's scheduled task for reviews and comment flagging (separate piece,
  later).
