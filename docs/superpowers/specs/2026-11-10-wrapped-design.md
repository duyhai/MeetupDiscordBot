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
only to `GET /` (home), `GET /host/wrapped`, `POST /host/wrapped/rebuild` and
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
