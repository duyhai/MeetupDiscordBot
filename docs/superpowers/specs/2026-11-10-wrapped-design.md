# 1.5 Gen Wrapped — design

Status: drafted 2026-11-10 from GitHub issue duyhai/MeetupDiscordBot#84 and the
build brief. Builder-checked. The brief was detailed enough that no interview
was held; every choice the brief left open is marked _my call_ below.

## Why

The October 2026 Reverify announcement promised linked members their
"1.5 Gen Wrapped" in December as the headline reason to link a Meetup account.
It has to be live for linked members in December 2026. Because the result is
shareable, every share also recruits the next linker.

## Goals

1. A linked member runs **`/wrapped`** and privately sees their year with the
   group: first-ever event, events this year and all-time, top activity types,
   hosting stats if they hosted, the linked members they went to the most
   events with, busiest month and longest streak.
2. An opt-in **Share** button posts a public version to the channel the
   command was run in. The click is the consent.
3. Cheap on Meetup: one build per member per hour, result cached in Redis for
   the Wrapped season, so repeat views never re-page Meetup.
4. A member with 200+ RSVPs never hits the interaction timeout.

## Non-goals

- A generated image. v1 is a Discord embed (brief: "an embed is fine for v1").
- Anything for unlinked members beyond a nudge to link.
- Group-wide or leadership stats (the monthly reports cover those).
- New persistent storage. Only the cached result lives in Redis, with a TTL.
- A web page version. The host dashboard may get one later; not here.

## Anti-goals (a failure even if it works)

- **Naming an unlinked person.** Co-attendees appear only as Discord mentions
  of members who are themselves linked. A Meetup name of an unlinked member
  never appears, privately or publicly, and is never written to the cache.
- **Sharing someone else's Wrapped.** The Share button only ever posts the
  clicker's own cached Wrapped.
- **Duplicate public posts** from a double-click or a retry.
- **Pinging people.** The shared post renders mentions but notifies nobody;
  alerts to `#meetup-bot-alerts` are plain, no role pings.
- A "no permission" or raw error for an unlinked member. They get a short,
  friendly nudge.

## What exists today (build on it)

- `GqlMeetupClient.getSelfPastRsvpEvents(groupId)` — every past event the
  token's owner RSVP'd yes to or attended, all pages, plus the owner's Meetup
  id. Used by Where have we met? for "my events".
