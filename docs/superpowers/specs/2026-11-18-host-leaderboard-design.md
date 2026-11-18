# Host leaderboard, profiles and maps — design

Status: drafted 2026-11-18 from Hai's feedback recording of 2026-11-17 (items
5 to 8) and his follow-up decisions relayed by the lead. Three PRs, each
standing on its own. Choices the brief left open are marked _my call_.
Streak icons follow Hai's later decision: 💎 weekly, 🔥 daily.

## Data source: the group snapshot only

Every number here comes from the snapshot tables (`meetup_events`,
`meetup_event_rsvps`, PRs #155 to #157). **No page makes a Meetup request.**
The snapshot lists every event once a day (`SNAPSHOT_RUN_INTERVAL_MS`, 20 h),
so the pages say "Updated <time>" and lag up to a day; that is fine for a
monthly ranking. Before the first full pull finishes the pages show a
"being built" notice instead of partial standings.

**Names.** The snapshot stores Meetup ids only. The listing query
(`getGroupEventsForSnapshot`) already returns `eventHosts.member`; PR 1 adds
`name` to it (no extra request) and keeps the latest name per host in a new
`meetup_host_names (member_id PK, name, seen_at)` table. Host names are shown
on every public Meetup event page, so this stores nothing that is not already
public. The event and RSVP tables stay name-free. Names are shown with
`memberText`. _My call:_ the Meetup name, not the Discord name: every host has
one, it matches My history's co-host names, and it needs no Discord lookup.
Control characters are stripped at ingest. Names of hosts who have left are
not purged (noted for later; they stay as long as their events do).
Names are written only by a snapshot listing, which every run (full or
incremental) starts with and which covers every past, cancelled and upcoming
event, so the first run after deploy names every past host. Until it runs
(up to a day, or "Refresh snapshot now"), there are none: the pages show
"Unnamed host" with a note that names appear after the next daily update.

## Counting (PR 1)

- **Hosted event:** `status = 'PAST'`, not deleted, and `countsAsHosted`
  (countedEvents.ts): the Hall of Fame and promotion rule.
- **Co-hosting:** each host of an event gets the full event, deduped per
  event, exactly as `collectHostStats`.
- **Month:** the Pacific calendar month of the event's start (`tz()`,
  America/Los_Angeles), as the staff Hall of Fame.
- **Places and ties:** standard competition ranking by events hosted: tied
  hosts share the place and the next place is skipped (two golds, then a
  bronze, no silver). Hosts with the same count are listed by name. Only
  hosts with at least one event place.
- **Medals are stored.** "A host keeps every medal they have earned": once
  awarded, a later snapshot correction or rule change never takes a medal
  away. Tables `host_medal_months (month PK, awarded_at)` and
  `host_medals (month, member_id, place 1..3, events, PRIMARY KEY (month, member_id))`,
  guarded `CREATE TABLE IF NOT EXISTS` in `SCHEMA_SQL`.
- **When a month is awarded.** Once it has ended and the latest finished
  snapshot run's listing, completed at least 48 h after the month's end, was
  complete: not short (a new `listing_short` flag on the run, since a later
  good tick clears `last_error`) and with no error on the run. A short or
  failed listing awards nothing, so an outage can never award wrong medals
  for good.
- **How awarding runs.** Lazily on a Leaderboard read, in one transaction
  under an advisory lock, at most 12 months a read (oldest first): the first
  reads after deploy work through the history 12 months at a time. A read
  waits at most 2 s for the award's writes; a failed award is retried after
  10 minutes, and meanwhile the month says its medals "could not be awarded
  just now". A medal read failure renders the standings without medals and a
  note, never an error.
- **An awarded month shows the stored medalists** with the place and count
  they were awarded on, then everyone else ranked live from the next place,
  so the page and the Hall of fame tally always agree. The current month
  shows "standings so far", no medals.
- **Cost.** The page runs in the bot's process, so nothing formats a time
  zone per event: the Pacific day comes from SQL
  (`date_time AT TIME ZONE 'America/Los_Angeles'`), events are bucketed by
  month and by host in one pass, and the result is cached per snapshot run
  for a minute. Concurrent reads share one build, and reads that arrive while
  an award is still running wait on it instead of queueing their own on the
  lock.
- **Known limit.** The snapshot accepts a listing with at least
  `MIN_LISTING_RATIO` (95%) of the stored past events as complete, so a
  listing missing up to 5% would still pass the medal gate. That threshold
  predates the leaderboard. A run whose listing is short, finished or still
  open, blocks awarding.

## Streaks (PR 1)

Hosting days are the Pacific calendar days of the host's counted events;
hosting weeks are Monday-first Pacific weeks (as the calendar).

- 💎 **Weekly streak** (the more prestigious badge, listed first): the
  longest run of consecutive hosting weeks ending this week or last week.
