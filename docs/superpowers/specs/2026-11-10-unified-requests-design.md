# One request queue for Discord and the website — design

Status: Hai's idea 2026-11-10, written up from the brief (the questions were
skipped at Hai's request; every call below that is not from the brief is
marked _my call_). Issue duyhai/MeetupDiscordBot#137. Builds on
`2026-11-02-host-dashboard-design.md` (the request model and rules).

## Why

Two unrelated request paths exist. `/meetup_request_event` posts a public
Discord message with Approve/Deny buttons and writes nothing to the
database; the approve button re-reads the host, date and title out of the
message text and creates the event with the clicker's own Meetup token. The
host dashboard writes an `event_requests` row with an append-only history,
and leadership approves on the staff dashboard through `publishRequest`
(compare-and-set claim, organizer credential, failure texts) with an 8 s
Meetup check before a deny of a failed request. Hosts and organizers cannot
move over gradually: a request made in one place is invisible in the other.

## Goals

1. **One row per request**, whichever side made it. A Discord request
   creates the same `event_requests` row (`source = 'discord'`), appears on
   the host's My requests and the leadership queue, and the Discord post
   links to it. A website request gets a Discord post with the same buttons.
2. **One decision path.** Approve, deny, retry and resolve from Discord or
   the website run the same service: live 1.5 Leadership Team check, the
   compare-and-set claim, the deny check, Meetup create, history row, audit
   entry. Both surfaces then show the outcome: the Discord post is edited
   and its buttons disabled; the website shows the decision.
3. **One set of rules**: tomorrow-to-365-days dates, title rules, the
   5-pending cap, idempotent create, and the website form's defaults for
   what the slash command does not ask.

## Non-goals

- A Discord modal for description, duration or limits (v1 is thin + defaults;
  the host has the website for the rest).
- Editing a request after submit, on either side.
- Changing the website's own create form, queue page or publish service
  beyond what mirroring needs.
