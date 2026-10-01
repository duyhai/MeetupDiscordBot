# Identity change monitoring

Detect when a Discord member changes their photo or name, so organizers can
catch impersonation attempts.

## Problem

A member can change their avatar or nickname to resemble another member --
typically an organizer -- and use the resemblance to gain trust in DMs. Nothing
currently records that this happened. By the time someone reports it, the
impersonator has often reverted, leaving no evidence.

The group has 2,008 Discord members. Routine avatar and name changes are
ordinary behaviour and vastly outnumber abuse, so per-change alerting would
bury the signal it is meant to surface.

## Approach

Once a day, sweep every member and diff against a stored baseline; surface
whatever changed.

Discord already provides the thing a naive implementation would build by
hand: `user.avatar` and `member.avatar` are **content hashes**. Comparing the
stored string to the current one detects a photo change. No downloading or
hashing of image data is required.

Detection is sweep-only: one daily reconciliation pass re-reads every member
and records any difference against the stored baseline, marked
`source = sweep`.

The sweep performs its own member fetch rather than coupling to
`unlinkedDigest`. Sharing one pass would tie the two digests together so a
failure in either could suppress the other, and discord.js serves the second
fetch from its member cache, so the duplicate costs little.

Bots are excluded throughout. Members who leave keep their baseline row, so a
rejoin can be compared against who they were before; their change history is
never deleted.

**Accepted trade-off:** a daily snapshot diff cannot see a **transient**
change -- an avatar swapped at 14:00 and reverted by 18:00 looks identical at
both snapshots, so it is never detected. This is a deliberate choice, not an
oversight: the concern is durable state, not momentary swaps, and the paper
trail already covers attribution -- any DM or message sent during the window
still shows the sender's profile as it stood at that moment, in the message
itself and in Discord's own client. Gateway-event detection was considered and
rejected: it added a boot-time member-cache warm, a suppression mechanism to
keep the bot's own onboarding writes out of the digest, and a race between the
two, for a benefit (catching transient swaps) the owner does not need.

### Fields tracked

| Field | Source | Notes |
| --- | --- | --- |
| Global avatar | `user.avatar` | The obvious vector |
| Server avatar | `member.avatar` | Per-guild override; visible only here, so the stealthiest |
| Server nickname | `member.nickname` | The bot writes this itself (see below) |
| Username / global name | `user.username`, `user.globalName` | Discord rate-limits these; cheap to include |

### The bot's own writes

Onboarding sets a member's nickname to their Meetup name
(`onboardUserCommon`). Left alone, every onboarding would appear as a
suspicious name change once the sweep runs. The onboarding path advances the
baseline directly after setting the nickname, so the daily sweep diffs against
the nickname the bot just wrote rather than the one from before -- and never
reports the bot's own write as a change. Because detection is sweep-only,
there is no concurrent listener that could read the old baseline in between;
the race that a gateway-event design would need to guard against does not
exist here.

## Data model

Two tables.

`member_identity` -- current baseline, one row per member:

```
discord_user_id      TEXT PRIMARY KEY
username             TEXT
global_name          TEXT
nickname             TEXT
user_avatar_hash     TEXT
member_avatar_hash   TEXT
user_avatar_thumb    BYTEA              -- image behind user_avatar_hash
member_avatar_thumb  BYTEA              -- image behind member_avatar_hash
updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
```

The two BYTEA columns hold the 64px image behind the hash beside them, so a
change's *before* picture comes out of our own database rather than a CDN that
may have purged it. See Thumbnails below.

`member_identity_changes` -- append-only log, one row per field change:

```
id               BIGSERIAL PRIMARY KEY
discord_user_id  TEXT NOT NULL
field            TEXT NOT NULL      -- user_avatar | member_avatar | nickname | username | global_name
old_value        TEXT
new_value        TEXT
old_thumb        BYTEA              -- avatar fields only
new_thumb        BYTEA              -- avatar fields only
detected_at      TIMESTAMPTZ NOT NULL DEFAULT now()
source           TEXT NOT NULL      -- sweep | backfill
```

Index on `(detected_at)` for the digest and report ranges, and on
`(discord_user_id, detected_at)` for per-member history.

### Sizing

Measured against the live plan: essential-0, 1 GB, currently 7.99 MB used.

| | |
| --- | --- |
| Baseline | 2,008 rows x ~250 B = **~0.5 MB**, static |
| Baseline thumbnails | up to two per member, ~2-4 KB each: **~8-16 MB**, static |
| Change log, text only | ~200 B/row |
| Thumbnails | ~2-4 KB per image at 64px webp |

At an assumed 2-4 identity changes per member per year: 4-8k rows/year, so
roughly **1-2 MB/year** of text. Thumbnails apply only to avatar changes, at
two images per change: if half of all changes are avatar changes, that is
**~25-50 MB/year**. Both fit the 1 GB plan comfortably for well over a year.

That change rate is an assumption, not a measurement. The daily digest reports
the current row count and table size so the real rate is visible from day one
and retention can be revisited against actuals rather than this estimate.

### Retention

Keep at least one year; no automatic pruning in v1. At the sizes above,
pruning saves nothing worth the risk of destroying evidence. A prune helper
ships but stays unscheduled, so it is a deliberate act.

