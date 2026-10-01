# Meetup-Side Identity Monitoring Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend identity monitoring to Meetup profiles, sharing one scope-keyed change log with the Discord side, and fix the defects an independent review found in the Discord branch while it is still unmerged.

**Architecture:** The identity change log gains `platform` and `scope_id` so a Discord guild and a Meetup group are distinct namespaces rather than a single global keyspace. A daily Meetup sweep, authenticated by an organizer refresh token seeded from Heroku config, feeds the same log through the same diff/thumbnail/record machinery the Discord side already uses. One digest and one HTML report cover both.

**Tech Stack:** TypeScript ESM (relative imports end in `.js`), discord.js 14 + discordx, `pg`, `graphql-request`, vitest, nock, Heroku Postgres essential-0.

**Spec:** `docs/superpowers/specs/2026-08-17-meetup-identity-monitoring-design.md`
**Prior spec (Discord side, context):** `docs/superpowers/specs/2026-08-16-identity-monitoring-design.md`

## Global Constraints

- TypeScript ESM: every relative import ends in `.js`, including in tests.
- **Nothing in this feature has deployed.** Schema changes are free edits, not migrations. Do not write migration code.
- Discord guild: 2,008 members. Meetup group: ~6,000 members. Postgres essential-0, 1 GB, 20 connections total.
- The identity pool drops to `max: 2` (the sweep is sequential and needs one). The member repository keeps `max: 5`.
- No new dependencies.
- Bots excluded from Discord tracking throughout.
- Members who leave keep their baseline and history; only `deleteMemberIdentity` removes a member, and nothing calls it automatically.
- `pruneChangesBefore` and `deleteMemberIdentity` must exist but must never be wired to a scheduler or automatic path.
- Thumbnails are best-effort: any failure stores `null` and the change is still recorded.
- Run `yarn lint` before every commit; a pre-commit hook runs `eslint --fix`.
- Mutation-test every new assertion: reintroduce the bug, confirm the test fails, restore. Report the ACTUAL result — if a mutation does not kill, say so plainly rather than adjusting the test until it looks right.

## File Structure

Identity helpers move into their own folder and shed the redundant prefix:

| Now | After |
| --- | --- |
| `src/lib/helpers/identityDiff.ts` | `src/lib/helpers/identity/diff.ts` |
| `src/lib/helpers/identitySnapshot.ts` | `src/lib/helpers/identity/snapshot.ts` |
| `src/lib/helpers/identityThumbs.ts` | `src/lib/helpers/identity/thumbs.ts` |
| `src/lib/helpers/identityMonitor.ts` | `src/lib/helpers/identity/monitor.ts` |
| `src/lib/helpers/identitySweep.ts` | `src/lib/helpers/identity/sweep.ts` |
| `src/lib/helpers/identityDigest.ts` | `src/lib/helpers/identity/digest.ts` |
| `src/lib/helpers/identityReport.ts` | `src/lib/helpers/identity/report.ts` |
| `src/lib/helpers/identitySuppression.ts` | `src/lib/helpers/identity/suppression.ts` |

Tests mirror the move under `tst/lib/helpers/identity/`. New Meetup files join the same folder: `identity/meetupSnapshot.ts`, `identity/meetupSweep.ts`.

**Phase boundary:** Tasks 1-4 leave the Discord side correct and shippable on the new scope-keyed schema. Tasks 5-9 add the Meetup side. Both phases end with a green suite, so the work can stop at task 4 if the Meetup credential turns out to be a problem.

---

### Task 1: Move identity helpers into a folder

Pure file move plus import rewrites. No behaviour change — a reviewer should see zero logic in the diff.

**Files:**
- Move: the eight `src/lib/helpers/identity*.ts` files listed above
- Move: the eight matching `tst/lib/helpers/identity*.test.ts` files
- Modify: every importer (`src/index.ts`, `src/events/identityEvents.ts`, `src/commands/meetup/identityReport.ts`, `src/lib/helpers/onboardUser.ts`, `tst/integration/*`)

**Interfaces:**
- Consumes: nothing.
- Produces: all existing exports at new paths. No symbol is renamed.

- [ ] **Step 1: Move the source files with git mv**

```bash
mkdir -p src/lib/helpers/identity tst/lib/helpers/identity
for n in diff snapshot thumbs monitor sweep digest report suppression; do
  cap=$(python3 -c "print('$n'.capitalize())")
  git mv "src/lib/helpers/identity${cap}.ts" "src/lib/helpers/identity/${n}.ts"
  git mv "tst/lib/helpers/identity${cap}.test.ts" "tst/lib/helpers/identity/${n}.test.ts"
done
git status --short
```

- [ ] **Step 2: Rewrite imports**

Every import of a moved file changes. Two shapes to fix:

1. **Between moved files** — they were siblings and still are, so `./identityDiff.js` becomes `./diff.js`.
2. **From outside** — `../lib/helpers/identityMonitor.js` becomes `../lib/helpers/identity/monitor.js`; from tests, `../../../src/lib/helpers/identityDiff.js` becomes `../../../../src/lib/helpers/identity/diff.js` (one extra `../`, because the test moved a level deeper).

Find every one:

```bash
grep -rn "helpers/identity[A-Z]\|from '\./identity[A-Z]" src/ tst/ scripts/
```

Fix them all, then confirm nothing is left:

```bash
grep -rn "helpers/identity[A-Z]" src/ tst/ scripts/ && echo "STILL BROKEN" || echo "clean"
```

- [ ] **Step 3: Verify no logic changed**

```bash
git diff --cached -M --stat
```

Expected: every source file shows as a rename with few or no content lines. A file showing substantial content change means something was edited by accident — investigate before continuing.

- [ ] **Step 4: Run the suites**