- 🔥 **Daily streak** ("on fire"): the longest run of consecutive hosting
  days ending today or yesterday. Today is not over and today's events are
  not PAST yet, so a streak breaks only once a whole day passes with no
  hosting.
- "Today" for streaks is the snapshot's day (the latest listing, or now if
  sooner), not the wall clock: a snapshot a few days stale never shows every
  streak as broken. The page prints when the data was updated.
- Shown as icon plus count whenever the current streak is 1 or more, with the
  host's best (longest ever) beside it. No threshold. Every emoji badge has a
  text alternative (`<span role="img" aria-label="Weekly hosting streak: 3 weeks">`).

## Pages

- **PR 1, Leaderboard tab** (`/host/leaderboard`, hosts only; members do not
  see the tab): **This month** with month navigation (place, medal, host,
  events, streaks) and **Hall of fame** (all-time: lifetime events, medal
  tally, current and best streaks), as two views of one page.
- **PR 2, host profiles** (`/host/hosts/<meetupId>`, signed-in hosts only;
  names on the leaderboard link here): name, a Community Host badge for a
  promoted host (no tier badge otherwise: organizers, moderators and past
  hosts are not promoted either, and never for an id on the Guest Host
  blacklist; the Organizer badge from #167 can come later), lifetime events
  hosted (the Leaderboard's own count) and attendees hosted (sum of Meetup's
  YES + ATTENDED per counted event, the number Wrapped uses; events with no
  attendance data show "–" and are left out of the sum and the top list),
  medals by month (each linked to its month), weekly and daily streaks with
  bests, event types (`classifyEventType`), the top 5 events by attendees
  (ties: the more recent first) and the 10 most recent, linking to Meetup.
  **Only hosting activity already public on Meetup:** nothing a host
  attended, no no-show, suspension, ban or request data.
- **Profile reads.** A non-digit id is a 404 with no read at all. Any
  digit-only id goes through the Leaderboard's loader (its run checks, then
  its cache or a build); one with no counted hosted events is then a 404
  without the attendance read. A host's profile adds two reads: their events
  with attendance (`host_ids @> ARRAY[id]`, which uses the GIN index; the
  stored RSVP count only where the listing had none) and one
  `promoted_hosts` lookup, which only drops the badge if it fails.
- **PR 3, maps** (profile map and Hall of fame map).

## Map (PR 3)

**Fields, verified 2026-11-18 on gql-ext** (`https://api.meetup.com/gql-ext`,
the endpoint the organizer client uses; introspection, unauthenticated,
schema-only, and the final listing query validated there): `Event.eventType`
(HYBRID, ONLINE, PHYSICAL) and `Venue { lat lon city }` (note `lon`, not
`lng`). **`Event.isOnline` does not exist on gql-ext** (the website's `/gql2`
has it, which is where the first check was made, wrongly), so ONLINE is the
only online signal. The fields are pinned in a test against a checked-in list
(`tst/fixtures/gqlExtFields.ts`). Project rule from here on: a Meetup field
counts as verified only once checked on gql-ext. A read-only sample of 200
past group events (via `/gql2`): all PHYSICAL, 3 with no venue, 2 with the
0,0 placeholder, all within the Seattle area.