## Thumbnails

Discord's CDN resizes on request: appending `?size=64` to an avatar URL returns
a 64px image. The bot fetches that and stores the bytes directly.

This avoids adding an image library. `sharp` brings native binaries and `jimp`
is memory-hungry, and this dyno has a history of R14 memory exhaustion -- the
CDN doing the work sidesteps both.

Thumbnails matter because **Discord purges old avatar images**. The hash
records that a change happened, but the old image URL 404s sometime after the
user replaces it. A report from nine months ago would otherwise render a wall
of broken images, exactly when it is most needed. Storing the bytes makes
reports permanently viewable and independent of the CDN.

That purging is also why the **before-image comes from the baseline, not the
CDN**. Fetching the old hash at change time asks the CDN for the very image it
has just been told to replace — the request most likely to 404, and the one
whose loss matters most. So each baseline row carries the bytes behind its
hashes:

- A **first sighting** records no change, but fetches the member's current
  avatars and stores them. This is the only moment those URLs are known to
  resolve, and it is what makes a later change's before-image possible.
- A **change** reads the old side straight out of that row and fetches only
  the new image — one request, not two. The new image then becomes the
  baseline's thumb, so today's after-image is tomorrow's before-image.
- An **unchanged** avatar field keeps whatever the baseline already holds: a
  thumb column is written only when the caller supplies a value for it, so a
  nickname edit cannot discard an avatar image. An explicit NULL does clear
  it, because a thumb describes the hash stored beside it and a superseded
  image under a new hash would make the *next* change's before-image wrong
  rather than merely missing.

The cost is one-time: the backfill fetches a thumbnail per avatar-having
member (see the README's deployment notes), and steady-state sweeps fetch one
per changed avatar.

Thumbnail fetches are best-effort: a failure stores a NULL thumb and the change
is still recorded. Evidence of the change matters more than the picture.

## Surfaces

### Daily digest

Posts to the existing alerts channel, reusing `unlinkedDigest`'s scheduling
shape: an hourly tick that fires during `IDENTITY_DIGEST_UTC_HOUR` (18:00 UTC,
~10-11am Pacific), with an `exclusive_set` claim keyed by date guarding
against double-posts across dyno restarts. It runs as a separate digest under
its own cache key, so a failure in one does not suppress the other.

18:00 rather than the unlinked digest's 17:00: both make a full-guild member
pass, and running them in the same hour put two concurrent 2,008-member
fetches on a dyno with an R14 history.

The claim is taken *before* the sweep and released if any of the work fails,
so a restart mid-hour neither redoes a discarded full pass nor consumes the
day on a digest that never posted. The 24h window is anchored to the digest
hour rather than to the run time, so consecutive days are exactly contiguous
-- a `now - 24h` window would drift against the date-keyed claim and leave
changes in neither digest.

Compact text, one line per change:

```
Identity changes: 7 in the last 24h
14:02  @someone  server avatar changed
09:15  @someone_else  nickname  "Alex K." -> "Alex Kim"
...
Storage: 1,204 changes on record, 61 MB
```

There is no revert annotation: a same-day swap-and-revert is exactly the
transient change this design does not detect (see the accepted trade-off
above), so no change in this digest ever carries a revert marker.

### On-demand HTML report

`/meetup_identity_report [days]` -- gated to mods and organizers via the
existing `requireModOrOrganizer`, defaulting to 7 days. It generates a
**self-contained HTML file** and attaches it to an ephemeral reply using the
existing file-attachment wrapper, which already handles tmpfile cleanup.

No hosted page, no Express route, no separate authentication: the invoking
member is already authenticated by Discord and the role gate is already
written. The file works offline and can be archived as evidence.

Thumbnails embed as base64 `data:` URIs, so the file has no external
dependencies and renders identically in a year. The layout is a table, one row
per change, before and after images side by side.

The binding limit is the dyno, not Discord. The guild's tier-3 upload limit is
100 MB, but assembling such a file holds the rows, their base64 expansion, the
document string and `writeFileSync`'s copy at once -- roughly 3-4x the raw
bytes on a 512 MB dyno with an R14 history. The cap is therefore ~10 MB and
`days` is capped at 90.

The size check runs *before* the rows are fetched, as a `count(*)` /
`sum(octet_length(...))` aggregate that transfers no thumbnails: a guard that
measures what is already in memory fires after the damage. A refused range
names a concrete narrower window rather than only saying no.

## Rollout

1. Tables created, backfill populates the baseline for all members with
   `source = backfill` and **no** digest entries. Without this, day one reports
   2,008 changes.
2. The sweep begins recording.
3. Digest enabled after a day of accumulated data, so its first post is
   meaningful.

## Testing

Unit tests over pure functions: the diff between a baseline row and a current
member, digest formatting, HTML generation, and the size guard. Integration
tests cover the repository against real Postgres, following
`postgresMemberRepository`'s gated pattern.

## Out of scope

- Detecting *similarity* between avatars. Only exact hash changes are
  recorded. Two members with visually similar but not byte-identical photos
  will not be flagged; the digest surfaces changes for a human to judge.
- Automatic enforcement. No kicks, no role removal, no messaging the member.
- Monitoring members of other guilds, or Meetup-side profile changes.