- `GqlMeetupClient.getMemberRsvpEvents(memberId, groupId, filter)` (#67) —
  the same for any member, returns `undefined` when they're not in the group.
  Works with the organizer token; not yet verified with an ordinary member's
  token for another member.
- `getBadgeCounts` pattern — hosted events via `getGroupEvents` filtered by
  `hostId` and `status: ['PAST']`, paged with `getPaginatedData`; cached.
- `getEventRsvps(eventId, page, { rsvpStatus: ['ATTENDED', 'YES'] })` —
  cached attendee lists, the same filter Where have we met? and the stats
  commands use, so cache entries are shared.
- `classifyEventType(title)` in `src/lib/hosts/eventTypes.ts` — keyword
  types: games, food, outdoors, active, arts, nightlife, learning, social.
- `hasCancelledTitle` in `hallOfFame.ts` — events renamed "cancelled" never
  happened.
- `withMeetupClient(interaction, fn)` — the member's own stored Meetup token,
  prompting the OAuth hop if there is none. `withOrganizerMeetup(client, fn)`
  — the shared organizer credential, reads only.
- `FixedWindowLimiter(limit, windowMs)` — in-process fixed-window limiter.
- `KeyValueCache` (`ApplicationCache()`): Redis in production, in-memory
  without `REDISCLOUD_URL`; `set(key, value, ttlSec)`, `exclusive_set`.
- `discordCommandWrapper` — ephemeral "Executing command" progress reply,
  error handling and the `#meetup-bot-alerts` failure alert. Replies are
  `followUp({ ephemeral: true })`; `keepReplyVisible` keeps the progress
  reply when it _is_ the answer.
- `ApplicationMemberRepository()` — `findByDiscordId`, `findByMeetupId`.
- House conventions (host dashboard spec, Where have we met?): private
  replies by default, linked-member gate, plain alerts.

## The command

`/wrapped` with two optional options:

- `year` (integer) — _my call_: defaults to the current calendar year in the
  group's timezone (`America/Los_Angeles`). Accepted range 2015 through the
  current year, so a member can look back in January.
- `refresh` (boolean) — _my call_: rebuild instead of showing the cached
  Wrapped. Subject to the hourly limit. Without it, a December Wrapped built
  on the 1st would be stale all month.

Flow:

1. **Linked gate**, before any Meetup call: `findByDiscordId(user.id)` must
   have a `meetupId`. Otherwise reply (ephemeral, kept visible):
   > Wrapped is for linked members. Press **Link Meetup Account** in
   > <#GET_VERIFIED_CHANNEL_ID> to link your Meetup account, then run
   > `/wrapped` again.
   > That is the whole reply; no error, no alert.
2. **Cache lookup** `wrapped:v1:<discordUserId>:<year>`. Hit and no
   `refresh` → reply with it. No Meetup call, no limiter hit.
3. **Rate limit**: `FixedWindowLimiter(1, 1 h)` keyed by Discord user id,
   taken only for a build. Refused → "You built your Wrapped less than an
   hour ago; try again in N minutes." (If a cached copy exists, show it too.)
4. **Build** (below), with the progress reply updated as it goes
   ("Reading your RSVPs…", "Finding who you went with…").
5. **Store** the result in the cache, reply privately with the embed and the
   Share button.

### Registration

New member-facing commands register mods-only in this app. After the first
registration Hai adds the one-time `@everyone = allow` override for `/wrapped`
in Server Settings → Integrations. That is the project's convention, not a
bug; the PR description says so.

## Building a Wrapped

All Meetup reads use the **member's own token** (`withMeetupClient`). The
organizer credential is a **fallback for the RSVP history only**, used when
the member's own read throws (never when it merely returns nothing). _My
call_: the primary read is `getSelfPastRsvpEvents` rather than
`getMemberRsvpEvents` with the member's own token, because `self.rsvps` is the
path already proven for ordinary members (badge counts, Where have we met?),
and it returns the token owner's Meetup id, which lets the build check that
the connected Meetup account is the linked one. If they differ, the member is
told to press **Link Meetup Account** again; nothing is built. The fallback is
`getMemberRsvpEvents(linkedMeetupId, groupId, { rsvpStatus: ['YES',
'ATTENDED'], eventStatus: ['PAST'] })` on the organizer credential via
`withOrganizerMeetup`; `undefined` (not in the group) is reported as "I
can't see your Meetup history; are you still in the group?".

Inputs to the pure stats function:

- `attended`: the past events (deduped by id, "cancelled" titles dropped).
- `hosted`: past events the member hosted, from `getGroupEvents` with
  `hostId` (badge-counts pattern), same token, cancelled titles dropped.
  _My call_: a hosted event counts as attended too. The stats function
  unions `hosted` into `attended` by id before counting, so a host who
  forgot to RSVP to their own event never sees "hosted 10, attended 3".
- `attendeesByEvent`: for each attended event **in the Wrapped year only**,
  the attendee Meetup ids from `getEventRsvps` with `['ATTENDED', 'YES']`,
  fetched with `mapWithConcurrency` at 5 in flight. Limiting the scan to the
  year bounds the cost to roughly one cached request per event that year.
- The member's Meetup id, the year, and "now".

### The stats

Year boundaries are in `America/Los_Angeles`. _My call_: every count is
taken **as of 31 December of the Wrapped year**, so `/wrapped year:2022`
shows the all-time numbers as they stood at the end of 2022, and a cached
past-year copy never depends on when it was built.

| Stat                        | Definition                                                                                                                                                                |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| First event                 | Earliest attended event ever: title, date, link. `null` if none.                                                                                                          |
| Events this year / all-time | Counts of attended events.                                                                                                                                                |
| Top activity types          | `classifyEventType` over this year's attended titles; top 3 by count. Ties broken by `EVENT_TYPES` order, so the result is deterministic. Empty when no events this year. |
| Hosting                     | Hosted this year and all-time. Omitted entirely when all-time is 0.                                                                                                       |
| Busiest month               | Month of this year with the most attended events; ties go to the earliest month. `null` with no events.                                                                   |
| Longest streak              | Longest run of consecutive calendar months in the year with at least one attended event (in months). 0 with no events.                                                    |
| Went with                   | For each other attendee of this year's events, how many of those events you both were at. Ranked by count desc, then Meetup id asc for determinism.                       |

"Went with" has the Where have we met? caveat: a yes RSVP proves a sign-up,
not attendance. The embed footer says so.

### Resolving "went with" to people we may name

The pure function returns ranked Meetup ids. A second step walks the ranking,
looks each id up with `findByMeetupId`, and keeps the first **3** that are
linked **and still on the Discord server** (an `isPresent(discordUserId)`
check, `guild.members.fetch` in a server, so a public post never shows
"unknown-user"), stopping after **25** lookups so a hugely social member
doesn't hammer Postgres. "And N other members" is the number of distinct
co-attendees that year minus the ones named: an aggregate, never a name. The
cached result holds only Discord user ids and counts for the three, plus that
number: **no Meetup ids or names of other people are cached.**

## Output

One embed, built from the cached stats:

- Title: `🎁 <display name>'s 1.5 Gen Wrapped <year>`
- Fields: First event with us · This year (count, with all-time in the text)
  · Top activities · Hosting (if any) · Busiest month · Longest streak ·
  Went with the most (linked companions, with "and N others")
- Footer: the RSVP caveat.
- Zero events this year: the "This year" field says it was a quiet year and
  points at the all-time count and first event, so the embed still reads well.

**Private reply:** companions as `<@id>` mentions (only the member sees
them), plus a **Share to this channel** button (only when the command was run
in a server channel; run in a DM there is nothing to share to, so no button).

**Shared post** (Hai, 2026-11-10): content `<@sharer> shared their 1.5 Gen
Wrapped <year>` plus the same embed, except that companions appear as plain
**server display names** (nickname → global name → username, resolved for
the guild member at share time), never as tags, with markdown, angle
brackets and mention syntax neutralised; a companion who has left the server
since the build is folded into the count. Still linked members only;
unlinked people stay a count. Sent with `allowedMentions: { parse: [] }` so
no one is notified.

## Share button

Custom id `wrapped_share:<year>:<channelId>` (well under Discord's 100
chars). On click, inside `discordCommandWrapper`:

1. Read the clicker's own cached Wrapped for that year. Missing (expired or
   never built) → "Your Wrapped has expired; run `/wrapped` again to share."