Run: `yarn lint && yarn test`
Expected: 188/188 pass. Nothing else may change.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "Group identity helpers into their own folder"
```

---

### Task 2: Scope-keyed identity types and repository

The schema rework. `platform` and `scope_id` join the key; `deleteMemberIdentity` arrives; the pool drops to 2.

**Files:**
- Modify: `src/lib/repositories/identityTypes.ts`
- Modify: `src/lib/repositories/postgresIdentityRepository.ts`
- Test: `tst/integration/postgresIdentityRepository.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces:
  - `type IdentityPlatform = 'discord' | 'meetup'`
  - `IdentitySnapshot` gains `scopeId: string`
  - `IdentityChange` gains `platform: IdentityPlatform` and `scopeId: string`
  - `IdentityChangeRecord`/`IdentityChangeMetadata` gain both
  - `getSnapshot(scopeId, discordUserId)`, `putSnapshot(snapshot)` (reads `scopeId` off the snapshot)
  - `recordChanges(changes, source, thumbs)` — thumbs keyed `` `${platform}:${scopeId}:${subjectId}:${field}` ``
  - `deleteMemberIdentity(platform, scopeId, subjectId): Promise<number>`

- [ ] **Step 1: Write the failing integration tests**

Add to `tst/integration/postgresIdentityRepository.test.ts`:

```ts
  it('keeps two guilds\' baselines for the same member apart', async () => {
    const userId = `discord-${crypto.randomUUID()}`;
    await repo.putSnapshot({
      scopeId: 'guild-a',
      discordUserId: userId,
      username: 'someone',
      globalName: 'Someone',
      nickname: 'In Guild A',
      userAvatarHash: 'aaa',
      memberAvatarHash: null,
    });
    await repo.putSnapshot({
      scopeId: 'guild-b',
      discordUserId: userId,
      username: 'someone',
      globalName: 'Someone',
      nickname: 'In Guild B',
      userAvatarHash: 'aaa',
      memberAvatarHash: null,
    });

    // Nickname and per-guild avatar are guild-scoped facts. A single global
    // key would make these two rows overwrite each other, and every sweep
    // would then report a nickname change that never happened.
    expect((await repo.getSnapshot('guild-a', userId))?.nickname).toBe(
      'In Guild A',
    );
    expect((await repo.getSnapshot('guild-b', userId))?.nickname).toBe(
      'In Guild B',
    );
  });

  it('erases one member without touching another', async () => {
    const mine = `discord-${crypto.randomUUID()}`;
    const theirs = `discord-${crypto.randomUUID()}`;
    for (const id of [mine, theirs]) {
      // eslint-disable-next-line no-await-in-loop
      await repo.recordChanges(
        [
          {
            platform: 'discord',
            scopeId: 'guild-a',
            subjectId: id,
            field: 'nickname',
            oldValue: 'A',
            newValue: 'B',
          },
        ],
        'event',
        new Map(),
      );
    }

    const removed = await repo.deleteMemberIdentity('discord', 'guild-a', mine);

    expect(removed).toBeGreaterThan(0);
    const remaining = await repo.listChangesBetween(
      new Date(Date.now() - 60_000),
      new Date(Date.now() + 60_000),
    );
    expect(remaining.some((r) => r.subjectId === mine)).toBe(false);
    expect(remaining.some((r) => r.subjectId === theirs)).toBe(true);
  });

  it('records platform and scope on every change', async () => {
    const id = `meetup-${crypto.randomUUID()}`;
    const start = new Date(Date.now() - 1000);
    await repo.recordChanges(
      [
        {
          platform: 'meetup',
          scopeId: '7595882',
          subjectId: id,
          field: 'photo',
          oldValue: 'p1',
          newValue: 'p2',
        },
      ],
      'sweep',
      new Map(),
    );

    const rows = await repo.listChangesBetween(start, new Date(Date.now() + 1000));
    const mine = rows.find((r) => r.subjectId === id);
    // The digest and report both filter on these; a NULL here silently drops
    // Meetup rows out of every surface.
    expect(mine?.platform).toBe('meetup');
    expect(mine?.scopeId).toBe('7595882');
  });
```

Every existing test in this file must also be updated to the new signatures — `putSnapshot` snapshots gain `scopeId`, `getSnapshot` takes two arguments, and change objects gain `platform` and `scopeId`.

- [ ] **Step 2: Run to verify failure**

Run: `yarn test:integration:docker`
Expected: FAIL — `getSnapshot` arity, missing `deleteMemberIdentity`, unknown columns.

- [ ] **Step 3: Rewrite the types**

In `src/lib/repositories/identityTypes.ts`:

```ts
export type IdentityPlatform = 'discord' | 'meetup';

export type IdentityField =
  | 'user_avatar'
  | 'member_avatar'
  | 'nickname'
  | 'username'
  | 'global_name'
  | 'photo'
  | 'name';

export interface IdentitySnapshot {
  scopeId: string;
  discordUserId: string;
  username: string | null;
  globalName: string | null;
  nickname: string | null;
  userAvatarHash: string | null;
  memberAvatarHash: string | null;
}

export interface IdentityChange {
  platform: IdentityPlatform;
  scopeId: string;
  subjectId: string;
  field: IdentityField;
  oldValue: string | null;
  newValue: string | null;
}
```

`IdentityChangeRecord` and `IdentityChangeMetadata` extend `IdentityChange` as before, keeping their existing `id`, `detectedAt`, `source` and (for the record) thumb fields.

`photo` and `name` are the Meetup fields; they are declared here so both platforms share one enum and one digest label map.

- [ ] **Step 4: Rewrite the schema and queries**

In `postgresIdentityRepository.ts`, replace `CREATE_TABLE_SQL`:

```sql
CREATE TABLE IF NOT EXISTS member_identity (
  scope_id           TEXT NOT NULL,
  discord_user_id    TEXT NOT NULL,
  username           TEXT,
  global_name        TEXT,
  nickname           TEXT,
  user_avatar_hash   TEXT,
  member_avatar_hash TEXT,
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (scope_id, discord_user_id)
);
CREATE TABLE IF NOT EXISTS member_identity_changes (
  id           BIGSERIAL PRIMARY KEY,
  platform     TEXT NOT NULL,
  scope_id     TEXT NOT NULL,
  subject_id   TEXT NOT NULL,
  field        TEXT NOT NULL,
  old_value    TEXT,
  new_value    TEXT,
  old_thumb    BYTEA,
  new_thumb    BYTEA,
  detected_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  source       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS member_identity_changes_detected_at_idx
  ON member_identity_changes (detected_at);
CREATE INDEX IF NOT EXISTS member_identity_changes_subject_idx
  ON member_identity_changes (platform, scope_id, subject_id, detected_at DESC);
```

