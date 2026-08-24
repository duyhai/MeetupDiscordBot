# Meetup-side identity monitoring

Extend identity monitoring to cover Meetup profiles, so a member's photo and
name are watched on both platforms through one digest and one report.

## Problem

The Discord-side feature (spec `2026-08-16-identity-monitoring-design.md`)
watches avatars and names inside the guild. But the group identifies people at
in-person events by their **Meetup** profile photo, and that is the photo an
impersonator would change. Watching only Discord leaves the platform that
actually matters unwatched.

The stated need is durable: members should keep a current, recognisable photo
of their face, and should not swap back to something unidentifiable. This is
about the state a profile is left in, not about momentary changes.

## Scope boundary

This detects **changes** to a photo. It cannot judge whether a photo shows a
face, or whether a new one is recognisable. That is image classification and a
different problem. What organizers get is "this member changed their photo,
here is before and after" for a human to judge.

## Approach

A daily sweep of the Meetup group's membership, diffed against a stored
baseline, feeding the change log the Discord side already writes to.

There is no event mechanism available: Meetup has no webhooks for profile
edits, so polling is the only option. That is no longer a gap relative to the
Discord side, either — both platforms are sweep-only. A daily snapshot
answers "is this person's photo still the one we know them by", which is the
question that matters: the concern is durable state, not momentary swaps.

### What the API provides

Confirmed by introspection against `https://api.meetup.com/gql-ext`:

- `Group.memberships(first, after, filter, sort): GroupMemberConnection`
- `GroupMemberEdge.node: Member`
- `Member { id name username memberPhoto: PhotoInfo }`
- `PhotoInfo { id baseUrl highResUrl standardUrl thumbUrl }`

`memberPhoto.id` is a stable identifier that changes when the photo changes —
the same role Discord's avatar hash plays, so the existing diff machinery
applies unchanged. `thumbUrl` supplies the stored thumbnail, matching the
Discord side's reason for storing bytes: the URL will not resolve forever.

`groupByUrlname` returns `null` unauthenticated, so every sweep needs a token.

### Fields tracked

| Field | Source | Notes |
| --- | --- | --- |
| Profile photo | `memberPhoto.id` | The vector that matters at events |
| Display name | `name` | How they appear on the RSVP list |
| Username | `username` | Rarely changed; free to include |

## The organizer credential

This is the significant new dependency, and the reason this is its own spec.

The bot holds only **transient** member tokens today: captured during
verification, used once, discarded. Reading the group's membership list
requires an organizer's token, held indefinitely.

`exchangeMeetupCode` in `src/lib/client/oauth/providers.ts` already returns
`{ accessToken, refreshToken, expiresAt }` — the refresh token is captured but
never used, because nothing currently outlives a single interaction.

**Seeded from Heroku config, maintained in Postgres.**

The obvious-looking approach — paste a token from `/meetup_get_token` into a
config var — fails on its own, because that command shows the **access**
token and Meetup expires those after `expires_in` (one hour). A daily sweep
would break before its second run. The **refresh** token is the long-lived
credential, and it is already captured at exchange
(`providers.ts:59`); it has simply never been surfaced or used, because
nothing in the bot previously outlived a single interaction.

So the seed is a refresh token in `MEETUP_ORGANIZER_REFRESH_TOKEN`, and the
bot mints access tokens from it automatically. Setting one config var is the
entire manual step.

The stored copy exists for one reason: some providers **rotate** refresh
tokens, returning a new one on each refresh and invalidating the old. Whether
Meetup does this cannot be determined without performing a refresh, so the
design must survive either behaviour rather than betting on one:

```
oauth_credentials
  key            TEXT PRIMARY KEY   -- 'meetup_organizer'
  access_token   TEXT NOT NULL
  refresh_token  TEXT NOT NULL
  expires_at     TIMESTAMPTZ NOT NULL
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
```

Resolution order on each sweep:

1. Use the stored pair if present and its refresh succeeds.
2. Otherwise seed from `MEETUP_ORGANIZER_REFRESH_TOKEN` and store the result.
3. Persist whatever refresh token comes back, so rotation is absorbed
   silently and the config var stays the recovery path rather than the
   live credential.

Pasting a fresh value into the config var is therefore also how an organizer
recovers from a revoked grant: clear the stored row, set the var, done.

**Refresh** adds `refreshMeetupToken(refreshToken)` beside the existing
exchange function. The sweep refreshes **unconditionally, once per sweep**,
and persists whatever pair comes back — it does not check `expires_at` first.