2. Take a share guard `wrapped:shared:<user>:<year>:<channelId>` with
   `exclusive_set`, TTL 1 day. Taken → "You already shared this here today."
3. Fetch the channel by id; refuse (and release the guard) if it isn't a
   text channel the bot can post in, or if the clicker can no longer view it
   (they may have left the server since; checked with
   `channel.permissionsFor(member)`). Send the public post.
4. Ephemeral confirmation "Shared!".

Because the stats are read by the **clicker's** id, a Share click can never
publish anyone else's Wrapped, whichever message it sits on.

## Rate limit and cache

- Limiter: `FixedWindowLimiter(1, 60 min)`, key = Discord user id, one
  module-level instance. In-process is fine: the bot runs one dyno, and the
  worst case after a restart is one extra build.
- Cache key `wrapped:v1:<discordUserId>:<year>`, JSON of the stats plus
  `builtAt`. TTL (_my call_): until **1 February of year+1**, at least one
  day, so a Wrapped stays through the season but a past year's lookback
  rebuilds daily. Bump `v1` whenever the stored shape changes.
- `refresh: true` skips the Wrapped cache read, not the limiter. It does
  **not** bypass `GqlMeetupClient`'s own 12-hour request cache for attendee
  lists and hosted events (_my call_: a few hours of lag on those is fine,
  and bypassing would make a refresh cost a full year of uncached requests).
- The limiter hit is taken **after** the member's Meetup token is in hand
  (inside the `withMeetupClient` callback), so a member sent on the OAuth hop
  who doesn't finish keeps their slot for the next attempt.

## Long histories

`getSelfPastRsvpEvents` pages 100 at a time; a 400-RSVP member is 4 requests.
The attendee scan is bounded to this year's events and cached across members.
The command runs under the deferred ephemeral reply, so it has Discord's 15
minutes. Even so:

- At **10 s** (_my call_) the progress reply changes to "Still building your
  Wrapped — I'll DM you when it's ready", and on completion the embed goes to
  the member's DM (with the Share button carrying the original channel). If
  the DM fails (DMs closed), it falls back to the ephemeral follow-up.
- Under 10 s it's an ordinary ephemeral follow-up.

## Failures

Meetup errors, an expired organizer credential and the like surface through
`discordCommandWrapper`: the member sees the usual "reach out to a moderator"
message and a plain alert lands in `#meetup-bot-alerts`. Nothing is cached on
failure, and the limiter hit stands (it limits attempts, not successes).

## Testing

Unit (vitest, network blocked):

- Stats on fixture RSVP data: zero events this year; only hosted; ties in top
  types; member with no co-attendees; cancelled titles ignored; year
  boundaries in Pacific time; busiest month tie; streak across the year.
- Companion resolution: linked-only, cap of 3, lookup cap, "others" count.
- Linked gate: unlinked member gets the nudge and no Meetup call.
- Rate limit: second build in the hour refused, cached view not limited.
- Cache: hit skips the build; `refresh` rebuilds; TTL math.
- Share: posts the clicker's own stats, guard refuses a second post, missing
  cache tells them to rebuild, no mentions parsed.
- Organizer fallback used only when the member read throws.

Integration (`tst/integration`, throwaway `postgres:16` on :55432 and
`redis:7` on :56379): the Wrapped cache round-trips through Redis with the
computed TTL.

## Left to the builder

- File layout (suggested: `src/lib/wrapped/{stats,companions,cache,build,format}.ts`,
  command and button in `src/commands/meetup/wrapped.ts`, registered in
  `src/commands/index.ts`).
- Exact copy and emoji.
- Progress message wording and cadence.

---

# Addendum (2026-11-10): Wrapped on the website

Status: drafted from the build brief after #138 shipped `/wrapped`. The brief
was detailed enough that no interview was held; every choice it left open is
marked _my call_. This addendum extends the design above; it does not replace
it. The non-goal "A web page version" above is withdrawn by this addendum.

## Why

Members who are not on Discord much, or who prefer a page they can bookmark,
should see the same Wrapped. The host dashboard already has Meetup and
Discord sign-in, sessions, CSP/CSRF, and a page kit, so the Wrapped page is a
second front door onto the same cached stats rather than a new site.

## Goals