Change the pool to `max: 2` and update its comment to say why: the member repository takes 5 of essential-0's 20, a deploy doubles both across overlapping dynos, and the backfill script opens its own pool.

`getSnapshot` takes `(scopeId, discordUserId)` and filters on both. `putSnapshot` inserts `scope_id` and conflicts on `(scope_id, discord_user_id)`. `recordChanges` writes `platform` and `scope_id`, and looks thumbs up by the four-part key. `toChangeRecord`/`toChangeMetadata` map both new columns.

Add:

```ts
  /**
   * Erases one member's identity history and baseline. Deliberately never
   * called automatically -- like pruneChangesBefore, using it is a considered
   * act, because this data is impersonation evidence.
   */
  async deleteMemberIdentity(
    platform: IdentityPlatform,
    scopeId: string,
    subjectId: string,
  ): Promise<number> {
    const changes = await this.pool.query(
      `DELETE FROM member_identity_changes
       WHERE platform = $1 AND scope_id = $2 AND subject_id = $3`,
      [platform, scopeId, subjectId],
    );
    if (platform === 'discord') {
      await this.pool.query(
        'DELETE FROM member_identity WHERE scope_id = $1 AND discord_user_id = $2',
        [scopeId, subjectId],
      );
    }
    return changes.rowCount ?? 0;
  }
```

- [ ] **Step 5: Run to verify pass**

Run: `yarn test:integration:docker`
Expected: PASS. If a stale table from an earlier run blocks the new schema, drop it — nothing has deployed, so no data matters:
`docker compose exec -T postgres psql -U postgres -d meetup_bot -c 'DROP TABLE IF EXISTS member_identity, member_identity_changes;'`

- [ ] **Step 6: Mutation-test**

- Drop `scope_id` from `getSnapshot`'s WHERE → the two-guilds test must fail.
- Drop the `subject_id` predicate from `deleteMemberIdentity` → the erasure test must fail.
- Hard-code `'discord'` for `platform` in `recordChanges` → the platform test must fail.

- [ ] **Step 7: Commit**

```bash
yarn lint
git add -A
git commit -m "Scope the identity key by platform and guild or group"
```

---

### Task 3: Thread scope through the Discord path, and pin write ordering

Every caller now supplies a scope. This closes M2 and adds the M3 test.

**Files:**
- Modify: `src/lib/helpers/identity/snapshot.ts`, `diff.ts`, `monitor.ts`, `sweep.ts`
- Modify: `src/events/identityEvents.ts`
- Test: the matching files under `tst/lib/helpers/identity/`, `tst/events/identityEvents.test.ts`

**Interfaces:**
- Consumes: Task 2's types.
- Produces:
  - `snapshotMember(member: GuildMember): IdentitySnapshot` — reads `member.guild.id` into `scopeId`
  - `diffIdentity(before, after): IdentityChange[]` — stamps `platform: 'discord'` and `scopeId` from `after`
  - `recordIdentityFor(member, source)` unchanged in signature
  - `runIdentitySweep(client, source)` unchanged in signature, but resolves the guild by `GUILD_ID`

- [ ] **Step 1: Write the failing tests**

In `tst/lib/helpers/identity/monitor.test.ts` — the M3 gap. This is the one the branch never had:

```ts
  it('records the change before advancing the baseline', async () => {
    const member = fakeMember({
      user: { username: 'someone', globalName: 'Someone', avatar: 'bbb', bot: false },
    });

    await recordIdentityFor(member, 'event');

    // Load-bearing and previously untested: swapping these two writes left
    // every test in the branch green. Crash between them in this order and
    // the next sweep re-records a harmless duplicate; reversed, the baseline
    // advances while the evidence is lost for good.
    expect(repo.recordChanges.mock.invocationCallOrder[0]).toBeLessThan(
      repo.putSnapshot.mock.invocationCallOrder[0],
    );
  });
```

In `tst/lib/helpers/identity/sweep.test.ts`:

```ts
  it('sweeps the configured guild, not whichever is first in cache', async () => {
    const client = fakeClientWithGuilds(['other-guild', GUILD_ID]);

    await runIdentitySweep(client, 'sweep');

    // guilds.first() is insertion-ordered and effectively arbitrary. Sweeping
    // the wrong guild would diff one guild's members against another guild's
    // baselines and report every nickname as changed.
    expect(vi.mocked(recordIdentityFor).mock.calls[0][0].guild.id).toBe(GUILD_ID);
  });
```

In `tst/events/identityEvents.test.ts`:

```ts
  it('records only the configured guild on userUpdate', async () => {
    const { client, handlers } = fakeClient(['other-guild', GUILD_ID]);
    registerIdentityEvents(client);

    await handlers.get('userUpdate')?.({ id: 'u1' }, { id: 'u1' });

    // Recording every cached guild writes two guilds' per-guild facts against
    // one member and produces permanent false nickname alerts.
    expect(recordIdentityFor).toHaveBeenCalledTimes(1);
    expect(vi.mocked(recordIdentityFor).mock.calls[0][0].guild.id).toBe(GUILD_ID);
  });
```

- [ ] **Step 2: Run to verify failure**

Run: `yarn vitest run tst/lib/helpers/identity tst/events`
Expected: FAIL — the ordering assertion fails (proving the gap was real), and the two scope tests fail.

- [ ] **Step 3: Implement**

`snapshot.ts` — add `scopeId: member.guild.id` to the returned snapshot.

