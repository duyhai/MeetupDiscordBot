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

Record every identity change as it happens; surface them once a day.

Discord already provides the two things a naive implementation would build by
hand:

- `user.avatar` and `member.avatar` are **content hashes**. Comparing the
  stored string to the current one detects a photo change. No downloading or
  hashing of image data is required.
- `userUpdate` and `guildMemberUpdate` **gateway events** push changes the
  moment they occur. The bot already holds the `GuildMembers` intent, so no
  polling is required to detect a change.

Events alone are not sufficient: the bot misses everything that happens while
it is restarting, which occurs on every deploy and on Heroku's daily dyno
cycling. A daily reconciliation sweep re-reads every member and records any
difference the events missed, marked `source = sweep`.

The sweep performs its own member fetch rather than coupling to
`unlinkedDigest`. Sharing one pass would tie the two digests together so a
failure in either could suppress the other, and discord.js serves the second
fetch from its member cache, so the duplicate costs little. A change recorded
by an event is not re-recorded by the sweep, because the sweep compares
against the baseline the event already updated.

Bots are excluded throughout. Members who leave keep their baseline row, so a
rejoin can be compared against who they were before; their change history is
never deleted.

Events are the primary mechanism rather than a nicety. A daily snapshot diff
cannot see a **transient** change -- an avatar swapped at 14:00 and reverted by
18:00 looks identical at both snapshots. That is precisely the abuse pattern
worth catching, so detection must be event-driven.

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
suspicious name change. The onboarding path updates the baseline directly
after setting the nickname, so its own writes never register as changes.

Updating the baseline afterwards is not sufficient on its own: Discord
dispatches `GUILD_MEMBER_UPDATE` concurrently with the HTTP response to
`setNickname`, so the event handler can read the old baseline before the new
one commits. Onboarding therefore marks the member in a short-TTL suppression
set *before* the write, and lifts it a few seconds after. While a member is
marked, the event path advances their baseline but records no change.

## Data model

Two tables.

`member_identity` -- current baseline, one row per member:

```
discord_user_id     TEXT PRIMARY KEY
username            TEXT
global_name         TEXT
nickname            TEXT
user_avatar_hash    TEXT
member_avatar_hash  TEXT
updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
```

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
source           TEXT NOT NULL      -- event | sweep | backfill
```

Index on `(detected_at)` for the digest and report ranges, and on
`(discord_user_id, detected_at)` for per-member history.

### Sizing

Measured against the live plan: essential-0, 1 GB, currently 7.99 MB used.

| | |
| --- | --- |
| Baseline | 2,008 rows x ~250 B = **~0.5 MB**, static |
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

Thumbnail fetches are best-effort: a failure stores a NULL thumb and the change
is still recorded. Evidence of the change matters more than the picture.

## Surfaces

### Daily digest

Posts to the existing alerts channel, reusing `unlinkedDigest`'s scheduling
shape: an hourly tick that fires during `DIGEST_UTC_HOUR` (17:00 UTC, ~9-10am
Pacific), with an `exclusive_set` claim keyed by date guarding against
double-posts across dyno restarts. It runs as a separate digest under its own
cache key, so a failure in one does not suppress the other.

Compact text, one line per change:

```
Identity changes: 7 in the last 24h
14:02  @someone  server avatar changed  (reverted 18:31)
09:15  @someone_else  nickname  "Alex K." -> "Alex Kim"
...
Storage: 1,204 changes on record, 61 MB
```

Reverts are detected by comparing a change's new value against the same
member's previous value for that field, and annotated inline -- a change that
reverted within hours is more suspicious than one that stuck.

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

At ~2-4 KB per thumbnail, base64 inflating by a third, the guild's tier-3
100 MB upload limit accommodates roughly a year of changes in one file. The
command refuses ranges that would exceed the limit and suggests a narrower
window rather than producing a file Discord will reject.

## Rollout

1. Tables created, backfill populates the baseline for all members with
   `source = backfill` and **no** digest entries. Without this, day one reports
   2,008 changes.
2. Event handlers and the sweep begin recording.
3. Digest enabled after a day of accumulated data, so its first post is
   meaningful.

## Testing

Unit tests over pure functions: the diff between a baseline row and a current
member, revert detection, digest formatting, HTML generation, and the size
guard. Integration tests cover the repository against real Postgres, following
`postgresMemberRepository`'s gated pattern.

The event path gets a wiring test asserting the handler is registered and
writes a row -- a previous release shipped a correct helper that nothing
called, and only a call-site test catches that.

## Out of scope

- Detecting *similarity* between avatars. Only exact hash changes are
  recorded. Two members with visually similar but not byte-identical photos
  will not be flagged; the digest surfaces changes for a human to judge.
- Automatic enforcement. No kicks, no role removal, no messaging the member.
- Monitoring members of other guilds, or Meetup-side profile changes.