1. Any **linked** member (a `members` row with both ids) can sign in to the
   host dashboard, with Meetup or Discord, and reach **`/host/wrapped`**, even
   if they have never hosted.
2. The page shows the same Wrapped as `/wrapped` in Discord, for this year and
   any past year with at least one counted event, back to their first.
3. Web and Discord share **one** cache entry, **one** hourly build slot and
   **one** in-flight lease per member and year, so together they cost Meetup
   at most one build an hour.
4. The same privacy rules as Discord: linked members appear by server display
   name, everyone else is a count; no Meetup name or id of another person
   reaches the HTML.

## Non-goals

- A "Share to Discord" button on the web (v1). Sharing stays in Discord.
- Admitting anyone who is not linked and not a host. An unlinked sign-in gets
  a nudge to link (below), never a session.
- Host features for non-hosts. A linked non-host sees the Wrapped card and
  their link status on the home page, nothing else.
- A Meetup OAuth hop inside the Wrapped page. A member with no usable stored
  Meetup token is pointed at "Sign in with Meetup" (which keeps a token set),
  or at `/wrapped` in Discord.

## Anti-goals

- A host-only route reachable by a non-host, however they signed in.
- A 500, or a raw Meetup response body, on the page or in an alert.
- A web build that bypasses the hourly limit the Discord command enforces, or
  the other way round.
- An unlinked person's name or Meetup id in the HTML, the cache or a log.

## Access: hosts and members

`resolveHost` gains a third outcome:

```ts
| { kind: 'member'; meetupMemberId: string; discordUserId: string }
```

returned for a person who is **linked** (both ids), on neither blacklist, and
not a host (no Guest Host role, no counted hosted event). The blacklist check
stays first. A Meetup sign-in that is not linked and not a host is now refused
as **`not-linked`** rather than `not-a-host` (_my call_: the right next step
for them is to link, not to host). `publishTier` treats `member` as `regular`,
as it already treats a not-yet-host.

The 403 for `not-linked` keeps its Discord text; a Meetup sign-in gets a
Meetup-appropriate one (_my call_): "Your Meetup account is not linked to
Discord yet. Press **Verify** in our Discord server (Link Meetup Account) to
link it, then sign in again." Both are "the existing Verify nudge".

`HostSession` gains `role: 'host' | 'member'`. Sessions written before this
change have no `role`; they are read as `host` (they were only ever created
for hosts). The 10-minute re-check patches `role` along with `tier`, so a
member who hosts their first event becomes a host on the next re-check, and a
host who is no longer one but is linked drops to `member` instead of being
signed out.

### What a member may reach

Inside the gated router, before the pages, a member-role request is allowed
only to `GET /` (home), `GET /host/wrapped`, `POST /host/wrapped/rebuild`,
the Verify refresh the home page offers (`POST /link/discord` and its retry
`POST /verify/finish`; a member is linked, so these only re-run Verify) and
`POST /logout`. Anything else answers the existing 403 ("The host dashboard
is for members who have hosted an event with us."). Hosts are untouched: every
route they have today, plus `/host/wrapped`.

The nav for a member is Home · Wrapped. For a host it is Home · Calendar ·
My history · Wrapped (_my call_: hosts get the tab too; it is their Wrapped).

The member home page is one card: "Hi, <name>", a **Your Wrapped** button, and
their link status (linked ✓, with "Refresh roles and badges" when they signed
in with Meetup, as a host sees). No upcoming events, no quiet days, no
requests, no calendar links. No Meetup read.

## The page: `/host/wrapped?year=YYYY`

`year` defaults to this calendar year (Pacific); out of range (before 2015 or
after this year, or not a number) falls back to this year. The session must
carry a Discord id (a member always does; a Meetup-signed-in host who is not
linked sees the link nudge instead of a Wrapped: Wrapped is for linked
members, as in Discord).

Flow, mirroring `runWrapped`:

1. `readWrapped(cache, discordUserId, year, session.userId)`: a hit renders.
   (The key is `wrapped:<version>:<discordUserId>:<year>`, as the Discord
   command writes it; the brief's "(meetupId, year)" is this key, since a
   linked member has exactly one of each. The Meetup id guards against a
   relink.)
2. Miss: the member's **stored Meetup token** (`getUsableMeetupTokens` under
   the Discord id, the same store the bot and the dashboard sign-in write).
   None → a page: "To build your Wrapped we need your Meetup connection", with
   **Sign in with Meetup** (`/host/auth/meetup/start`; the sign-in keeps the
   token set under their Discord id) and a line about `/wrapped` in Discord.
3. Lease `wrapped:building:<discordUserId>:<year>` with `exclusive_set`, the
   same key and TTL as Discord. Taken → "Your Wrapped is already being built
   (perhaps in Discord). Reload in a minute."
4. `buildWrapped` with the member's client, `claimBuild` taking the **same
   module-level `wrappedBuildLimiter`** the command uses, the organizer RSVP
   fallback via `withOrganizerMeetup`, `isPresent` through the bot, and no
   progress callback. The page waits **20 s** (`announcePage` pattern); the
   build goes on after that and writes the cache; the page says "Still
   building — you've been busy! Reload in a minute." (On reload the lease
   answers "already being built" until the build lands.)