- Moving the organizer-credential decision (the website's) back to the
  clicker's token. All approvals now publish with the organizer credential.

## Anti-goals

- A decision that lands in the database but is lost to one surface with no
  trace. A failed mirror edit is logged and alerted, never silent, and never
  rolls back the decision.
- Two events from one request (a double press, a retry, two leaders at
  once). The existing claim and submit-token guards cover both sides.
- A role ping anywhere. Posts and edits send `allowedMentions: { parse: [] }`.
- A Discord button that acts without the live Leadership check.

## What exists (build on it)

- `PostgresEventRequestRepository` (`event_requests`, `event_request_events`,
  `ensureEventRequestSchema` under the dashboard schema lock, `submit_token`
  unique per host).
- `publishRequest` (`src/lib/hosts/publishRequest.ts`): the only publisher.
- The queue route (`src/web/routes/hostRequests.ts`): the approve/deny/
  retry/resolve POST handlers hold the decision logic today, with deadlines
  (`withDeadline`), the deny check and the audit lines inline.
- `src/web/host/createPage.ts`: the website create path (`freshSettings`,
  `parseRequestForm`, `MAX_PENDING = 5`, submit token, the new-request alert).
- PR duyhai/MeetupDiscordBot#135 (open): `create(input, { maxPending })`
  counts pending under a per-host advisory lock. Base on `main`; adopt it
  on rebase if it merges first.
- `resolveHost` / `hostResolveDeps`: Discord id → Meetup id through the
  `members` table, tier, blacklist.
- `discordRoleCheck(getClient, SERVER_ROLES.leadership)`: the live check.

## Schema

Idempotent additions in `EVENT_REQUEST_SCHEMA_SQL`, the `submit_token`
style (`ADD COLUMN IF NOT EXISTS`, under the schema lock, safe on the live
table):

| column               | type                                                              | meaning                     |
| -------------------- | ----------------------------------------------------------------- | --------------------------- |
| `source`             | `TEXT NOT NULL DEFAULT 'web' CHECK (source IN ('web','discord'))` | where the request was made  |
| `discord_channel_id` | `TEXT CHECK (~ '^[0-9]{17,20}$')`                                 | the mirrored post's channel |
| `discord_message_id` | `TEXT CHECK (~ '^[0-9]{17,20}$')`                                 | the mirrored post           |

Existing rows read as `source = 'web'`, with no post. Repository changes:
`NewEventRequest.source`, `EventRequest.discordPost: { channelId, messageId } | null`,
and `setDiscordPost(id, channelId, messageId)`: sets the pointer once (only
while null), bumps `updated_at` but **not** `version` (_my call_: the post
pointer is not a state change; bumping would make an open queue page stale)
and writes no history row.

## The Discord command

`/meetup_request_event year month day title` (unchanged options; the title
max becomes `TITLE_MAX`, the website's 63, since the longer Community Host
prefix must fit too).

1. **Identity.** `resolveHost({ discordUserId })`. `not-linked` → an
   ephemeral nudge, kept visible, not an error: "Link your Meetup account
   first: press Verify in #get-verified, or use Verify on Discord at
   `<origin>/host`." `blacklisted` → the generic error. `not-a-host`
   (linked, no Guest Host role, no past hosted event: a first-time host) →
   **allowed as a regular host** (_my call_: first-time hosts request their
   first event this way today, and leadership's approval is the gate).
   `host` → the resolved tier.
   For this to hold at approval, `productionPublishDeps.tierOf`
   (`src/web/host/hostServices.ts`) maps a `not-a-host` refusal to
   `'regular'` and only a `blacklisted` refusal to `'not-a-host'`;
   `publishRequest` itself and its tests are unchanged, and
   `PUBLISH_FAILURES.notAHost` says "blacklisted" instead of "no role and no
   events". The website is unaffected in practice: its requesters were hosts
   at sign-in, and past events do not disappear (_my call_, from the builder
   check).
2. **Validation** through `parseRequestForm({ title, day, time: '19:00',
duration: 'PT2H' }, pacificToday)`: the website's rules (tomorrow through
   365 days; one-line title). Errors are the website's fixed texts.
3. **Cap.** Regular hosts: `countPending >= MAX_PENDING` → the website's
   message (under the per-host lock once #135's `maxPending` is available).
4. **Row.** `freshSettings(tier, getRandomTip(), 'PT2H')` (regular hosts
   get the Host Tip on top of the standard description, as the website
   does), `startLocal = day + 'T19:00'`, `kind: 'fresh'`,
   `source: 'discord'`, `discordUserId`, `hostName` = the Discord username,
   `submitToken = interaction.id` (digits, 17–20 characters: fits
   `SUBMIT_TOKEN`; unique per host, so a retried interaction makes one row
   and the second attempt finds the first by token).
5. **Post** (below) as the public follow-up in the channel the command ran
   in, then `setDiscordPost`. A promoted host's Discord request behaves like
   their website one: it is published at once with the organizer credential
   and the post shows the published outcome (_my call_; no approval row for
   a host who needs none).
6. The new-request alert to #meetup-bot-alerts is the website's
   `newRequestAlert` (plain, no mentions), posted from the shared create
   helper so both sources alert once.

## The Discord post

Kept close to today's, plus the links and the defaults:

```
❗<@discord> is requesting the creation of a new Meetup event.❗
**Meetup User ID**: 4242
**Number of hosted events**: 3
**Event Date**: 2026-12-05
**Event Title**: Board game night
**Starts**: 7:00 PM for 2 h · standard description and RSVP limits (12, 1 guest)
**Request**: #17 · <https://…/host/requests/17> (the host) · <https://…/dashboard/hosts/requests> (leadership)

💡 **Host Tip**: … 💡
Please reach out to us if you have any questions while setting up your event.
Organizers, please approve or deny below:
```

- The tip line is read back from the stored description (`💡 Host Tip: … 💡`
  prefix), so the post and the event agree.
- The hosted count comes from `pastHostedCount` (organizer read); if that
  read fails the line is omitted rather than failing the request.
- A website request's post names the host by stored name when there is no
  Discord link; the mention appears only when `discord_user_id` is set.
- Buttons: `request-approve:<id>` (Success) and `request-deny:<id>` (Danger).
  `allowedMentions: { parse: [] }` on the post and every edit.
- Channel for website requests: `EVENT_REQUESTS_CHANNEL_ID` (env), _my
  call_: the brief names "the Discord requests channel" without an id and
  the command posts wherever it is run. Unset → website requests are not
  mirrored (one warning at boot), everything else works. Discord requests
  always post where the command ran.

## The decision service

`src/lib/hosts/requestDecision.ts`: `decideRequest(deps, input)` with
`input = { id, version, actor (Discord id), action: 'approve' | 'deny' |
'retry' | 'resolve', reason? }`. It is the queue route's POST body moved out
of Express, unchanged in behaviour:

1. Live Leadership check (`isLeadership`, 5 s deadline) → `not-leadership`
   / `leadership-unavailable`, with the one-per-minute refusal audit.
2. Deny: reason required and ≤ 500 chars; `get` at the version; `canDeny`;
   a failed request asks Meetup first (8 s) → `deny-event-exists` /
   `deny-check-failed`; the write within the page's remaining time, with the
   late-write audit (`deny-slow`).
3. Approve / retry → `publishRequest` under the 20 s deadline
   (`still-publishing` on timeout, audit "started").
4. Resolve → `store.resolve`.
5. Outcome codes are today's `HostRequestResultCode` plus `stale`. The
   service writes the audit line (`Host request approved #id by <@…>`) for
   every outcome that the route writes today; the route no longer does.
6. On `published`, `failed`, `denied`, `resolved` the service calls
   `deps.mirror(request)` fire-and-forget: the Discord post edit (below).

The route becomes a thin wrapper: parse params, call the service, map the
code to today's redirect or 409 page. The codes' fixed texts live with the
service (`DECISION_MESSAGES`, so the Discord replies can use them without
`lib` importing `web`); the route's `HOST_REQUEST_RESULT_MESSAGES` spreads
them in and adds its own `invalid`. `withDeadline` and `WorkspaceDeadlineError` move to
`src/util/deadline.ts` (re-exported from `workspaceActions.ts`), so `lib`
does not import `web`.

## The Discord buttons and modal

`src/lib/hosts/discordRequests.ts` holds the handlers as functions over a
deps object; `createEvent.ts` only wires them (discordx needs the class).

- **Approve** (`/^request-approve:\d+$/`): inside `discordCommandWrapper`,
  read the row (`get`) for its version, call `decideRequest(approve)`, reply
  ephemerally with the outcome's message. `stale` and the 409-style codes
  are an ephemeral "Someone just acted on this request. Nothing was
  changed." The version read-then-decide is the same compare-and-set the
  website uses; two presses race to one claim.
- **Deny** (`/^request-deny:\d+$/`): `showModal` at once (Discord allows
  3 s and the modal must be the first response), one paragraph field
  "Reason (the host sees it)", max 500. The permission check runs on submit.
- **Modal submit** (`/^request-deny:\d+$/`): inside the wrapper,
  `decideRequest(deny, reason)`, ephemeral outcome.
- Outcome texts: `HOST_REQUEST_RESULT_MESSAGES` with a few Discord
  overrides (no "reload the queue"; the website link instead).
- The legacy `approve` / `deny` handlers (plain ids) stay for posts made
  before this ships, unchanged and marked legacy; remove them once no such
  post is pending (follow-up).

## Mirroring the decision onto the post

`src/lib/hosts/requestPost.ts`: `requestPostContent(...)`,
`requestButtons(id, disabled)`, and `mirrorDecision(getClient, request)`:
fetch the channel and message by the stored ids, append one line, disable
both buttons:

- published: `✅ Request approved by <@actor>.\nLink to event: <url>`
- failed: `⚠️ Approved by <@actor>, but publishing failed; leadership is retrying on the website.`
- denied: `❌ Request denied by <@actor>.\nReason: <reason>`
- resolved: the published line.

`actor` is a mention only when `decided_by` is a Discord id; a Meetup id
(a promoted host's own publish) renders as the host's name. Member text
is `escapeMarkdown`'d. A failed edit logs a warning and posts a plain alert
("Could not update the Discord post for request #id") and nothing else
changes. No post stored → nothing to do.

Retry and resolve from the website go through the same service, so a
failed-then-retried request's post ends with the published line.

## Website create path

After a regular host's request is created, `createPage.ts` calls
`deps.postToDiscord(created)` fire-and-forget (new optional dep), which
posts to `EVENT_REQUESTS_CHANNEL_ID` and `setDiscordPost`. The existing
new-request alert is unchanged. Promoted hosts' direct publishes get no
post (nothing to approve).

## Security

- Every Discord decision runs the live Leadership role check inside the
  service; the Meetup `LEADER` membership check of the legacy path is gone
  with it (the organizer credential publishes).
- Nothing the host typed reaches a redirect or a URL; the links in the post
  are the site origin plus the numeric request id.
- `html` tagged template on every web change; no new POST→cross-origin
  redirect; CSP unchanged.
- Posts and edits: `allowedMentions: { parse: [] }`; alerts plain.

## Tests

- Unit: command→row mapping and defaults; the unlinked nudge; first-time
  host allowed, blacklisted refused; the cap; idempotent token = interaction
  id (second run finds the row); post content (format, links, tip from the
  description, no mention without a Discord id); buttons → service wiring
  (approve, stale ephemeral, deny modal → reason → service, non-leader
  refused); mirror edits (three outcomes, buttons disabled, failure alerts);
  the service (the route's existing cases, now against the service) and the
  route wrapper (`tst/web/routes/hostRequests.test.ts` unchanged in intent).
- Integration: `source` stored and read back, default `'web'` for old rows,
  `setDiscordPost` once, idempotent create on a repeated interaction id,
  schema ensure twice.
- Lint, tsc, prettier clean; the no-pings scan passes.

## Follow-ups (not in this PR)

- Remove the legacy `approve`/`deny` handlers once no pre-migration post is
  pending.
- Set `EVENT_REQUESTS_CHANNEL_ID` on Heroku (Hai).
- Adopt `create(input, { maxPending })` from #135 on rebase.