**Privacy:** online events (`eventType = ONLINE`) and venues without
coordinates (or Meetup's 0,0 placeholder) are left out. Coordinates are
**rounded to a 0.01° grid (about 1 km) at ingest**; exact venue coordinates
are never stored, so no residential pin can be plotted. City names are
cleaned of control and format characters (bidi overrides, zero-width) at
ingest and shown with `memberText`. No venue names or addresses anywhere. A
failed listing's error is rethrown without the response data, and the
snapshot job logs only the error class, HTTP status and first GraphQL
message, so coordinates or names never reach the process log.

**As built (PR 3).**

- `toPlace` (snapshot/meetup.ts) turns a listing node into grid indices
  (degrees × 100, rounded) and a cleaned city, or null. Columns
  `place_lat_e2`, `place_lon_e2`, `place_city` and `place_listed` on
  `meetup_events` (guarded ALTERs) are refreshed by every listing.
  `place_listed = false` means "not collected yet" (rows from before the
  venue fields), which the page says as "Venue data … is still being
  collected", not "no venue". **Deploy note:** trigger one snapshot run after
  deploy so the maps fill in without waiting a day.
- The Leaderboard's event read carries the cell, so the maps cost no extra
  query.
- Each cell is drawn as the ~1 km square it is (not a pin), darker with more
  events; zoom stops at 13 (fitted at 12 at most).
- **What is drawn and named is decided on the server** (places.ts), before
  anything is embedded in the page or merged for low zoom:
  - Hall of fame: an area is drawn only with at least
    `HALL_OF_FAME_MIN_EVENTS` (3) events, and only if no single host
    dominates it: removing all events of any one host must leave at least
    `HALL_OF_FAME_MIN_EVENTS_WITHOUT_ANY_HOST` (2). A host alone, a regular
    co-host pair, or one host plus one other event never makes an area
    appear (an earlier "2+ distinct hosts" rule let all three through). A
    city is named only if it contains a drawn area (its count then includes
    its undrawn events); other cities fold into "Elsewhere or unknown area",
    even when their undrawn areas together would pass the rule. The Hall of
    fame shows **no exact count** in its map or map text: areas and cities
    show bands (up to 5, 6–10, 11–25, 26+) computed on the server; areas are
    listed by position and cities by band then name, so order gives nothing
    away; areas not drawn get a sentence with no number. "Elsewhere",
    "online or without a venue" and "still being collected" are banded too:
    the Hall of fame header gives the exact total of events, and exact
    no-place lines would let the named cities' exact total be worked out.
    Blacklisted hosts' events are included (areas, not people).
  - Profile: an area is drawn only with at least `PROFILE_MAP_MIN_EVENTS` (3)
    of that host's events, and cities are named from drawn areas only. Every
    other event is in one line ("N events in other areas … not shown on the
    map or by city"), with no city.
  - Why: without these, a host's 2 home events in "Smallville" were unnamed
    on their map but named in their profile's city list, and the Hall of
    fame map drew a lone Smallville square with count 2; together, that
    pointed at their home area.
  - No profile map for an id on the Guest Host blacklist until Hai decides.
    The thresholds and an opt-out are with Hai; these are the conservative
    defaults.
  - **Accepted residual risks** (the lead's review, 2026-11-18):
    1. A host's own profile shows an area with 3 or more of their events (a
       frequent home venue), with its city. Only an opt-out or dropping home
       venues would remove it.
    2. An area appears on the Hall of fame the day it first meets the rule:
       someone diffing daily can place that day's known event in a 1 km area
       that already held other hosts' events.
    3. A band boundary crossing (5 to 6, 10 to 11, 25 to 26) the day after a
       known event says that event was in that area or city.
    4. An area with host X's 3 events and one event each from two other
       hosts is drawn, since removing X's events still leaves 2; most of
       what it shows is X's.
    5. Comparing several profiles' city lists with the Hall of fame's can
       narrow down which hosts held events in a city, but names no area.
- Under each map, text that accounts for every event exactly once: named
  cities (top 8, then "Elsewhere or unknown area"), areas not drawn, events
  online or without a venue, events not collected yet. The map container is
  a labelled region pointing at that list, and stays hidden without
  JavaScript.
- Leaflet 1.9.4 is a pinned dependency served at
  `/host/assets/leaflet.{js,css}?v=1.9.4` (signed-in only, cached for a year,
  gzipped once in memory since the app has no compression middleware: the
  script is 147 KB raw, about 42 KB gzipped). Map pages send the host CSP
  (`HOST_CSP_OPTIONS`) with `tile.openstreetmap.org` added to `img-src` and
  nothing else changed; other pages keep the host CSP without the tile
  host.

**Rendering, compared:**

1. _Self-hosted Leaflet 1.9 + OpenStreetMap tiles (recommended)._ Leaflet
   (147 KB raw, about 42 KB gzipped) is served from our own origin under the page nonce; the CSP
   gains only `img-src https://tile.openstreetmap.org`. OSM's tile policy
   asks for the "© OpenStreetMap contributors" attribution (Leaflet shows it),
   a valid Referer (our `same-origin` Referrer-Policy sends none, so the tile
   layer sets `referrerPolicy: 'origin'`), modest traffic (signed-in hosts
   only: well within it) and no bulk download or prefetch. Real streets and
   neighbourhoods, pan and zoom.
2. _Static, no third party:_ a server-rendered SVG of the grid cells over a
   plain outline. No CSP or policy change, but no streets, so "which areas are
   covered" is hard to read. Kept as the no-JS fallback (a cell list by city).

Recommended: 1, with 2's city list underneath for no-JS and screen readers.

## All-time awards and the monthly archive (PR 4)

Decided by Hai, 2026-11-18: "Go with Layout 2 and Ties A." From his
request: "next to the Hall of Fame, we could also have an all-time high
leaderboard. Or maybe in the Hall of Fame, we could have 10 different
all-time awards (eg: highest weekly streak top 10, highest daily streak top
10, etc), and then below that, we could have an archive where people can
look at the historic monthly hall of fame rankings."

**Layout 2.** The Hall of fame view keeps the lifetime table on top (it is
the "most events hosted" board), shortened as Hai decided after calling it
"a long … list" at 452 hosts: "let's do the first 5, and then three dots or
some kind of styling to indicate skipping rows, and then the 3 people before
you and 3 people after you with your current rank. If you're in the top 10,
then just simply show the top 10." So: a viewer placed 10th or better (ties
included), or not on the board, sees every row placed 10th or better.
Anyone else sees rows 1 to 5, a gap row ("N hosts not shown (places A to
B)"), then the 3 rows before them, their own row (true place, "You", tinted),
and the 3 after (none after if they are last). Windows go by row order in
the ranked list and places stay the true competition places; runs that
touch merge, with no gap. "Show all N hosts" (`?view=all&hosts=all`,
server-rendered, no JavaScript) shows every row, with a link back; both
links are left out when the short list already shows everyone. A
top-places list (top 10, or top 5 on a phone) stops at 25 rows, as the award
boards do, then "and N more tied at Xth", always keeping the viewer's own
row. A gap never repeats a place already shown above it: when the first
skipped row is tied with the last shown one, the range starts at the next
place, or the gap gives only a count if every skipped row is tied.

On a phone (Hai: "just show one before and after, and only show top five if
you are in the top five. Ten is too many for mobile."): a viewer placed 5th
or better, or not on the board, sees rows placed 5th or better; anyone else
(6th to 10th included) rows 1 to 5, a gap where rows are skipped, then 1 row
before them, their row and 1 after, with touching runs merged. The page
has no device detection: it renders the union of both widths' rows, marks
rows one width hides (`desktop-only`, `phone-only`), and the stylesheet's
phone block (the same 640 px breakpoint as the stacked tables) swaps them.
A gap's text differs per width, so `shortList` computes both and the page
renders each variant where its width needs it, the other hidden with
`display:none` (not read out). A gap can be phone-only: a viewer placed
9th sees the top 10 on desktop but 1 to 5, "places 6 to 7", 8th, themselves
and 10th on a phone.

| Board                    | Per host (or event)                                              | Source                                                                                                 |
| ------------------------ | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Most attendees hosted    | sum of Meetup's YES + ATTENDED per counted event                 | attendance added to the Leaderboard's event read; events with no attendance data left out, with a note |
| Longest weekly streak 💎 | best run of hosting weeks                                        | `streaks` (best)                                                                                       |
| Longest daily streak 🔥  | best run of hosting days                                         | `streaks` (best)                                                                                       |
| Most gold medals         | stored golds, for every stored medalist                          | `host_medals`                                                                                          |
| Most medals              | stored medals, any place, for every stored medalist              | `host_medals`                                                                                          |
| Most events in one month | the host's best month, named                                     | `byMonth`                                                                                              |
| Biggest single event     | per counted event: attendance, title linked to Meetup, its hosts | the same attendance; unknown left out                                                                  |
| Widest variety           | distinct event types hosted                                      | `classifyEventType`, once per event at load                                                            |
| Most months active       | distinct months with a counted event                             | `byMonth`                                                                                              |

Medals are permanent, so the two medal boards rank every stored medalist,
including one whose events were later deleted or renamed "cancelled": they
keep their medals there and in the archive, but with no counted events they
are not in the lifetime table or on the other boards. Ties on every board
go by name, then id, the same comparator as the standings.

**Ties A.** Competition ranking: tied entries share a place and the next
place is skipped. A board shows every entry placed 10th or better, so a tie
for 10th runs it past 10 rows. A hard cap of **25 rows** stops a mass tie
(say, 40 hosts with one medal): the rest are summed as "and N more tied at
Xth". Rows past the cap are always tied with the 25th, since any later
place would be past 10th. Zero values never place.

**Archive.** Every closed month, newest first, grouped by year (each year
collapsible, the latest open). An awarded month lists its medalists exactly
as its `?month=` page does (the same `monthRows`: stored place and count),
with a link to that page for the full standings. A month that is closed but
not yet awarded says so; an awarded month with no hosted events says that.

**Cost and constraints.** Snapshot only, no Meetup call. The boards and the
archive's medalists (the same monthRows as the month page, per awarded
month) are computed once per load in the cached loader and reused until the
next snapshot run; the archive sends every year, older ones collapsed. Names link to profiles. Nothing about what anyone
attended: attendance appears only as event totals, which Meetup shows
publicly, and "biggest single event" lists only counted hosted events. No
location-based board (the home-venue concern). Blacklisted hosts are
treated like any other host (Hai: keep as is). Emoji keep their text
alternatives.

## PR split

1. **Leaderboard tab:** host names table, medal tables and awarding, monthly
   ranking, Hall of fame, streak badges.
2. **Host profiles:** profile page and lifetime stats; leaderboard names link
   to it.
3. **Maps:** snapshot venue fields, profile map and Hall of fame map.
4. **All-time awards and archive:** nine award boards under the Hall of
   fame table, and the monthly archive.