`diff.ts` — each emitted change carries `platform: 'discord'` and `scopeId: after.scopeId`, and `subjectId` replaces `discordUserId`.

`monitor.ts` — `getSnapshot(after.scopeId, member.id)`. Leave the write order exactly as it is; the new test now pins it.

`sweep.ts` — replace `guilds.first()`:

```ts
  // Resolve the configured guild explicitly. guilds.first() is insertion-
  // ordered, so with a second guild present (test server, staging, a fork)
  // the sweep would diff one guild's members against another's baselines.
  const guild = await client.guilds.fetch(GUILD_ID);
```

`identityEvents.ts` — the `userUpdate` handler resolves only `GUILD_ID` instead of iterating the cache, and wraps its whole body in the try/catch rather than only the `recordIdentityFor` call.

- [ ] **Step 4: Run to verify pass**

Run: `yarn lint && yarn test`
Expected: all pass.

- [ ] **Step 5: Mutation-test**

- Swap `recordChanges` and `putSnapshot` in `monitor.ts` → the ordering test must fail. **This is the mutation that previously left all 188 tests green — confirm it now kills.**
- Restore `guilds.first()` in `sweep.ts` → the sweep scope test must fail.
- Restore cache iteration in `identityEvents.ts` → the event scope test must fail.

- [ ] **Step 6: Commit**

```bash
yarn lint
git add -A
git commit -m "Scope Discord identity tracking to the configured guild"
```

---

### Task 4: Bound the CDN fetch, and the small review fixes

M1 plus four smaller defects. Grouped because each is a few lines and they share one test run.

**Files:**
- Modify: `src/lib/helpers/identity/thumbs.ts`, `report.ts`, `digest.ts`
- Modify: `src/commands/meetup/identityReport.ts`
- Test: `tst/lib/helpers/identity/thumbs.test.ts`, `report.test.ts`

**Interfaces:**
- Consumes: Task 2's types.
- Produces: `IdentityReportError` (an `Error` subclass with `readonly alertHandled = true`) exported from `src/commands/meetup/identityReport.ts`.

- [ ] **Step 1: Write the failing tests**

In `thumbs.test.ts`:

```ts
  it('gives up on a stalled CDN instead of hanging', async () => {
    nock('https://cdn.discordapp.com')
      .get('/avatars/u1/aaa.webp')
      .query({ size: '64' })
      .delayConnection(10_000)
      .reply(200, Buffer.from([1, 2]));

    const thumbs = await fetchChangeThumbs(
      [
        {
          platform: 'discord',
          scopeId: 'g1',
          subjectId: 'u1',
          field: 'user_avatar',
          oldValue: 'aaa',
          newValue: null,
        },
      ],
      'g1',
    );

    // This fetch runs inside the digest AFTER the day-claim is taken. A stall
    // hangs the digest without throwing, so the catch never releases the
    // claim: no digest, no error, no retry until a restart.
    expect(thumbs.get('discord:g1:u1:user_avatar')?.oldThumb).toBeNull();
  }, 15_000);
```

In `report.test.ts`:

```ts
  it('does not throw on an unrecognised field from an older row', () => {
    const html = renderIdentityReport(
      [change({ field: 'legacy_field' as never, oldThumb: null, newThumb: null })],
      range,
    );

    // FIELD_LABELS lookup yields undefined, and this project builds without
    // strictNullChecks -- escapeHtml guarding only null would throw on
    // .replace and destroy the entire report.
    expect(html).toContain('<!doctype html>');
  });
```

- [ ] **Step 2: Run to verify failure**

Run: `yarn vitest run tst/lib/helpers/identity/thumbs.test.ts tst/lib/helpers/identity/report.test.ts`
Expected: the CDN test times out or hangs; the report test throws.

- [ ] **Step 3: Implement all five fixes**

`thumbs.ts` — bound the fetch:

```ts
// Undici applies no total-request deadline, and this runs inside the digest
// after the day-claim is taken: a stalled connection would hang the digest
// with no error and no retry. The existing catch turns a timeout into the
// documented best-effort null thumb.
const response = await fetch(url, { signal: AbortSignal.timeout(5_000) });
```

`report.ts` — widen the guard:

```ts
function escapeHtml(value: string | null | undefined): string {
  if (value === null || value === undefined) {
    return '—';
  }
```

`digest.ts` — replace the hard-coded `in the last 24h` in the title with the actual window, since `until` extends past the boundary when the sweep runs long:

```ts
    title: `Identity changes: ${changes.length} since ${since
      .toISOString()
      .slice(0, 16)
      .replace('T', ' ')} UTC`,
```

`src/commands/meetup/identityReport.ts` — stop alerting on ordinary user mistakes:

```ts
/**
 * A user-facing refusal (no database configured, range too wide). Marked
 * alertHandled so discordCommandWrapper does not post "command failed" to the
 * organizers' alerts channel: a mod asking for 90 days and being told to
 * narrow it is normal operation, not a fault.
 */
export class IdentityReportError extends Error {
  readonly alertHandled = true;
}
```

Throw `IdentityReportError` at the three existing `throw new Error(...)` sites in that handler.

- [ ] **Step 4: Run to verify pass**

Run: `yarn lint && yarn test`
Expected: all pass, CDN test completes in about 5 seconds rather than timing out.

- [ ] **Step 5: Mutation-test**

- Remove the `signal` → the stalled-CDN test must fail (hang or timeout).
- Revert `escapeHtml` to `value === null` only → the unrecognised-field test must fail.
- Change `IdentityReportError` back to plain `Error` → confirm by reading `discordCommandWrapper`: with `alertHandled` absent it posts a failure alert. Note in the report that no automated test covers this (no handler-level alert test exists) and that you verified it by inspection.

- [ ] **Step 6: Commit**

```bash
yarn lint
git add -A
git commit -m "Bound the CDN fetch and fix four review findings"
```

---

### Task 5: Meetup OAuth refresh and the credential store

The organizer credential: seeded from Heroku config, maintained in Postgres, surfaced through the existing token command.

