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
  away. A month is awarded when it has ended and a snapshot listing finished
  at least 2 days after its end (late edits and deletions are in). Awarding
  runs lazily on a Leaderboard read, for every unawarded closed month (the
  first read backfills history), in one transaction under an advisory lock:
  `host_medal_months (month PK, awarded_at)` and
  `host_medals (month, member_id, place 1..3, events, PRIMARY KEY (month, member_id))`,
  guarded `CREATE TABLE IF NOT EXISTS` in `SCHEMA_SQL`. The page waits at
  most 2 s for awarding (it carries on in the background past that), and an
  award or medal read failure renders the page without medals, never an
  error. The current month
  shows "standings so far", no medals.

## Streaks (PR 1)

Hosting days are the Pacific calendar days of the host's counted events;
hosting weeks are Monday-first Pacific weeks (as the calendar).

- 💎 **Weekly streak** (the more prestigious badge, listed first): the
  longest run of consecutive hosting weeks ending this week or last week.
- 🔥 **Daily streak** ("on fire"): the longest run of consecutive hosting
  days ending today or yesterday. Today is not over and today's events are
  not PAST yet, so a streak breaks only once a whole day passes with no
  hosting.
- Shown as icon plus count whenever the current streak is 1 or more, with the
  host's best (longest ever) beside it. No threshold. Every emoji badge has a
  text alternative (`<span role="img" aria-label="Weekly hosting streak: 3 weeks">`).

## Pages

- **PR 1, Leaderboard tab** (`/host/leaderboard`, hosts only; members do not
  see the tab): **This month** with month navigation (place, medal, host,
  events, streaks) and **Hall of fame** (all-time: lifetime events, medal
  tally, current and best streaks), as two views of one page.
- **PR 2, host profiles** (`/host/hosts/<meetupId>`, signed-in hosts only;
  names on the leaderboard link here): name, role badge (the Organizer badge
  from the parallel PR once merged), medals by month, streaks, lifetime events
  hosted and attendees hosted (sum of Meetup's YES + ATTENDED per counted
  event, the number Wrapped uses), event types (`classifyEventType`), recent
  events and all-time top events by attendance, linking to Meetup. **Only
  hosting activity already public on Meetup:** nothing a host attended, no
  no-show, suspension, ban or request data. A member id with no counted
  hosted events is a 404.
- **PR 3, maps** (profile map and Hall of fame map).

## Map (PR 3)

**Fields, verified 2026-11-18** against Meetup's schema (`/gql2` from Hai's
signed-in tab, read-only): `Venue { lat: Float, lon: Float, city, venueType,
name, address }` (note `lon`, not `lng`), `Event { isOnline: Boolean,
eventType: EventType }`. Neither is in the snapshot; PR 3 adds `isOnline`,
`eventType` and `venue { lat lon }` to the listing query (no extra request).

**Privacy:** online events (`isOnline` or `eventType = ONLINE`) and venues
without coordinates (or Meetup's 0,0 placeholder) are left out. Coordinates
are **rounded to a 0.01° grid (about 1 km) at ingest**; exact venue
coordinates are never stored, so no residential pin can be plotted. The map
shows grid cells sized by event count, with no venue names or addresses.

**Rendering, compared:**

1. _Self-hosted Leaflet 1.9 + OpenStreetMap tiles (recommended)._ Leaflet
   (about 40 KB) is served from our own origin under the page nonce; the CSP
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

## PR split

1. **Leaderboard tab:** host names table, medal tables and awarding, monthly
   ranking, Hall of fame, streak badges.
2. **Host profiles:** profile page and lifetime stats; leaderboard names link
   to it.
3. **Maps:** snapshot venue fields, profile map and Hall of fame map.