5. Outcomes: `built` → write and render. `rate-limited` → "You built your
   Wrapped less than an hour ago (here or in Discord); try again in N
   minutes", with the cached copy if there is one. `account-mismatch` → "The
   Meetup account you connected isn't the one linked to your Discord. Sign in
   with Meetup again." `not-in-group` → the Discord text. Any error → the slot
   is released if claimed, a plain alert with `describeBuildError` text goes
   to `#meetup-bot-alerts`, and the page is a **503** "Couldn't build your
   Wrapped right now; try again in a little while." Never a 500, never a
   Meetup body.

`POST /host/wrapped/rebuild` (`year` in the body, CSRF-guarded) runs steps
2–5 with the cache read skipped, then 303s to `/host/wrapped?year=`, carrying
a `?notice=` code for the non-render outcomes (_my call_: the web
counterpart of `/wrapped refresh:true`; it spends the same hourly slot).

### Year picker

The brief wants "this year plus each past year with ≥ 1 counted event, back
to the member's first event". That needs per-year presence, which the
cached stats do not carry, so **`WrappedStats` gains one additive field**,
`activeYears: number[]`: the distinct Pacific years of every counted
attended event in the member's history, **not** cut off at the Wrapped year
(so any year's build lists them all). `WRAPPED_CACHE_VERSION` bumps to `v3`
(copies built today under `v2` are rebuilt once). The embed ignores the
field. This is the one deviation from "build/stats unchanged"; everything
else in `src/lib/wrapped` is reused as is.

The picker lists, newest first: this year, then each year in `activeYears`
that is before this year. The years come from the Wrapped being shown, plus
this year's cached copy when there is one (a past year's build is still
complete, but this keeps the list current after a relink). With nothing
cached yet (first visit, no token), only this year is offered.

### Cache TTL for past years

`wrappedTtlSec(year, now)`: unchanged for the current year (until 1 February
of year+1, at least a day). A year **before the current calendar year** now
keeps for **365 days** (_my call_ for "~1 year"): its data is final. A current
-year copy written in December still expires on 1 February as before, so a
member who looks back in January gets a fresh, final build once.

### Rendering

`hostLayout` page, the same CSP (nonce, `default-src 'none'`), no inline
script. One card per section, `dl.stats` tiles for the numbers (this year,
all-time, busiest month, streak), the first event as a `safeHref` link with
its Pacific date, top activities as a list, hosting only for hosts, and
"Went with the most" as display names resolved **at render time** through the
bot's guild member cache (`displayName`), falling back to a count for anyone
it cannot resolve; `memberText` (bdi + escaping) for every name. The RSVP
caveat as a muted footnote. A zero-event year reads "A quiet year" with the
all-time count and first event, as the embed does.

## Cosmetic notes carried from the #138 review

- `format.ts` `plainName`: a leading `-#` (Discord subtext) is escaped too.
- `handlers.ts`: the alert and the in-place reply inside the build `catch`
  are themselves guarded, so a failing alert still leaves the member an
  answer in place.
- `format.test.ts`: `Alex N.` renders unchanged in the shared view.

## Testing

Unit (vitest, network blocked):

- `resolveHost`: linked non-host → `member`; unlinked Meetup non-host →
  `not-linked`; blacklist still first; `publishTier(member)` is `regular`.
- Router matrix: a member reaches `/host` (Wrapped card, no host features)
  and `/host/wrapped`, and every host route answers 403 (calendar, history,
  create, announce, link, verify finish, requests); a host reaches all of
  them and `/host/wrapped`; the session stores `role`; a pre-change session
  without `role` reads as a host; a re-check moves host ↔ member.
- `wrappedPage`: the year list; the shared slot (a web build makes
  `limiter.take(userId)` false, and a slot already taken, as by Discord,
  gives the hourly message); rendering fixtures incl. a zero-event year; no
  unlinked attendee's name or id in the HTML; the 20 s deadline page; the
  lease page; a Meetup error → 503, alert with safe text, slot released; no
  token → the connect page; a non-linked session → the link nudge.
- `cache.test`: past-year TTL; `v3` key.
- `stats.test`: `activeYears`.
- `format.test`, `handlers.test`: the three cosmetic notes.

Integration (`tst/integration`, Redis on :56379): a build through the web
page's orchestrator lands in Redis under the key `runWrapped` reads, and the
Discord handler then serves it without touching Meetup; and the reverse.

Render check: the dev preview (`.claude/preview.mts` + `launch.json`, copied
from a sibling worktree and extended with a fake Wrapped) at 360 and 1280 px,
light and dark, noted in the PR.

## Left to the builder

- Exact copy of the connect, waiting and error pages.
- File layout (suggested: `src/web/host/wrappedPage.ts` for the routes and
  rendering; `displayName` beside `isServerMember` in `serverJoin.ts`).

---

# Addendum (2026-11-11): deeper stats, backfill and a queue