**Files:**
- Modify: `src/lib/client/oauth/providers.ts`
- Create: `src/lib/repositories/postgresCredentialRepository.ts`
- Create: `src/util/credentialRepository.ts`
- Modify: `src/commands/meetup/getToken.ts`
- Modify: `src/configuration.ts`
- Test: `tst/lib/client/oauth/refresh.test.ts`, `tst/integration/postgresCredentialRepository.test.ts`

**Interfaces:**
- Consumes: `Tokens` from `src/lib/client/discord/types.js` (`{ accessToken, refreshToken?, expiresAt? }`).
- Produces:
  - `refreshMeetupToken(refreshToken: string): Promise<Tokens>`
  - `class PostgresCredentialRepository` with `static instance()`, `get(key): Promise<Tokens | undefined>`, `put(key, tokens): Promise<void>`, `clear(key): Promise<void>`
  - `ApplicationCredentialRepository(): Promise<PostgresCredentialRepository | undefined>`
  - `MEETUP_ORGANIZER_CREDENTIAL_KEY = 'meetup_organizer'`

- [ ] **Step 1: Write the failing tests**

`tst/lib/client/oauth/refresh.test.ts`:

```ts
import nock from 'nock';
import { afterEach, describe, expect, it } from 'vitest';

import { refreshMeetupToken } from '../../../../src/lib/client/oauth/providers.js';

afterEach(() => nock.cleanAll());

describe('refreshMeetupToken', () => {
  it('exchanges a refresh token for a new access token', async () => {
    nock('https://secure.meetup.com')
      .post('/oauth2/access', (body) => body.grant_type === 'refresh_token')
      .reply(200, {
        access_token: 'new-access',
        refresh_token: 'same-refresh',
        expires_in: 3600,
      });

    const tokens = await refreshMeetupToken('old-refresh');

    expect(tokens.accessToken).toBe('new-access');
    expect(tokens.expiresAt).toBeGreaterThan(Date.now());
  });

  it('surfaces the rotated refresh token when one comes back', async () => {
    nock('https://secure.meetup.com')
      .post('/oauth2/access')
      .reply(200, {
        access_token: 'new-access',
        refresh_token: 'ROTATED',
        expires_in: 3600,
      });

    // Whether Meetup rotates cannot be known without performing a refresh.
    // If it does and the new token is dropped, the next sweep authenticates
    // with a dead credential and monitoring stops.
    expect((await refreshMeetupToken('old')).refreshToken).toBe('ROTATED');
  });

  it('throws with the status when Meetup rejects the refresh', async () => {
    nock('https://secure.meetup.com').post('/oauth2/access').reply(400, 'invalid_grant');

    await expect(refreshMeetupToken('revoked')).rejects.toThrow(/400/);
  });
});
```

`tst/integration/postgresCredentialRepository.test.ts` mirrors the identity repository's gated shape (`describe.skipIf(!POSTGRES_AVAILABLE)`), covering: round-trip of a token set, overwrite rather than duplicate on repeated `put`, `undefined` for an absent key, and `clear` removing it.

- [ ] **Step 2: Run to verify failure**

Run: `yarn vitest run tst/lib/client/oauth/refresh.test.ts`
Expected: FAIL — `refreshMeetupToken is not a function`.

- [ ] **Step 3: Implement**

In `providers.ts`, beside the existing exchange (reuse its endpoint and client credentials):

```ts
/**
 * Exchanges a refresh token for a fresh access token. Meetup access tokens
 * expire after an hour, so anything that must run on a schedule -- the daily
 * Meetup sweep -- needs this rather than a stored access token.
 */
export async function refreshMeetupToken(refreshToken: string): Promise<Tokens> {
  const body = new URLSearchParams({
    client_id: Configuration.meetup.apiKey,
    client_secret: Configuration.meetup.apiSecret,
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
  });
  const response = await fetch('https://secure.meetup.com/oauth2/access', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!response.ok) {
    throw new Error(
      `Meetup token refresh failed: [${response.status}] ${await response.text()}`,
    );
  }
  const raw = (await response.json()) as APIAccessTokenResponse;
  return {
    accessToken: raw.access_token,
    // Providers differ on whether refresh tokens rotate. Carry back whatever
    // arrived so the caller can persist it; fall back to the one we sent.
    refreshToken: raw.refresh_token ?? refreshToken,
    expiresAt: Date.now() + raw.expires_in * 1000,
  };
}
```

`postgresCredentialRepository.ts` follows `postgresIdentityRepository`'s lazy-schema singleton shape exactly — including the `pool.on('error')` handler, `allowExitOnIdle: true`, and resetting `schemaEnsured` to `undefined` on failure so a boot-time blip is not permanent. Pool `max: 1`; this is read once per sweep.

```sql
CREATE TABLE IF NOT EXISTS oauth_credentials (
  key           TEXT PRIMARY KEY,
  access_token  TEXT NOT NULL,
  refresh_token TEXT NOT NULL,
  expires_at    TIMESTAMPTZ NOT NULL,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

`src/util/credentialRepository.ts` mirrors `identityRepository.ts`: returns `undefined` when `DATABASE_URL` is unset, warning once.

In `configuration.ts`, add `organizerRefreshToken: process.env.MEETUP_ORGANIZER_REFRESH_TOKEN` under `meetup`. Do **not** add it to `REQUIRED_VARS` — the bot must still start without it, with only Meetup monitoring disabled.

In `getToken.ts`, append the refresh token to the ephemeral reply, gated to organizers:

```ts
        const isOrganizer = await hasAnyServerRole(
          await interaction.guild.members.fetch(interaction.user.id),
          ['moderator', 'organizer'],
        );
        const refreshSection =
          isOrganizer && tokens.refreshToken
            ? [
                '',
                '🔁 **Refresh token** — long-lived, unlike the access token above.',
                'Set this as `MEETUP_ORGANIZER_REFRESH_TOKEN` in Heroku config to',
                'enable Meetup-side identity monitoring. Treat it as a password:',
                'it does not expire until revoked.',
                '```',
                tokens.refreshToken,
                '```',
              ]
            : [];