Recorded ruling: absorbing rotation is the design centre of this credential,
not an optimisation on top of it. A margin check makes the refresh
conditional on a stored timestamp, so the one path that discovers and stores
a rotated refresh token stops running exactly when the stored pair looks
healthy. It also makes a corrupt or absent `expires_at` — the value Meetup
supplies and may omit — decide whether the credential is maintained at all.
One extra token request per day is not a cost worth reasoning about; a
silently stale refresh token is a dead sweep.

Persisting is a **separate failure** from refreshing. If the store write
fails, the sweep proceeds on the tokens it just obtained and logs the
discrepancy: discarding a freshly-refreshed (and, under rotation, now
sole-valid) token because Postgres blipped would fall through to a seed
Meetup has already invalidated, and alert an organizer to a remedy that
cannot work.

**Obtaining the refresh token** extends `/meetup_get_token` to show it
alongside the access token, gated to organizers and sent ephemerally as the
access token already is. It is a materially longer-lived secret than what
that command shows today — an access token dies in an hour, this one lasts
until revoked — so the reply labels it as such rather than presenting the two
as equivalent.

**When refresh fails** — revoked access, organizer role lost, Meetup expiring
the grant — the sweep posts an alert naming the problem and telling the
organizer exactly how to recover: run `/meetup_get_token`, copy the refresh
token, update `MEETUP_ORGANIZER_REFRESH_TOKEN`. A silently dead sweep is the
worst outcome, because monitoring would appear healthy while watching nothing.

This alert is the only reason the credential's expiry is observable at all, so
it fires on the first failure rather than after a retry streak.

### Security posture

This is a real change. A token that can read the full membership of a
6,000-person group now sits in the bot's database. Worth stating plainly:

- It is stored in the same Postgres as the rest of the bot's data, with no
  additional encryption at rest beyond what Heroku provides.
- Anyone with database access can use it.
- It is scoped to whatever the granting organizer can see.
- Revocation is manual, from Meetup's application settings.

Accepted deliberately: the alternative (capturing photos only when a member
happens to re-verify) detects essentially nothing.

## Schema: one change log, two platforms

The Discord side's `member_identity_changes` keys its subject as
`discord_user_id`. A Meetup member may have no linked Discord account at all,
so that column has to generalise. Both tables are being changed **before the
Discord feature deploys**, so no migration of live evidence data is required —
this is a text edit now and would be an `ALTER TABLE` later.

### Three columns, not two

`platform` and `subject_id` are not sufficient. A Discord identity fact is
scoped to a **guild** — `nickname` and `member_avatar_hash` are per-guild by
definition — and a Meetup fact will be scoped to a **group**. `platform` says
which namespace an id lives in, not which instance of that namespace the fact
belongs to.

The Discord side already has this bug latent. `member_identity` is keyed on
`discord_user_id` alone while storing per-guild fields, and `identityEvents`
records the member from *every* guild in cache while `identitySweep` takes
`guilds.first()`. With one guild it is invisible. With two — a test server, a
staging guild, or the community-fork direction in `IDEAS.md` — the two guilds'
nicknames alternate into one row and emit a permanent stream of false
"nickname changed" alerts. Precisely the noise this feature exists to remove.

Generalising to `platform` + `subject_id` alone would rebuild that same bug on
the Meetup side the moment a second group exists, which is what franchising
means. So the key carries scope:

```
member_identity_changes
  id           BIGSERIAL PRIMARY KEY
  platform     TEXT NOT NULL        -- discord | meetup
  scope_id     TEXT NOT NULL        -- guild id | meetup group id
  subject_id   TEXT NOT NULL        -- discord user id | meetup member id
  field        TEXT NOT NULL
  old_value    TEXT
  new_value    TEXT
  old_thumb    BYTEA
  new_thumb    BYTEA
  detected_at  TIMESTAMPTZ NOT NULL DEFAULT now()
  source       TEXT NOT NULL        -- sweep | backfill
```

Baselines stay one table per platform, since nothing reads them together, but
both carry scope in the primary key:

```
member_identity
  scope_id             TEXT NOT NULL      -- guild id
  discord_user_id      TEXT NOT NULL
  username             TEXT
  global_name          TEXT
  nickname             TEXT
  user_avatar_hash     TEXT
  member_avatar_hash   TEXT
  user_avatar_thumb    BYTEA              -- image behind user_avatar_hash
  member_avatar_thumb  BYTEA              -- image behind member_avatar_hash
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
  PRIMARY KEY (scope_id, discord_user_id)

meetup_identity
  scope_id          TEXT NOT NULL      -- meetup group id
  meetup_member_id  TEXT NOT NULL
  name              TEXT
  username          TEXT
  photo_id          TEXT
  photo_thumb       BYTEA              -- image behind photo_id
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
  PRIMARY KEY (scope_id, meetup_member_id)
```