Status: drafted from Hai's brief after #148 shipped `/host/wrapped`. The
brief was detailed enough that no interview was held; every choice it left
open is marked _my call_. Two PRs: **A** (the page's deeper stats) and **B**
(a backfill for everyone and a queue for throttled requests). B is based on
A's branch because A changes the cache shape B writes; if A merges first, B
is rebased onto `main`.

The privacy rules above carry over unchanged: another person appears only if
they are a linked member (a `members` row) and on the server; as a display
name, never a Meetup name or id of an unlinked person; the unlinked are
counts. The Discord command and the web page keep sharing one cache entry,
one hourly slot and one in-flight lease. Hosted stats follow the
counted-events rule (#140). Alerts carry `describeBuildError` text, never a
Meetup body.

## PR A: deeper stats and expandable sections

### What the page shows (the embed stays as it is, except where noted)

1. **Went with the most.** The build names the top **10** linked companions
   (was 3). The page shows the first 3 and a **"Show all 10"** expander with
   the rest. Every named companion links to their **Discord profile**
   (`https://discord.com/users/<discordUserId>`, through `safeHref`, which
   already allows that path): the identity they consented to show by
   linking. No Meetup profile of anyone else is linked or shown. The Discord
   embed keeps naming 3; everyone else, named-but-not-shown included, folds
   into the existing "and N other members" count (_my call_: that is the
   brief's "and N more", in the words the embed already uses).
2. **Busiest month** lists every counted event the member attended that
   month: Pacific date, title, Meetup link via `safeHref`.
3. **Hosting** (hosts only): the top **5** hosted events of the year by
   yes-RSVP count, with links, and the all-time highest-attendance event
   they hosted, with its link. Attendance is
   `rsvps(filter: { rsvpStatus: [YES] }) { totalCount }` as Meetup reports it
   at build time (the audit query already reads it under the alias `yes`).
   _My call_: "all-time" is as of 31 December of the Wrapped year, like every
   other all-time number here, so a past year's copy is final.
4. **Together with your top companion**: under the top named companion, the
   events the two of you attended together this year, expandable. Hai wrote
   "do the same for the one with the most section"; this reads it as "list
   the events behind the top companion's count". The PR asks him to confirm.
5. **Top activity types**: each of the (at most 3) top types expands to the
   member's **first 10 events ever** of that type (all-time up to the year's
   end, earliest first, linked), and under those **"Still around from your
   early cohort"**: the people at those first 10 events who also shared an
   event with the member this year. Top 5, expandable to 10, linked and
   present members only; the rest a count.

Zero-event years render every section cleanly ("None this year", no
expanders); a member who never hosted has no hosting card.

### Where the data comes from

All of it is computed in `build.ts` and cached; the page renders from the
cache only. `WRAPPED_CACHE_VERSION` bumps to **`v4`** (one rebuild of copies
built under `v3`).

- **Hosted events with attendance.** A new query `getHostedEvents`
  (`getGroupEvents`' fields plus `attendance: rsvps(filter: { rsvpStatus:
  [YES, ATTENDED] }) { totalCount }`), paged like `getGroupEvents` with `hostId` and
  `status: [PAST]`, cached under its own name in the 12-hour request cache
  (_my call_: a separate query, so the existing `getGroupEvents` entries,
  which lack the field, are never read as "0 yes"). `WrappedMeetup.
  getGroupEvents` is replaced by `getHostedEvents(hostId, input)`.
- **Early-cohort attendees.** For each top type, the first 10 counted
  attended events of that type; the union across types (at most 30 events)
  minus the ones already fetched for this year goes through the same
  `readAttendees` (filter `['ATTENDED', 'YES']`, `mapWithConcurrency` at 5,
  cached per event by the client). One pure step then ranks, per type, the
  Meetup ids seen at those early events that also appear in this year's
  companion ranking (self excluded): by early events shared desc, then
  this-year events shared desc, then Meetup id asc.
- **Naming.** `nameCompanions` becomes `nameRanked(ranked, deps, limit)`:
  the same linked-and-present walk, `COMPANION_LOOKUP_CAP` raised from 25 to
  **50** so ten can be found; companions use limit 10, each type's cohort
  limit 10 with its own cap of 25 lookups. The unlinked remainder is
  `otherCount`, as today.

### The cached shape (`CachedWrapped`, `v4`)

Additive fields, all on the member's own events or on linked Discord ids:

```ts
stats.busiestMonth: { month; count; events: WrappedEvent[] } | null
stats.topTypes[i]: { type; count; firstEvents: WrappedEvent[];   // ≤ 10
                     cohort: { named: { discordUserId; earlyCount; sharedCount }[]; // ≤ 10
                               otherCount: number } }
stats.hosting: { thisYear; allTime;
                 topThisYear: { event: WrappedEvent; yesCount: number }[]; // ≤ 5
                 allTimeBest: { event: WrappedEvent; yesCount: number } | null } | null
companions.named[0].sharedEvents?: WrappedEvent[]   // the top companion only
```

_My call_: only the top companion carries its event list; the other nine are
name and count, which keeps the entry small. The embed ignores the new
fields except that `named` may now hold 10.

### Keeping the page fast

The build does more Meetup reads (hosted attendance comes with the hosted
list; the cohort adds at most 30 cached attendee fetches), so it may take
longer. The 20 s wait and the "still building" page stay; `buildWrapped`
logs its duration (info, ids only). Progress gains one step, "Looking back at
your early events…".

### Rendering

`<details>`/`<summary>` for every expander (the stylesheet already styles
them; no script, so the CSP is untouched). Summaries say what they open:
"Show all 10", "Events that month (4)", "Your first 10 game nights",
"Still around from your early cohort (6)". Companion names via `memberText`
inside `<a href="https://discord.com/users/…" rel="noopener noreferrer"
target="_blank">`. Event links via `safeHref`, title via `memberText`, date
in Pacific `ll`. Rendered at 360 and 1280 px, light and dark, with
screenshots in the PR.

### Testing (PR A)

Unit (vitest, network blocked):

- `stats.test`: busiest-month event list (sorted, cancelled dropped, tie to
  the earliest month); hosting top 5 by yes count with a date tiebreak and
  fewer than 5; all-time best across years and null without hosting; first
  10 per type with fewer than 10 and all-time reach; the cohort ranking
  (early count, then shared count, then id; self excluded; nobody shared this
  year → empty); top companion's shared events.
- `companions.test`: `nameRanked` to 10, the raised cap, the cohort's own cap.
- `build.test`: hosted attendance read through `getHostedEvents`; early
  events fetched once each and never twice for an event already fetched this
  year; the duration log; a zero-event year makes no cohort fetch.
- `format.test`: the embed names 3 and folds 7 more into "and N other
  members".
- `cache.test`: `v4` key.
- `wrappedPage.test`: expand/collapse markup for each section, companion
  profile links, every event link through `safeHref` (a `javascript:` URL
  renders as text), no unlinked attendee's Meetup name or id anywhere in the
  HTML or the cache JSON, zero-event and no-hosting renders.

Render check at 360/1280, light/dark, via the dev preview.

## PR B: backfill for everyone, and a queue for throttled requests

### Why

A member who opens Wrapped on 1 December should find every past year already
there, and a member who hits the hourly limit should get a promise with a
time on it rather than a "try again".

### The backfill job

Modelled on the report build job (`buildJob.ts`): Postgres-recorded runs,
the shared organizer lease, the quiet-hour and identity-sweep guards,
restart-safe, single-flight.

- **Who and what.** Every **linked** member (`members.listAll()` rows with
  both ids), ordered by Discord id, for every year from the Pacific year of
  their first counted event through the current year. Years come from the
  member's history, read once per member.
- **Reads.** The member's own stored token (`getUsableMeetupTokens` under
  the Discord id) when present, else the organizer credential: history via
  `getMemberRsvpEvents` (`['YES', 'ATTENDED']`, `['PAST']`; `undefined` = not
  in the group → skipped and counted), hosted via `getHostedEvents`,
  attendees via `getEventRsvps`. The spec above called the organizer path
  unverified for ordinary members; it is in fact what the daily no-show
  report runs (`noShowReport.ts` reads `getMemberRsvpEvents` for every
  no-show member with the organizer token), so it is verified in production.
  The PR records that; no separate probe.
- **One read, every year.** `build.ts` splits into `readWrappedSources`
  (history, hosted, this-year attendees for a set of years) and
  `buildWrappedFromSources(sources, year)`; `buildWrapped` composes them, so
  the on-demand build and the backfill produce byte-identical cache entries.
- **Skip fresh.** A cached copy for the member's current Meetup id is fresh
  when the year is past, or when it is the current year and `builtAt` is
  under **7 days** old (_my call_). Fresh copies are skipped and counted.
- **Pacing** (_my calls_, constants in one place): a tick every **5
  minutes**; at most **4** members per tick and one build in flight; a
  per-tick budget of **150** Meetup client calls (a counting wrapper around
  the client; a build that is in flight finishes, no new one starts past the
  budget). Each build takes the member's `wrapped:building` lease so it never
  overlaps an on-demand build, and never calls `claimBuild`, so it spends no
  hourly slot.
- **Runs.** `wrapped_backfill_runs (id, trigger 'job' | Discord id,
  started_at, finished_at, members_total, members_done, built, skipped,
  failed, cursor)`. A run opens when none is open and the last finished more
  than **20 hours** ago (daily), or when staff pressed Run now; it advances
  its cursor (the last Discord id processed) after each member, so a restart
  resumes. Per-member failures are logged by error class, counted, and
  retried on the next run (not in this one). The run's end posts **one**
  plain alert: members, built, skipped, failed, duration. Nothing pings.
- **Guards.** No tick starts work in the quiet hour, while the identity
  digest runs, or while the report build lease is held (the backfill takes
  the same `acquireBuildLease`, so the organizer credential is never read by
  two jobs at once); the lease is held for one tick, not a run.

### The queue

- `wrapped_queue (discord_user_id PRIMARY KEY, meetup_id, year, queued_at,
  claimed_at NULL, attempts)`: at most one queued year per member.
- When a member is **rate-limited** (web or Discord), the entry is
  **auto-added** (_my call_: no extra click; the brief says "offer/auto-add").
  Same year already queued → the same message; a different year queued →
  "You already have YYYY queued; it'll be ready by about HH:MM" (the first
  stays). On the web the queued state also shows on a plain reload while the
  cache is still a miss and the entry exists; a member with a free slot who
  reloads still builds on demand (the queue entry is then dropped).
- **Ready by** = the next tick's start, plus one tick per
  `MEMBERS_PER_TICK` entries ahead in the queue, shown in Pacific time
  (`h:mm a`) on the web and as a Discord `<t:…:t>` timestamp.
- Each tick drains the queue **first**, oldest `queued_at` first, claiming
  rows (`claimed_at` set; a claim older than the lease TTL is stale and taken
  again), then the sweep. A built entry is deleted; a failed one is released
  with `attempts + 1` and dropped after **3** (logged). Queued builds take the
  member's building lease and write the shared cache; they spend no hourly
  slot.
- No notification in v1: the next page view or `/wrapped` finds the copy.

### Staff dashboard

A **Wrapped backfill** card beside the Wrapped announcement card: last run
(when, built/skipped/failed), members done/total of the open run, queue
length, next run. **Run now** (leadership only, same guards as the other
staff POSTs: CSRF, Origin, rate limit, live role check, audit) sets a
run-now flag the next tick honours and kicks a tick in-process. Fixed notice
texts, nothing echoed.

### Testing (PR B)

Unit: queue dedupe (same year, different year) and drain order; stale claim
re-taken; attempts and the drop after 3; the backfill skips fresh copies and
rebuilds a stale current year; per-tick member cap, in-flight cap and budget
stop; a failed member is counted and retried next run; resume from the
cursor; the daily gate and Run now; quiet hour and held lease defer; the
page's and the command's queued state with the ready-by time; the summary
alert once per run. Integration (`tst/integration`, Postgres :55432, Redis
:56379): the queue table round-trips; a backfill tick writes the exact cache
entry `readWrapped` serves, and the on-demand path then makes no Meetup call.

## Decisions after the builder check (2026-11-11)

A fresh reader planned from the draft above and asked seven questions. The
answers, all _my calls_ unless marked for Hai:

1. **Hosted attendance counts `[YES, ATTENDED]`** (PR A), not `[YES]` alone.
   Hosts mark attendance after an event and the rest of the codebase reads
   attendees with both statuses for that reason; the superset is right
   whether or not Meetup moves a marked member off `YES`. The PR asks Hai to
   confirm, since his brief said `[YES]`.
2. **The backfill's organizer client keeps the 12-hour request cache.**
   `withOrganizerMeetup` is given a `makeClient` that builds a plain
   `GqlMeetupClient` (the identity and no-show jobs bypass the cache because
   they diff live data; the backfill reads the same attendee and hosted
   lists the on-demand build reads, and sharing them across members is the
   point). This also keeps backfill and on-demand entries identical.
3. **Member-token path = the on-demand build's path.** History via
   `getSelfPastRsvpEvents` with the account-mismatch check. A mismatch, or a
   401 from any read with the member's token, redoes that member with the
   organizer credential (the linked Meetup id is the identity; a stale token
   never writes under the wrong account). Any other error fails the member,
   who is retried next run.
4. **The queue is for members with nothing cached.** Rate-limited with a
   copy for the current Meetup id already cached: no queue entry; the notice
   stays "try again in N minutes" with the copy shown. Rate-limited with no
   copy: queued. At drain time an entry whose copy appeared meanwhile is
   dropped unbuilt. So Rebuild every five minutes cannot buy a build a tick.
5. **The report lease is taken per organizer-credential build only**, held
   for that one build, never for a tick or a run; member-token builds take
   none (they do not touch the organizer credential). The report job ticks
   every 15 minutes and simply finds the lease free on its next tick: a
   delay of at most one report tick is accepted.
6. **Ready-by skips the quiet hour** (18:00–19:00 UTC) and is worded "by
   about": the estimate counts ticks, with none falling in that hour.
   Budget stops and lease waits are accepted as noise in the estimate.
7. **Redis memory**: the `v4` entry is bounded (10 companions, ≤ 30 first
   events, one month's events, top companion's events, ≤ 6 hosted) and past
   years are written once per 365 days. The PR records the entry size for a
   busy member and asks Hai to check the Redis plan's limit and eviction
   policy; if it is small, the backfill caps the years it writes (newest
   first) by a constant.

## Left to the builder

- Exact copy of summaries, notices and the staff card.
- File layout (suggested: `src/lib/wrapped/{cohort,backfill,queue}.ts`,
  `src/lib/repositories/postgresWrappedBackfillRepository.ts`,
  `src/web/routes/wrappedBackfill.ts`).