```

- [ ] **Step 4: Run to verify pass**

Run: `yarn lint && yarn test && yarn test:integration:docker`
Expected: all pass.

- [ ] **Step 5: Mutation-test**

- Return the sent `refreshToken` unconditionally instead of `raw.refresh_token ?? refreshToken` → the rotation test must fail.
- Drop the `response.ok` guard → the rejection test must fail.
- Remove the `isOrganizer` gate → note whether any test covers it; if none does, add one asserting a non-organizer's reply omits the refresh token, then confirm it kills.

- [ ] **Step 6: Commit**

```bash
yarn lint
git add -A
git commit -m "Add Meetup token refresh and the organizer credential store"
```

---

### Task 6: Meetup group membership query

The GraphQL query and client method the sweep reads from.

**Files:**
- Modify: `src/lib/client/meetup/queries.ts`, `src/lib/client/meetup/gqlClient.ts`, `src/lib/client/meetup/types.ts`
- Test: `tst/integration/meetupMemberships.wiring.test.ts`

**Interfaces:**
- Consumes: `getPaginatedData` from `src/lib/client/meetup/paginationHelper.js`, `PaginationInput`.
- Produces: `getGroupMemberships(input: PaginationInput)` on `GqlMeetupClient`, returning `{ groupByUrlname: { memberships: PaginatedData<MeetupGroupMember> } }` where

```ts
export interface MeetupGroupMember {
  id: string;
  name: string | null;
  username: string | null;
  memberPhoto: { id: string; thumbUrl: string } | null;
}
```

- [ ] **Step 1: Write the failing wiring test**

Guards what actually goes on the wire, following `tst/integration/getBadges.wiring.test.ts`:

```ts
  it('requests photo id and thumb url, paginated', async () => {
    const sent: string[] = [];
    nock('https://api.meetup.com')
      .post('/gql-ext')
      .times(2)
      .reply(200, (_uri, body) => {
        sent.push(JSON.stringify(body));
        return {
          data: {
            groupByUrlname: {
              memberships: {
                pageInfo: { hasNextPage: false, endCursor: null },
                edges: [
                  {
                    node: {
                      id: 'm1',
                      name: 'Jane D.',
                      username: 'janed',
                      memberPhoto: { id: 'p1', thumbUrl: 'https://x/p1.jpg' },
                    },
                  },
                ],
              },
            },
          },
        };
      });

    const client = new GqlMeetupClient('token');
    const result = await client.getGroupMemberships({ first: 100 });

    const all = sent.join('\n');
    // memberPhoto.id is the change signal -- without it the sweep can never
    // detect a photo change, only a name change.
    expect(all).toContain('memberPhoto');
    expect(all).toContain('thumbUrl');
    expect(result.groupByUrlname.memberships.edges[0].node.memberPhoto?.id).toBe('p1');
  });
```

- [ ] **Step 2: Run to verify failure**

Run: `yarn test:integration:docker`
Expected: FAIL — `getGroupMemberships is not a function`.

- [ ] **Step 3: Implement**

In `queries.ts`:

```ts
export const getGroupMemberships = gql`
  query ($urlname: String!, $first: Int, $after: String) {
    groupByUrlname(urlname: $urlname) {
      id
      memberships(first: $first, after: $after) {
        pageInfo {
          hasNextPage
          endCursor
        }
        edges {
          node {
            id
            name
            username
            memberPhoto {
              id
              thumbUrl
            }
          }
        }
      }
    }
  }
`;
```

Add `getGroupMemberships(input: PaginationInput)` to `GqlMeetupClient` following the shape of the existing `getGroupEvents` — same logging, same `Configuration.meetup.groupUrlName` variable. Do **not** cache it: `cachedClientRequest` would serve a stale roster and the sweep would compare today's baseline against yesterday's data.

- [ ] **Step 4: Run to verify pass**

Run: `yarn test:integration:docker`
Expected: PASS.

- [ ] **Step 5: Mutation-test**

- Remove `memberPhoto` from the query → the wiring test must fail.
- Wrap the call in `cachedClientRequest` → note that no test catches this; state it plainly in the report rather than adding a speculative test.

- [ ] **Step 6: Commit**

```bash
yarn lint
git add -A
git commit -m "Query Meetup group memberships with photo id and thumb url"
```

---

### Task 7: Meetup snapshot, diff and sweep

The Meetup analogue of the Discord detection path, reusing the shared change log.

**Files:**
- Create: `src/lib/helpers/identity/meetupSnapshot.ts`, `src/lib/helpers/identity/meetupSweep.ts`
- Test: `tst/lib/helpers/identity/meetupSnapshot.test.ts`, `meetupSweep.test.ts`

**Interfaces:**
- Consumes: `MeetupGroupMember` (Task 6), `IdentityChange` (Task 2), the identity repository, `fetchChangeThumbs`.
- Produces:
  - `interface MeetupSnapshot { scopeId: string; meetupMemberId: string; name: string | null; username: string | null; photoId: string | null; }`
  - `snapshotMeetupMember(member: MeetupGroupMember, scopeId: string): MeetupSnapshot`
  - `diffMeetupIdentity(before: MeetupSnapshot | undefined, after: MeetupSnapshot): IdentityChange[]`
  - `runMeetupSweep(source: ChangeSource, client?: Client): Promise<{ scanned: number; changed: number; }>`

The `client` is optional because the two callers differ: the digest has one and wants a credential failure alerted to the organizers' channel, while the backfill script runs standalone with no Discord connection and surfaces failure through its own non-zero exit. With no client the sweep logs the error instead of alerting.

The repository gains `getMeetupSnapshot(scopeId, memberId)`, `putMeetupSnapshot(snapshot)` against the `meetup_identity` table from the spec — add these in this task alongside their integration tests.

- [ ] **Step 1: Write the failing tests**

`meetupSnapshot.test.ts` covers: all fields read; a member with no photo yields `photoId: null`; an absent baseline yields no changes (the backfill property); a photo change emits `field: 'photo'` with `platform: 'meetup'` and the group's `scopeId`; a name change emits `field: 'name'`.

```ts
  it('emits no changes for a first sighting', () => {
    // Backfill: the first sighting IS the baseline. Otherwise enabling the
    // feature reports ~6,000 Meetup members as having changed.
    expect(diffMeetupIdentity(undefined, base)).toEqual([]);
  });

  it('stamps meetup platform and the group scope', () => {
    const out = diffMeetupIdentity(base, { ...base, photoId: 'p2' });

    expect(out).toEqual([
      {
        platform: 'meetup',
        scopeId: '7595882',
        subjectId: 'm1',
        field: 'photo',
        oldValue: 'p1',
        newValue: 'p2',
      },
    ]);
  });
