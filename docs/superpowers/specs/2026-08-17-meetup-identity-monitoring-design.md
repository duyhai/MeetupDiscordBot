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
edits, so polling is the only option. That is acceptable here because the
concern is durable state — a daily snapshot answers "is this person's photo
still the one we know them by".

Note the asymmetry with the Discord side, which is event-driven precisely
because it also catches transient swap-and-revert. Meetup cannot offer that,
and does not need to.

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

**Storage: Postgres, not Redis and not Heroku config.** The token is rewritten
on every refresh, which rules out Heroku config without an API call per
refresh. It must survive months and every restart, which rules out a cache.

```
oauth_credentials
  key            TEXT PRIMARY KEY   -- 'meetup_organizer'
  access_token   TEXT NOT NULL
  refresh_token  TEXT NOT NULL
  expires_at     TIMESTAMPTZ NOT NULL
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
```

**Bootstrap** is a one-time organizer-only slash command that runs the normal
OAuth flow and writes the result to that row, rather than a script needing
credentials pasted on a command line.

**Refresh** adds `refreshMeetupToken(refreshToken)` beside the existing
exchange function. The sweep refreshes when `expires_at` is within a margin,
and persists the new pair.

**When refresh fails** — revoked access, organizer role lost, Meetup expiring
the grant — the sweep must post an alert naming the problem and asking an
organizer to re-run the bootstrap. A silently dead sweep is the worst outcome:
monitoring would appear healthy while watching nothing.

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

`member_identity_changes` becomes:

```
id            BIGSERIAL PRIMARY KEY
platform      TEXT NOT NULL        -- discord | meetup
subject_id    TEXT NOT NULL        -- discord user id, or meetup member id
field         TEXT NOT NULL
old_value     TEXT
new_value     TEXT
old_thumb     BYTEA
new_thumb     BYTEA
detected_at   TIMESTAMPTZ NOT NULL DEFAULT now()
source        TEXT NOT NULL        -- event | sweep | backfill
```

Baselines stay separate, because nothing reads them together and a composite
primary key buys nothing:

```
meetup_identity
  meetup_member_id  TEXT PRIMARY KEY
  name              TEXT
  username          TEXT
  photo_id          TEXT
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
```

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
| Change log | ~200 B/row, shared table |
| Thumbnails | ~2-4 KB each, avatar changes only |

Against essential-0's 1 GB with 8 MB used, comfortable. The daily digest
already reports row count and table size, so growth stays observable.

Request volume: `memberships` paginated at 100 per page is ~60 requests per
sweep, once a day. Sequential, matching the Discord sweep's reasoning about
the 3-connection pool.

## Failure behaviour

Consistent with the Discord side:

- One member failing does not abandon the sweep.
- Thumbnail fetches are best-effort; a failure stores NULL and the change is
  still recorded.
- Changes are written before the baseline advances, so a crash yields a
  duplicate row rather than lost evidence.
- A first sighting stores a baseline silently and records no change, so
  enabling the feature does not report 6,000 members as changed.

New to this side: an expired or revoked credential alerts rather than failing
quietly, per above.

## Rollout

Because the Discord feature has not deployed, both ship together with one
schema.

1. Merge the Discord branch and this one to `main` together.
2. Run the bootstrap command to capture the organizer token.
3. Run the Discord backfill; confirm 0 changes recorded.
4. Run the Meetup backfill; confirm 0 changes recorded.
5. Wait for the first 18:00 UTC digest and confirm a plausible handful of
   changes across both platforms, not thousands.

## Out of scope

- Judging whether a photo shows a face, or comparing two photos for
  similarity. Only exact `photo_id` changes are recorded.
- Monitoring Meetup members who are not in the group.
- Any automatic enforcement. No messaging, no removal.
- Backfilling historical Meetup photo changes: the API exposes only current
  state, so history starts at the backfill.