**Why the baselines carry images.** A change's *before* picture cannot be
fetched at change time. Discord purges a superseded avatar, and Meetup's
baseline stores a photo id rather than the URL that served it, so on the
Meetup side the old photo is unreachable the instant it changes — `old_thumb`
would be unconditionally NULL. Each baseline therefore keeps the bytes behind
the identifier beside it: captured at first sighting, handed to the change row
as its before-image, and replaced by the new image as the baseline advances.
Change time then costs exactly one fetch, for the new picture only.

The thumb columns stay nullable and best-effort. A column is only written when
the caller supplies a value for it, so a name-only change leaves the stored
image alone; an explicit NULL still clears it, because a thumb describes the
identifier stored next to it and a stale image under a new id is worse than no
image at all.

Both sweeps must therefore pass an explicit scope rather than iterating
whatever happens to be in cache. `GUILD_ID` already exists in `constants.ts`
and is currently unused on this path.

**Global facts under a scoped key.** Discord's `username`, `global_name` and
`user_avatar_hash` are account-wide, not per-guild, so under a scoped primary
key they duplicate across guilds. Accepted deliberately: it is what the code
already does, one row per (guild, member) stays simple to reason about, and
the duplication is invisible while there is one guild. The alternative —
splitting global-subject facts from scoped-subject facts into separate tables
— is correct but buys nothing until the bot is in several guilds, and can be
done then.

Unifying the change log is the point: one digest, one HTML report, one query
path. Two parallel features would mean two digests to read daily and two
reports per investigation.

### Linking the two sides

Where a Meetup member is linked to a Discord account, the digest and report
should say so — an organizer reading "member 404060606 changed their photo"
needs to know that is `@someone`. The existing `members` table already maps
`meetup_id` to `discord_user_id`, so the digest joins through it and falls
back to the raw Meetup id when no link exists.

## Sizing

The Meetup group is ~6,000 members against Discord's 2,008, so this roughly
quadruples the monitored population.

| | |
| --- | --- |
| Baseline | 6,000 rows x ~250 B = **~1.5 MB**, static |
| Baseline thumbnails | ~2-4 KB each, one per Meetup member and up to two per Discord member: across both platforms' ~8,000 baseline rows, **~25-35 MB**, static |
| Change log | ~200 B/row, shared table |
| Thumbnails | ~2-4 KB each, avatar changes only |

Against essential-0's 1 GB with 8 MB used, comfortable. Baseline thumbnails are
a one-time static cost that does not grow with time — the row is overwritten,
not appended to — so they shift the floor once rather than the slope. The daily
digest already reports row count and table size, so growth stays observable.

Request volume: `memberships` paginated at 100 per page is ~60 requests per
sweep, once a day. Sequential, matching the Discord sweep's reasoning about
the 2-connection pool.

Thumbnail requests are the new cost. A steady-state sweep fetches one image per
*changed* photo, a handful a day. A backfill fetches one per member with a
photo — ~6,000 on Meetup and up to two each for the Discord members who have an
avatar — sequential and bounded at 5s apiece, so it runs for tens of minutes
rather than seconds. That is a one-time price for every later change having a
real before-image.

## Failure behaviour

Consistent with the Discord side:

- One member failing does not abandon the sweep.
- Thumbnail fetches are best-effort; a failure stores NULL and the change is
  still recorded.
- Changes are written before the baseline advances, so a crash yields a
  duplicate row rather than lost evidence.
- A first sighting stores a baseline silently and records no change, so
  enabling the feature does not report 6,000 members as changed. It does
  fetch the member's current photo into that baseline — the one moment the
  photo's URL is in hand — and a failure there stores NULL like any other.
- The systemic-change thumb cap governs change-time fetches only. It counts
  members that changed, and a first sighting changes nothing, so it cannot
  fire during a backfill — whose fetches are the entire point.

New to this side: an expired or revoked credential alerts rather than failing
quietly, per above.

## Rollout

Because the Discord feature has not deployed, both ship together with one
schema.

1. Merge the Discord branch and this one to `main` together.
2. Run `/meetup_get_token`, copy the refresh token, set
   `MEETUP_ORGANIZER_REFRESH_TOKEN` in Heroku config.