```

`meetupSweep.test.ts` covers: every member scanned; `source` passed through; only changed members counted; one member throwing does not abandon the rest; and — the credential path —

```ts
  it('alerts and stops when the credential cannot be refreshed', async () => {
    vi.mocked(refreshMeetupToken).mockRejectedValue(new Error('invalid_grant'));

    await runMeetupSweep('sweep', fakeClient());

    // A silently dead sweep is the worst outcome: monitoring looks healthy
    // while watching nothing. This alert is the only way expiry is visible.
    expect(logAlert).toHaveBeenCalledTimes(1);
    const [, entry] = vi.mocked(logAlert).mock.calls[0];
    expect(entry.description).toContain('MEETUP_ORGANIZER_REFRESH_TOKEN');
  });
```

- [ ] **Step 2: Run to verify failure**

Run: `yarn vitest run tst/lib/helpers/identity/meetupSnapshot.test.ts tst/lib/helpers/identity/meetupSweep.test.ts`
Expected: FAIL — functions not defined.

- [ ] **Step 3: Implement**

`meetupSnapshot.ts` mirrors `snapshot.ts` and `diff.ts`, with a field map of `{ photo: 'photoId', name: 'name', username: 'username' }` and the same absent-baseline rule.

`meetupSweep.ts` resolves the credential, then walks the roster:

```ts
/**
 * Resolution order: the stored pair first, the Heroku config var as seed and
 * as the recovery path. Whatever refresh token comes back is persisted, so
 * rotation is absorbed whether or not Meetup rotates -- which cannot be
 * determined without performing a refresh.
 *
 * Returns undefined when there is no usable credential; the caller alerts.
 */
async function resolveOrganizerTokens(): Promise<Tokens | undefined> {
  const credentials = await ApplicationCredentialRepository();
  if (!credentials) {
    return undefined;
  }
  const stored = await credentials.get(MEETUP_ORGANIZER_CREDENTIAL_KEY);
  const seed = Configuration.meetup.organizerRefreshToken;

  const candidates = [stored?.refreshToken, seed].filter(
    (token): token is string => Boolean(token),
  );
  if (candidates.length === 0) {
    return undefined;
  }

  let lastError: unknown;
  for (const candidate of candidates) {
    try {
      // Sequential by intent: try the stored pair, and only fall back to the
      // config seed if it fails. Falling back is also how an organizer
      // recovers -- paste a fresh token into Heroku and the next sweep uses it.
      // eslint-disable-next-line no-await-in-loop
      const refreshed = await refreshMeetupToken(candidate);
      // eslint-disable-next-line no-await-in-loop
      await credentials.put(MEETUP_ORGANIZER_CREDENTIAL_KEY, refreshed);
      return refreshed;
    } catch (error: unknown) {
      lastError = error;
      logger.warn(`Meetup credential refresh failed: ${String(error)}`);
    }
  }
  logger.error(`No usable Meetup credential: ${String(lastError)}`);
  return undefined;
}
```

When that returns `undefined`, the sweep posts exactly one alert and stops:

```ts
  const tokens = await resolveOrganizerTokens();
  if (!tokens) {
    const remedy =
      'Could not obtain a Meetup organizer token, so the Meetup sweep was skipped. ' +
      'To fix: run `/meetup_get_token`, copy the refresh token, and set ' +
      '`MEETUP_ORGANIZER_REFRESH_TOKEN` in Heroku config.';
    // The only way credential expiry becomes visible. A sweep that fails
    // quietly leaves monitoring looking healthy while watching nothing, so
    // this fires on the first failure rather than after a retry streak.
    // The backfill script has no client and surfaces this through its exit
    // code instead.
    if (client) {
      await logAlert(client, {
        title: 'Meetup identity monitoring is not running',
        description: remedy,
      });
    } else {
      logger.error(remedy);
    }
    return { scanned: 0, changed: 0 };
  }
```

Members are then processed sequentially, each in its own try/catch, matching the Discord sweep's reasoning about the connection pool.

- [ ] **Step 4: Run to verify pass**

Run: `yarn lint && yarn test`
Expected: all pass.

- [ ] **Step 5: Mutation-test**

- Remove the `!before` early return → the first-sighting test must fail.
- Hard-code `platform: 'discord'` → the stamping test must fail.
- Swallow the refresh error without alerting → the credential test must fail.
- Remove the per-member try/catch → the continue-past-error test must fail.

- [ ] **Step 6: Commit**

```bash
yarn lint
git add -A
git commit -m "Add the Meetup identity sweep"
```

---

### Task 8: Both platforms in the digest and the report

One digest, one report, both platforms — the point of the shared change log.

**Files:**
- Modify: `src/lib/helpers/identity/digest.ts`, `report.ts`
- Test: `tst/lib/helpers/identity/digest.test.ts`, `report.test.ts`

**Interfaces:**
- Consumes: everything prior.
- Produces: `runIdentityDigestOnce` also runs `runMeetupSweep`; digest lines and report rows carry a platform label and resolve a Discord mention where a link exists.

- [ ] **Step 1: Write the failing tests**

```ts
  it('labels which platform each change came from', () => {
    const entry = formatIdentityDigest(
      [
        change({ platform: 'discord', subjectId: 'u1' }),
        change({ platform: 'meetup', subjectId: 'm1', field: 'photo' }),
      ],
      stats,
      new Map(),
    );

    // Without the label an organizer cannot tell which profile to go look at.
    expect(entry?.description).toContain('Discord');
    expect(entry?.description).toContain('Meetup');
  });

  it('names the linked Discord member for a Meetup change', () => {
    const entry = formatIdentityDigest(
      [change({ platform: 'meetup', subjectId: 'm1', field: 'photo' })],
      stats,
      new Map([['m1', 'u1']]),
    );

    // 'member m1 changed their photo' is unactionable; '@someone' is not.
    expect(entry?.description).toContain('<@u1>');
  });

  it('falls back to the raw Meetup id when no link exists', () => {
    const entry = formatIdentityDigest(
      [change({ platform: 'meetup', subjectId: 'm1', field: 'photo' })],
      stats,
      new Map(),
    );

    // Only 9 members are linked today, so this is the common case for now.
    expect(entry?.description).toContain('m1');
  });
```

Plus a report test asserting a Meetup row renders its thumbnails and platform column.

- [ ] **Step 2: Run to verify failure**

Run: `yarn vitest run tst/lib/helpers/identity/digest.test.ts`
Expected: FAIL — `formatIdentityDigest` takes two arguments.

- [ ] **Step 3: Implement**

`formatIdentityDigest(changes, stats, meetupToDiscord: Map<string, string>)` — the third argument maps Meetup member ids to Discord user ids, built in `runIdentityDigestOnce` from `ApplicationMemberRepository().listAll()`. Discord rows render `<@id>` as now; Meetup rows render the mention when mapped and the raw id otherwise, each prefixed with its platform.

`runIdentityDigestOnce` runs `runMeetupSweep('sweep', client)` after the Discord sweep, inside the same try so a failure releases the day-claim, and before the window's `until` is extended — so both sweeps' findings land in the same digest.

`report.ts` gains a Platform column and uses the same fallback for the member cell.

- [ ] **Step 4: Run to verify pass**

Run: `yarn lint && yarn test`
Expected: all pass.

- [ ] **Step 5: Mutation-test**

- Drop the platform prefix → the labelling test must fail.
- Ignore the map and always render the raw id → the mention test must fail.
- Render `<@undefined>` instead of the raw id when unmapped → the fallback test must fail.

- [ ] **Step 6: Commit**

```bash
yarn lint
git add -A
git commit -m "Surface both platforms in the digest and the report"
```

---

### Task 9: Meetup backfill script and documentation

**Files:**
- Create: `scripts/backfillMeetupIdentity.ts`
- Modify: `scripts/backfillIdentityBaseline.ts` (scope argument)
- Modify: `README.md`

**Interfaces:**
- Consumes: `runMeetupSweep`, `runIdentitySweep`.
- Produces: a runnable script; no exports.

- [ ] **Step 1: Write the script**

Mirrors `backfillIdentityBaseline.ts` but needs no Discord client — only `DATABASE_URL`, the Meetup credentials, and `MEETUP_ORGANIZER_REFRESH_TOKEN`. It calls `runMeetupSweep('backfill')` with no client, logs `scanned`/`changed`, and exits non-zero if `changed > 0`, because on a fresh table that means the silent-baseline rule is broken.

```ts
  const result = await runMeetupSweep('backfill');
  logger.info(
    `Meetup backfill complete: ${result.scanned} scanned, ${result.changed} changes recorded (expected 0 on a fresh table)`,
  );
  if (result.changed > 0) {
    logger.error(
      'Backfill recorded changes on what should be a fresh table -- do not proceed to the digest until this is understood.',
    );
    process.exit(1);
  }
```

- [ ] **Step 2: Verify the whole suite**

Run: `yarn lint && yarn test && yarn test:integration:docker`
Expected: all pass. Paste the real output into the report.

- [ ] **Step 3: Confirm wiring**

```bash
grep -n "registerIdentityEvents\|startIdentityDigestScheduler" src/index.ts
grep -n "runMeetupSweep" src/lib/helpers/identity/digest.ts
grep -rn "deleteMemberIdentity\|pruneChangesBefore" src/ --include="*.ts" | grep -v "repositories/"
```

Expected: the first two show an import and a call each; `runMeetupSweep` is called from the digest; the third returns **nothing** — both erasure helpers must have no automatic caller.

- [ ] **Step 4: Confirm the script fails cleanly without credentials**

Run: `yarn tsx scripts/backfillMeetupIdentity.ts`
Expected: a clear message about the missing token or database, not an import or type error. Do NOT run it against production.

- [ ] **Step 5: Update README.md**

Under Commands, note that `/meetup_get_token` shows organizers a refresh token. Under Deployment, add the ordered rollout from the spec — set `MEETUP_ORGANIZER_REFRESH_TOKEN`, run the Discord backfill, run the Meetup backfill, each confirming 0 changes — plus a line that the backfills open their own connection pools and should not run during a deploy.

- [ ] **Step 6: Commit**

```bash
yarn lint
git add -A
git commit -m "Add the Meetup backfill script and document the rollout"
```

---

## Post-merge rollout

Both branches merge to `main` together; the Discord side has deliberately not deployed so that one schema ships.

1. Merge and let Heroku deploy.
2. Run `/meetup_get_token`, copy the refresh token, set `MEETUP_ORGANIZER_REFRESH_TOKEN` in Heroku config.
3. Run the Discord backfill; confirm 0 changes recorded.
4. Run the Meetup backfill; confirm 0 changes recorded. This is also the first real proof the refresh flow works against Meetup rather than against assumptions about it.
5. Check `SELECT platform, count(*) FROM member_identity_changes GROUP BY platform;` — both should be 0 immediately after backfill.
6. Wait for the 18:00 UTC digest. Expect a plausible handful across both platforms, not thousands.
7. Run `/meetup_identity_report 1` and confirm the attachment opens with images and a Platform column.