3. Run the Discord backfill; confirm 0 changes recorded.
4. Run the Meetup backfill; confirm 0 changes recorded.
5. Wait for the first 18:00 UTC digest and confirm a plausible handful of
   changes across both platforms, not thousands.

Step 2 must precede step 4: the Meetup backfill is the first thing that needs
the credential, and it is also the first real proof the refresh flow works
against Meetup rather than against assumptions about it.

## Discord-side fixes folded in

An independent review of the Discord branch surfaced defects that are cheaper
to fix in the same pass, since that branch is deliberately unmerged. They ship
with this work:

- **Unbounded CDN fetch.** `identityThumbs` calls `fetch(url)` with no
  `AbortSignal`. Undici imposes no total-request deadline, and that call sits
  inside the digest *after* the day-claim is taken — so a stalled connection
  hangs the digest without throwing, the catch never releases the claim, and
  the result is no digest, no error and no retry. An
  `AbortSignal.timeout(5_000)` degrades it to the documented best-effort null
  thumb.
- **Write ordering is documented but untested.** Swapping `recordChanges` and
  `putSnapshot` in `identityMonitor` leaves all 188 tests green — verified.
  The invariant carrying the longest rationale comment in the branch is the
  one a refactor could silently invert. Pin it with `invocationCallOrder`.
- **`escapeHtml` guards `null` but not `undefined`**, and the project builds
  without `strictNullChecks`. An unrecognised `field` on an older row throws
  and destroys the whole report.
- **The report command throws plain `Error`s**, so `discordCommandWrapper`
  posts "command failed" to the alerts channel when a mod merely asks for too
  wide a range. Set `alertHandled`, as `DuplicateMeetupAccountError` already
  does.
- **The digest covers a range of change ids, not a time window.** The
  original design anchored `since` to the fixed digest hour and extended
  `until` to whenever the sweeps finished. That is not a window at all: the
  span `[boundary, sweep-finish]` falls inside two consecutive digests, and
  since Meetup rows are 100% sweep-detected they land squarely in it, so
  every Meetup change is reported twice. Pulling `until` back to the boundary
  only trades the duplication for a permanent gap — the sweeps' own findings,
  the changes least likely to be caught any other way, would fall out of both.

  Coverage is therefore tracked as a **high-water mark on
  `member_identity_changes.id`**, the table's existing `BIGSERIAL`:

  - The mark is the id of the last change already reported.
  - Each run fixes a ceiling with `max(id)` **after** the sweeps (so their
    findings are included) and **before** reading the rows (so a change
    recorded mid-digest is not skipped — it waits for tomorrow).
  - The digest reports `id > mark AND id <= ceiling`, ordered by id, then
    advances the mark to that ceiling — and only after the post is confirmed
    landed, so an undelivered digest is retried rather than lost. Rows that
    don't fit inside the embed's character limit are truncated with a count,
    and since the mark still advances past them, `/meetup_identity_report` is
    the only place they are ever shown.
  - The first run has no mark, so it translates the hour-anchored boundary
    into a starting id once. Without that the first digest after deploy would
    report the entire backfill as today's news.

  Consecutive runs are then exactly contiguous by construction, with no
  reliance on the dyno and Postgres clocks agreeing — which also disposes of
  the clock-skew question separately.

  The mark lives in Postgres (`identity_digest_state`), not the cache: both
  cache backends expire entries well inside the 24 hours between digests, so
  a cached mark would be missing every time it was needed.

  The digest title states the actual span of the rows it contains, since
  there is no longer a nominal window to quote.
- **Connection budget.** This pool's `max: 3` plus the member repository's
  `max: 5` is 8 per dyno, 16 across a deploy's dyno overlap, against
  essential-0's 20 — and the backfill script opens its own pool of 3, reaching
  19. Drop this pool to 2 (the sweep is sequential and needs one) and document
  running the backfill outside a deploy window.

## Per-member erasure

`pruneChangesBefore` is time-based, and a departing member's history is kept
deliberately so a rejoin can be compared. Neither provides a way to erase one
member's record on request.

A `deleteMemberIdentity(platform, scopeId, subjectId)` ships alongside it, in
the same deliberately-unscheduled shape: it exists, nothing calls it
automatically, and using it is a considered act. Whether members are told
their identity history is recorded is a community-governance decision, not a
code one, and is left to the organizers.

## Out of scope

- Judging whether a photo shows a face, or comparing two photos for
  similarity. Only exact `photo_id` changes are recorded.
- Monitoring Meetup members who are not in the group.
- Any automatic enforcement. No messaging, no removal.
- Backfilling historical Meetup photo changes: the API exposes only current
  state, so history starts at the backfill.
