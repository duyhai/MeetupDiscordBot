# Identity Change Monitoring Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Record every Discord avatar and name change so organizers can catch impersonation, surfaced as a daily digest and an on-demand HTML report.

**Architecture:** Gateway events (`userUpdate`, `guildMemberUpdate`) write changes to an append-only Postgres log the moment they occur; a daily sweep reconciles anything missed while the dyno was down. A baseline table holds each member's current identity. Avatar thumbnails are fetched pre-sized from Discord's CDN and stored as bytes so reports stay viewable after Discord purges the originals.

**Tech Stack:** TypeScript ESM (relative imports end in `.js`), discord.js 14 + discordx decorators, `pg`, vitest, Heroku Postgres essential-0.

**Spec:** `docs/superpowers/specs/2026-08-16-identity-monitoring-design.md`

## Global Constraints

- TypeScript ESM: every relative import ends in `.js`, including in tests.
- Guild has 2,008 members; Postgres is essential-0 (1 GB, 7.99 MB used).
- Bots are excluded from all tracking.
- Members who leave keep their baseline row and their full change history.
- No automatic pruning ships scheduled. A prune helper exists but is never called on a timer.
- Thumbnails come from Discord's CDN with `?size=64`. Do NOT add `sharp`, `jimp`, or any image library — this dyno has a history of R14 memory exhaustion.
- Thumbnail fetches are best-effort: on failure store `null` and still record the change.
- Digest posts via `logAlert` to the existing alerts channel.
- Guild is boost tier 3: Discord upload limit is 100 MB.
- Run `yarn lint` before every commit; a pre-commit hook runs `eslint --fix`.
- Every assertion must be mutation-tested: reintroduce the bug, confirm the test fails, restore.

---

### Task 1: Identity types and the diff function

The pure comparison at the core of both detection paths. No I/O.

**Files:**
- Create: `src/lib/repositories/identityTypes.ts`
- Create: `src/lib/helpers/identityDiff.ts`
- Test: `tst/lib/helpers/identityDiff.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `type IdentityField = 'user_avatar' | 'member_avatar' | 'nickname' | 'username' | 'global_name'`
  - `interface IdentitySnapshot { discordUserId: string; username: string | null; globalName: string | null; nickname: string | null; userAvatarHash: string | null; memberAvatarHash: string | null; }`
  - `interface IdentityChange { discordUserId: string; field: IdentityField; oldValue: string | null; newValue: string | null; }`
  - `function diffIdentity(before: IdentitySnapshot | undefined, after: IdentitySnapshot): IdentityChange[]`

- [ ] **Step 1: Write the failing test**

```ts
// tst/lib/helpers/identityDiff.test.ts
import { describe, expect, it } from 'vitest';

import { diffIdentity } from '../../../src/lib/helpers/identityDiff.js';
import { IdentitySnapshot } from '../../../src/lib/repositories/identityTypes.js';

const base: IdentitySnapshot = {
  discordUserId: 'u1',
  username: 'someone',
  globalName: 'Someone',
  nickname: 'Some One',
  userAvatarHash: 'aaa',
  memberAvatarHash: null,
};

describe('diffIdentity', () => {
  it('reports nothing when nothing changed', () => {
    expect(diffIdentity(base, { ...base })).toEqual([]);
  });

  it('reports one change per changed field', () => {
    const after = { ...base, userAvatarHash: 'bbb', nickname: 'Someone Else' };

    expect(diffIdentity(base, after)).toEqual(
      expect.arrayContaining([
        {
          discordUserId: 'u1',
          field: 'user_avatar',
          oldValue: 'aaa',
          newValue: 'bbb',
        },
        {
          discordUserId: 'u1',
          field: 'nickname',
          oldValue: 'Some One',
          newValue: 'Someone Else',
        },
      ]),
    );
    expect(diffIdentity(base, after)).toHaveLength(2);
  });

  it('treats setting a server avatar as a change from null', () => {
    const after = { ...base, memberAvatarHash: 'ccc' };

    expect(diffIdentity(base, after)).toEqual([
      {
        discordUserId: 'u1',
        field: 'member_avatar',
        oldValue: null,
        newValue: 'ccc',
      },
    ]);
  });

  it('treats clearing a nickname as a change to null', () => {
    const after = { ...base, nickname: null };

    expect(diffIdentity(base, after)).toEqual([
      {
        discordUserId: 'u1',
        field: 'nickname',
        oldValue: 'Some One',
        newValue: null,
      },
    ]);
  });

  it('reports no changes for a member with no baseline yet', () => {
    // Backfill path: a first sighting is the baseline, not 5 changes. Without
    // this, enabling the feature reports 2,008 members as having "changed".
    expect(diffIdentity(undefined, base)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn vitest run tst/lib/helpers/identityDiff.test.ts`
Expected: FAIL — `diffIdentity is not a function`

- [ ] **Step 3: Write minimal implementation**

```ts
// src/lib/repositories/identityTypes.ts
export type IdentityField =
  | 'user_avatar'
  | 'member_avatar'
  | 'nickname'
  | 'username'
  | 'global_name';

export interface IdentitySnapshot {
  discordUserId: string;
  username: string | null;
  globalName: string | null;
  nickname: string | null;
  userAvatarHash: string | null;
  memberAvatarHash: string | null;
}

export interface IdentityChange {
  discordUserId: string;
  field: IdentityField;
  oldValue: string | null;
  newValue: string | null;
}

export type ChangeSource = 'event' | 'sweep' | 'backfill';

export interface IdentityChangeRecord extends IdentityChange {
  id: string;
  detectedAt: Date;
  source: ChangeSource;
  oldThumb: Buffer | null;
  newThumb: Buffer | null;
}
```

```ts
// src/lib/helpers/identityDiff.ts
import {
  IdentityChange,
  IdentityField,
  IdentitySnapshot,
} from '../repositories/identityTypes.js';

const FIELDS: { field: IdentityField; key: keyof IdentitySnapshot }[] = [
  { field: 'user_avatar', key: 'userAvatarHash' },
  { field: 'member_avatar', key: 'memberAvatarHash' },
  { field: 'nickname', key: 'nickname' },
  { field: 'username', key: 'username' },
  { field: 'global_name', key: 'globalName' },
];

/**
 * Field-by-field comparison of a stored baseline against a current snapshot.
 *
 * An absent baseline yields no changes: the first sighting of a member IS the
 * baseline. Reporting it as a change would make enabling the feature announce
 * every member in the guild as having changed identity.
 */
export function diffIdentity(
  before: IdentitySnapshot | undefined,
  after: IdentitySnapshot,
): IdentityChange[] {
  if (!before) {
    return [];
  }
  return FIELDS.filter(({ key }) => before[key] !== after[key]).map(
    ({ field, key }) => ({
      discordUserId: after.discordUserId,
      field,
      oldValue: (before[key] as string | null) ?? null,
      newValue: (after[key] as string | null) ?? null,
    }),
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `yarn vitest run tst/lib/helpers/identityDiff.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: Mutation-test each assertion**

Confirm each test fails when the bug is reintroduced, then restore:
- Change `if (!before)` to `if (false)` → the no-baseline test must fail.
- Change the filter to `!==` on a fixed field only → the multi-field test must fail.
- Remove `?? null` → the clearing-nickname test must fail.

- [ ] **Step 6: Commit**

```bash
yarn lint
git add src/lib/repositories/identityTypes.ts src/lib/helpers/identityDiff.ts tst/lib/helpers/identityDiff.test.ts
git commit -m "Add identity snapshot types and the diff function"
```

---

### Task 2: Snapshot a GuildMember

Converts discord.js objects into an `IdentitySnapshot`, and builds CDN URLs.

**Files:**
- Create: `src/lib/helpers/identitySnapshot.ts`
- Test: `tst/lib/helpers/identitySnapshot.test.ts`

**Interfaces:**
- Consumes: `IdentitySnapshot` from Task 1.
- Produces:
  - `function snapshotMember(member: GuildMember): IdentitySnapshot`
  - `function avatarThumbUrl(discordUserId: string, field: 'user_avatar' | 'member_avatar', hash: string, guildId: string): string`

- [ ] **Step 1: Write the failing test**

```ts
// tst/lib/helpers/identitySnapshot.test.ts
import { GuildMember } from 'discord.js';
import { describe, expect, it } from 'vitest';

import {
  avatarThumbUrl,
  snapshotMember,
} from '../../../src/lib/helpers/identitySnapshot.js';

function fakeMember(overrides: Record<string, unknown> = {}) {
  return {
    id: 'u1',
    nickname: 'Some One',
    avatar: null,
    user: {
      username: 'someone',
      globalName: 'Someone',
      avatar: 'aaa',
      bot: false,
    },
    ...overrides,
  } as unknown as GuildMember;
}

describe('snapshotMember', () => {
  it('reads every tracked field off the member', () => {
    expect(snapshotMember(fakeMember())).toEqual({
      discordUserId: 'u1',
      username: 'someone',
      globalName: 'Someone',
      nickname: 'Some One',
      userAvatarHash: 'aaa',
      memberAvatarHash: null,
    });
  });

  it('captures the per-server avatar override', () => {
    // The stealthiest impersonation vector: visible only inside this guild.
    const snap = snapshotMember(fakeMember({ avatar: 'guild-hash' }));

    expect(snap.memberAvatarHash).toBe('guild-hash');
    expect(snap.userAvatarHash).toBe('aaa');
  });
});

describe('avatarThumbUrl', () => {
  it('requests a 64px global avatar', () => {
    const url = avatarThumbUrl('u1', 'user_avatar', 'aaa', 'g1');

    expect(url).toBe('https://cdn.discordapp.com/avatars/u1/aaa.webp?size=64');
  });

  it('requests a 64px guild avatar from the guild-scoped path', () => {
    // Guild avatars live under a different CDN path; using the global path
    // returns 404 and the thumbnail silently goes missing.
    const url = avatarThumbUrl('u1', 'member_avatar', 'bbb', 'g1');

    expect(url).toBe(
      'https://cdn.discordapp.com/guilds/g1/users/u1/avatars/bbb.webp?size=64',
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn vitest run tst/lib/helpers/identitySnapshot.test.ts`
Expected: FAIL — `snapshotMember is not a function`

- [ ] **Step 3: Write minimal implementation**

```ts
// src/lib/helpers/identitySnapshot.ts
import { GuildMember } from 'discord.js';

import { IdentitySnapshot } from '../repositories/identityTypes.js';

export function snapshotMember(member: GuildMember): IdentitySnapshot {
  return {
    discordUserId: member.id,
    username: member.user.username ?? null,
    globalName: member.user.globalName ?? null,
    nickname: member.nickname ?? null,
    userAvatarHash: member.user.avatar ?? null,
    memberAvatarHash: member.avatar ?? null,
  };
}

/**
 * A 64px thumbnail URL. Discord's CDN resizes on request, which is why this
 * feature needs no image library: adding sharp (native binaries) or jimp
 * (memory-hungry) to a dyno with R14 history would cost more than it buys.
 *
 * Guild avatars live under a different path than global ones; using the
 * global path for a guild avatar 404s.
 */
export function avatarThumbUrl(
  discordUserId: string,
  field: 'user_avatar' | 'member_avatar',
  hash: string,
  guildId: string,
): string {
  if (field === 'member_avatar') {
    return `https://cdn.discordapp.com/guilds/${guildId}/users/${discordUserId}/avatars/${hash}.webp?size=64`;
  }
  return `https://cdn.discordapp.com/avatars/${discordUserId}/${hash}.webp?size=64`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `yarn vitest run tst/lib/helpers/identitySnapshot.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Mutation-test each assertion**

- Make `avatarThumbUrl` always use the global path → the guild-avatar test must fail.
- Drop `?size=64` → both URL tests must fail.
- Read `member.user.avatar` for `memberAvatarHash` → the override test must fail.

- [ ] **Step 6: Commit**

```bash
yarn lint
git add src/lib/helpers/identitySnapshot.ts tst/lib/helpers/identitySnapshot.test.ts
git commit -m "Snapshot a GuildMember's identity fields and build CDN thumb urls"
```

---

### Task 3: Identity repository

Postgres persistence for the baseline and the change log, following `PostgresMemberRepository`'s lazy-schema singleton pattern.

**Files:**
- Create: `src/lib/repositories/postgresIdentityRepository.ts`
- Create: `src/util/identityRepository.ts`
- Test: `tst/integration/postgresIdentityRepository.test.ts`

**Interfaces:**
- Consumes: `IdentitySnapshot`, `IdentityChange`, `IdentityChangeRecord`, `ChangeSource` from Task 1.
- Produces:
  - `class PostgresIdentityRepository` with `static instance(): Promise<PostgresIdentityRepository>`
  - `getSnapshot(discordUserId: string): Promise<IdentitySnapshot | undefined>`
  - `listSnapshots(): Promise<Map<string, IdentitySnapshot>>`
  - `putSnapshot(snapshot: IdentitySnapshot): Promise<void>`
  - `recordChanges(changes: IdentityChange[], source: ChangeSource, thumbs: Map<string, { oldThumb: Buffer | null; newThumb: Buffer | null }>): Promise<void>`
  - `listChangesSince(since: Date): Promise<IdentityChangeRecord[]>`
  - `listChangesBetween(from: Date, to: Date): Promise<IdentityChangeRecord[]>`
  - `storageStats(): Promise<{ changeCount: number; totalBytes: number }>`
  - `ApplicationIdentityRepository(): Promise<PostgresIdentityRepository | undefined>` in `src/util/identityRepository.ts` — returns `undefined` when `DATABASE_URL` is unset, logging a warning once.

The `thumbs` map is keyed `` `${discordUserId}:${field}` ``.

- [ ] **Step 1: Write the failing test**

```ts
// tst/integration/postgresIdentityRepository.test.ts
import crypto from 'crypto';
import { beforeAll, describe, expect, it } from 'vitest';

import { PostgresIdentityRepository } from '../../src/lib/repositories/postgresIdentityRepository.js';
import { IdentitySnapshot } from '../../src/lib/repositories/identityTypes.js';

// Exercises BYTEA round-trips, TIMESTAMPTZ ordering and the upsert conflict
// target against a real Postgres -- all things a mock would paper over.
// Requires DATABASE_URL; skipped otherwise, matching the
// PostgresMemberRepository suite. Locally: yarn test:integration:docker
const POSTGRES_AVAILABLE = Boolean(process.env.DATABASE_URL);

if (!POSTGRES_AVAILABLE) {
  // eslint-disable-next-line no-console
  console.warn(
    'Skipping PostgresIdentityRepository integration tests: set DATABASE_URL to a reachable Postgres to run them.',
  );
}

const freshSnapshot = (): IdentitySnapshot => ({
  discordUserId: `discord-${crypto.randomUUID()}`,
  username: 'someone',
  globalName: 'Someone',
  nickname: 'Some One',
  userAvatarHash: 'aaa',
  memberAvatarHash: null,
});

describe.skipIf(!POSTGRES_AVAILABLE)('PostgresIdentityRepository', () => {
  let repo: PostgresIdentityRepository;

  beforeAll(async () => {
    repo = await PostgresIdentityRepository.instance();
  });

  it('round-trips a snapshot', async () => {
    const snap = freshSnapshot();
    await repo.putSnapshot(snap);

    expect(await repo.getSnapshot(snap.discordUserId)).toEqual(snap);
  });

  it('overwrites an existing snapshot rather than duplicating it', async () => {
    const snap = freshSnapshot();
    await repo.putSnapshot(snap);
    await repo.putSnapshot({ ...snap, userAvatarHash: 'bbb' });

    const stored = await repo.getSnapshot(snap.discordUserId);
    expect(stored?.userAvatarHash).toBe('bbb');
  });

  it('stores and returns thumbnail bytes', async () => {
    const snap = freshSnapshot();
    const thumb = Buffer.from([1, 2, 3, 4]);
    const start = new Date(Date.now() - 1000);

    await repo.recordChanges(
      [
        {
          discordUserId: snap.discordUserId,
          field: 'user_avatar',
          oldValue: 'aaa',
          newValue: 'bbb',
        },
      ],
      'event',
      new Map([
        [
          `${snap.discordUserId}:user_avatar`,
          { oldThumb: null, newThumb: thumb },
        ],
      ]),
    );

    const rows = await repo.listChangesSince(start);
    const mine = rows.find((r) => r.discordUserId === snap.discordUserId);
    // BYTEA must survive the round-trip as bytes, not a hex string.
    expect(mine?.newThumb?.equals(thumb)).toBe(true);
    expect(mine?.oldThumb).toBeNull();
    expect(mine?.source).toBe('event');
  });

  it('records a change with no thumbnails at all', async () => {
    const snap = freshSnapshot();
    const start = new Date(Date.now() - 1000);

    await repo.recordChanges(
      [
        {
          discordUserId: snap.discordUserId,
          field: 'nickname',
          oldValue: 'A',
          newValue: 'B',
        },
      ],
      'sweep',
      new Map(),
    );

    const rows = await repo.listChangesSince(start);
    const mine = rows.find((r) => r.discordUserId === snap.discordUserId);
    // Thumb fetches are best-effort; a missing thumb must not lose the change.
    expect(mine?.newThumb).toBeNull();
    expect(mine?.field).toBe('nickname');
  });

  it('returns changes within a range and excludes those outside it', async () => {
    const snap = freshSnapshot();
    await repo.recordChanges(
      [
        {
          discordUserId: snap.discordUserId,
          field: 'nickname',
          oldValue: 'A',
          newValue: 'B',
        },
      ],
      'event',
      new Map(),
    );

    const now = Date.now();
    const inRange = await repo.listChangesBetween(
      new Date(now - 60_000),
      new Date(now + 60_000),
    );
    const outOfRange = await repo.listChangesBetween(
      new Date(now - 120_000),
      new Date(now - 60_000),
    );

    // The report command slices by range; an off-by-one on the bounds would
    // silently hand organizers the wrong window.
    expect(inRange.some((r) => r.discordUserId === snap.discordUserId)).toBe(
      true,
    );
    expect(
      outOfRange.some((r) => r.discordUserId === snap.discordUserId),
    ).toBe(false);
  });

  it('reports storage stats', async () => {
    const stats = await repo.storageStats();

    expect(stats.changeCount).toBeGreaterThan(0);
    expect(stats.totalBytes).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn docker:up && yarn test:integration`
Expected: FAIL — cannot find `postgresIdentityRepository.js`

- [ ] **Step 3: Write minimal implementation**

```ts
// src/lib/repositories/postgresIdentityRepository.ts
import pg from 'pg';
import { Logger } from 'tslog';

import {
  ChangeSource,
  IdentityChange,
  IdentityChangeRecord,
  IdentityField,
  IdentitySnapshot,
} from './identityTypes.js';

const logger = new Logger({ name: 'PostgresIdentityRepository' });

const CREATE_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS member_identity (
  discord_user_id    TEXT PRIMARY KEY,
  username           TEXT,
  global_name        TEXT,
  nickname           TEXT,
  user_avatar_hash   TEXT,
  member_avatar_hash TEXT,
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS member_identity_changes (
  id              BIGSERIAL PRIMARY KEY,
  discord_user_id TEXT NOT NULL,
  field           TEXT NOT NULL,
  old_value       TEXT,
  new_value       TEXT,
  old_thumb       BYTEA,
  new_thumb       BYTEA,
  detected_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  source          TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS member_identity_changes_detected_at_idx
  ON member_identity_changes (detected_at);
CREATE INDEX IF NOT EXISTS member_identity_changes_user_field_idx
  ON member_identity_changes (discord_user_id, field, detected_at DESC);
`;

interface SnapshotRow {
  discord_user_id: string;
  username: string | null;
  global_name: string | null;
  nickname: string | null;
  user_avatar_hash: string | null;
  member_avatar_hash: string | null;
}

interface ChangeRow {
  id: string;
  discord_user_id: string;
  field: IdentityField;
  old_value: string | null;
  new_value: string | null;
  old_thumb: Buffer | null;
  new_thumb: Buffer | null;
  detected_at: Date;
  source: ChangeSource;
}

function toSnapshot(row: SnapshotRow): IdentitySnapshot {
  return {
    discordUserId: row.discord_user_id,
    username: row.username,
    globalName: row.global_name,
    nickname: row.nickname,
    userAvatarHash: row.user_avatar_hash,
    memberAvatarHash: row.member_avatar_hash,
  };
}

function toChangeRecord(row: ChangeRow): IdentityChangeRecord {
  return {
    id: row.id,
    discordUserId: row.discord_user_id,
    field: row.field,
    oldValue: row.old_value,
    newValue: row.new_value,
    oldThumb: row.old_thumb,
    newThumb: row.new_thumb,
    detectedAt: row.detected_at,
    source: row.source,
  };
}

export class PostgresIdentityRepository {
  private pool: pg.Pool;

  private schemaEnsured: Promise<void> | undefined;

  private static singleton: PostgresIdentityRepository;

  private constructor() {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error(
        'PostgresIdentityRepository requires DATABASE_URL to be set',
      );
    }
    const isLocal =
      connectionString.includes('localhost') ||
      connectionString.includes('127.0.0.1');
    this.pool = new pg.Pool({
      connectionString,
      max: 3,
      ssl: isLocal ? undefined : { rejectUnauthorized: false },
    });
  }

  static async instance(): Promise<PostgresIdentityRepository> {
    if (!PostgresIdentityRepository.singleton) {
      PostgresIdentityRepository.singleton = new PostgresIdentityRepository();
    }
    await PostgresIdentityRepository.singleton.ensureSchema();
    return PostgresIdentityRepository.singleton;
  }

  private async ensureSchema(): Promise<void> {
    if (!this.schemaEnsured) {
      this.schemaEnsured = this.pool.query(CREATE_TABLE_SQL).then(() => {
        logger.info('member_identity schema ensured');
      });
    }
    await this.schemaEnsured;
  }

  async getSnapshot(
    discordUserId: string,
  ): Promise<IdentitySnapshot | undefined> {
    const result = await this.pool.query<SnapshotRow>(
      'SELECT * FROM member_identity WHERE discord_user_id = $1',
      [discordUserId],
    );
    const row = result.rows[0];
    return row ? toSnapshot(row) : undefined;
  }

  async listSnapshots(): Promise<Map<string, IdentitySnapshot>> {
    const result = await this.pool.query<SnapshotRow>(
      'SELECT * FROM member_identity',
    );
    return new Map(
      result.rows.map((row) => [row.discord_user_id, toSnapshot(row)]),
    );
  }

  async putSnapshot(snapshot: IdentitySnapshot): Promise<void> {
    await this.pool.query(
      `INSERT INTO member_identity (discord_user_id, username, global_name,
         nickname, user_avatar_hash, member_avatar_hash, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, now())
       ON CONFLICT (discord_user_id) DO UPDATE SET
         username = EXCLUDED.username,
         global_name = EXCLUDED.global_name,
         nickname = EXCLUDED.nickname,
         user_avatar_hash = EXCLUDED.user_avatar_hash,
         member_avatar_hash = EXCLUDED.member_avatar_hash,
         updated_at = now()`,
      [
        snapshot.discordUserId,
        snapshot.username,
        snapshot.globalName,
        snapshot.nickname,
        snapshot.userAvatarHash,
        snapshot.memberAvatarHash,
      ],
    );
  }

  async recordChanges(
    changes: IdentityChange[],
    source: ChangeSource,
    thumbs: Map<string, { oldThumb: Buffer | null; newThumb: Buffer | null }>,
  ): Promise<void> {
    for (const change of changes) {
      const thumb = thumbs.get(`${change.discordUserId}:${change.field}`);
      // Sequential rather than Promise.all: these share one small pool and a
      // burst from the sweep would otherwise exhaust it.
      // eslint-disable-next-line no-await-in-loop
      await this.pool.query(
        `INSERT INTO member_identity_changes (discord_user_id, field,
           old_value, new_value, old_thumb, new_thumb, source)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          change.discordUserId,
          change.field,
          change.oldValue,
          change.newValue,
          thumb?.oldThumb ?? null,
          thumb?.newThumb ?? null,
          source,
        ],
      );
    }
  }

  async listChangesSince(since: Date): Promise<IdentityChangeRecord[]> {
    const result = await this.pool.query<ChangeRow>(
      `SELECT * FROM member_identity_changes
       WHERE detected_at >= $1 ORDER BY detected_at ASC`,
      [since],
    );
    return result.rows.map(toChangeRecord);
  }

  async listChangesBetween(
    from: Date,
    to: Date,
  ): Promise<IdentityChangeRecord[]> {
    const result = await this.pool.query<ChangeRow>(
      `SELECT * FROM member_identity_changes
       WHERE detected_at >= $1 AND detected_at < $2
       ORDER BY detected_at ASC`,
      [from, to],
    );
    return result.rows.map(toChangeRecord);
  }

  async storageStats(): Promise<{ changeCount: number; totalBytes: number }> {
    const result = await this.pool.query<{ count: string; bytes: string }>(
      `SELECT (SELECT count(*) FROM member_identity_changes)::text AS count,
              (pg_total_relation_size('member_identity_changes')
               + pg_total_relation_size('member_identity'))::text AS bytes`,
    );
    return {
      changeCount: Number(result.rows[0].count),
      totalBytes: Number(result.rows[0].bytes),
    };
  }

  /**
   * Deletes changes older than the cutoff. Deliberately never scheduled: at
   * the measured sizes pruning saves nothing worth the risk of destroying
   * evidence, so removing history stays a deliberate act.
   */
  async pruneChangesBefore(cutoff: Date): Promise<number> {
    const result = await this.pool.query(
      'DELETE FROM member_identity_changes WHERE detected_at < $1',
      [cutoff],
    );
    return result.rowCount ?? 0;
  }
}
```

```ts
// src/util/identityRepository.ts
import { Logger } from 'tslog';

import { PostgresIdentityRepository } from '../lib/repositories/postgresIdentityRepository.js';

const logger = new Logger({ name: 'identityRepository' });

let warned = false;

/**
 * Identity monitoring is Postgres-only. Unlike member links there is no
 * in-memory fallback: a baseline that resets on restart would report every
 * member as changed on the next sweep, which is worse than not running.
 */
export const ApplicationIdentityRepository = async (): Promise<
  PostgresIdentityRepository | undefined
> => {
  if (process.env.DATABASE_URL) {
    return PostgresIdentityRepository.instance();
  }
  if (!warned) {
    warned = true;
    logger.warn(
      'DATABASE_URL is not set - identity monitoring is disabled for this process.',
    );
  }
  return undefined;
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `yarn test:integration`
Expected: PASS (6 tests)

- [ ] **Step 5: Mutation-test each assertion**

- Change `ON CONFLICT ... DO UPDATE` to `DO NOTHING` → the overwrite test must fail.
- Change `listChangesBetween`'s `detected_at < $2` to `<= $2` and widen the out-of-range window by a millisecond → the range test must fail.
- Coerce thumbs with `Buffer.from(String(...))` → the BYTEA test must fail.

- [ ] **Step 6: Commit**

```bash
yarn lint
git add src/lib/repositories/postgresIdentityRepository.ts src/util/identityRepository.ts tst/integration/postgresIdentityRepository.test.ts
git commit -m "Add Postgres identity baseline and change-log repository"
```

---

### Task 4: Thumbnail fetching

Best-effort retrieval of 64px avatars from Discord's CDN.

**Files:**
- Create: `src/lib/helpers/identityThumbs.ts`
- Test: `tst/lib/helpers/identityThumbs.test.ts`

**Interfaces:**
- Consumes: `avatarThumbUrl` (Task 2), `IdentityChange` (Task 1).
- Produces: `function fetchChangeThumbs(changes: IdentityChange[], guildId: string): Promise<Map<string, { oldThumb: Buffer | null; newThumb: Buffer | null }>>`

- [ ] **Step 1: Write the failing test**

```ts
// tst/lib/helpers/identityThumbs.test.ts
import nock from 'nock';
import { afterEach, describe, expect, it } from 'vitest';

import { fetchChangeThumbs } from '../../../src/lib/helpers/identityThumbs.js';

afterEach(() => nock.cleanAll());

describe('fetchChangeThumbs', () => {
  it('fetches both sides of an avatar change at 64px', async () => {
    const scope = nock('https://cdn.discordapp.com')
      .get('/avatars/u1/aaa.webp')
      .query({ size: '64' })
      .reply(200, Buffer.from([1, 2]))
      .get('/avatars/u1/bbb.webp')
      .query({ size: '64' })
      .reply(200, Buffer.from([3, 4]));

    const thumbs = await fetchChangeThumbs(
      [
        {
          discordUserId: 'u1',
          field: 'user_avatar',
          oldValue: 'aaa',
          newValue: 'bbb',
        },
      ],
      'g1',
    );

    const entry = thumbs.get('u1:user_avatar');
    expect(entry?.oldThumb?.equals(Buffer.from([1, 2]))).toBe(true);
    expect(entry?.newThumb?.equals(Buffer.from([3, 4]))).toBe(true);
    expect(scope.isDone()).toBe(true);
  });

  it('records null rather than throwing when the CDN 404s', async () => {
    nock('https://cdn.discordapp.com')
      .get('/avatars/u1/gone.webp')
      .query({ size: '64' })
      .reply(404);

    const thumbs = await fetchChangeThumbs(
      [
        {
          discordUserId: 'u1',
          field: 'user_avatar',
          oldValue: 'gone',
          newValue: null,
        },
      ],
      'g1',
    );

    // Evidence that the change happened matters more than the picture.
    expect(thumbs.get('u1:user_avatar')?.oldThumb).toBeNull();
  });

  it('does not fetch anything for non-avatar fields', async () => {
    const thumbs = await fetchChangeThumbs(
      [
        {
          discordUserId: 'u1',
          field: 'nickname',
          oldValue: 'A',
          newValue: 'B',
        },
      ],
      'g1',
    );

    // A nickname has no image; hitting the CDN for one wastes a request.
    expect(thumbs.size).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn vitest run tst/lib/helpers/identityThumbs.test.ts`
Expected: FAIL — `fetchChangeThumbs is not a function`

- [ ] **Step 3: Write minimal implementation**

```ts
// src/lib/helpers/identityThumbs.ts
import { Logger } from 'tslog';

import { IdentityChange } from '../repositories/identityTypes.js';
import { avatarThumbUrl } from './identitySnapshot.js';

const logger = new Logger({ name: 'identityThumbs' });

const AVATAR_FIELDS = new Set(['user_avatar', 'member_avatar']);

async function fetchOne(url: string): Promise<Buffer | null> {
  try {
    const response = await fetch(url);
    if (!response.ok) {
      return null;
    }
    return Buffer.from(await response.arrayBuffer());
  } catch (error: unknown) {
    logger.warn(`Thumbnail fetch failed for ${url}: ${String(error)}`);
    return null;
  }
}

/**
 * Retrieves before/after thumbnails for avatar changes. Best-effort by
 * design: a failed fetch yields null so the change is still recorded.
 */
export async function fetchChangeThumbs(
  changes: IdentityChange[],
  guildId: string,
): Promise<Map<string, { oldThumb: Buffer | null; newThumb: Buffer | null }>> {
  const thumbs = new Map<
    string,
    { oldThumb: Buffer | null; newThumb: Buffer | null }
  >();
  for (const change of changes) {
    if (!AVATAR_FIELDS.has(change.field)) {
      continue;
    }
    const field = change.field as 'user_avatar' | 'member_avatar';
    /* eslint-disable no-await-in-loop */
    const oldThumb = change.oldValue
      ? await fetchOne(
          avatarThumbUrl(change.discordUserId, field, change.oldValue, guildId),
        )
      : null;
    const newThumb = change.newValue
      ? await fetchOne(
          avatarThumbUrl(change.discordUserId, field, change.newValue, guildId),
        )
      : null;
    /* eslint-enable no-await-in-loop */
    thumbs.set(`${change.discordUserId}:${change.field}`, {
      oldThumb,
      newThumb,
    });
  }
  return thumbs;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `yarn vitest run tst/lib/helpers/identityThumbs.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Mutation-test each assertion**

- Remove the `response.ok` guard → the 404 test must fail (it throws or stores a body).
- Remove the `AVATAR_FIELDS` guard → the nickname test must fail.
- Drop the try/catch → confirm a network error propagates and the 404 test still passes for the right reason.

- [ ] **Step 6: Commit**

```bash
yarn lint
git add src/lib/helpers/identityThumbs.ts tst/lib/helpers/identityThumbs.test.ts
git commit -m "Fetch 64px avatar thumbnails best-effort from Discord's CDN"
```

---

### Task 5: Record-change orchestration

The single entry point both detection paths call: diff, fetch thumbs, persist, update baseline.

**Files:**
- Create: `src/lib/helpers/identityMonitor.ts`
- Test: `tst/lib/helpers/identityMonitor.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 1-4.
- Produces:
  - `function recordIdentityFor(member: GuildMember, source: ChangeSource): Promise<IdentityChange[]>`
  - `function updateBaselineSilently(member: GuildMember): Promise<void>`

- [ ] **Step 1: Write the failing test**

```ts
// tst/lib/helpers/identityMonitor.test.ts
import { GuildMember } from 'discord.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  recordIdentityFor,
  updateBaselineSilently,
} from '../../../src/lib/helpers/identityMonitor.js';

const repo = {
  getSnapshot: vi.fn(),
  putSnapshot: vi.fn().mockResolvedValue(undefined),
  recordChanges: vi.fn().mockResolvedValue(undefined),
};

vi.mock('../../../src/util/identityRepository.js', () => ({
  ApplicationIdentityRepository: vi.fn(async () => repo),
}));

vi.mock('../../../src/lib/helpers/identityThumbs.js', () => ({
  fetchChangeThumbs: vi.fn(async () => new Map()),
}));

function fakeMember(overrides: Record<string, unknown> = {}) {
  return {
    id: 'u1',
    nickname: 'Some One',
    avatar: null,
    guild: { id: 'g1' },
    user: {
      username: 'someone',
      globalName: 'Someone',
      avatar: 'aaa',
      bot: false,
    },
    ...overrides,
  } as unknown as GuildMember;
}

describe('recordIdentityFor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    repo.getSnapshot.mockResolvedValue({
      discordUserId: 'u1',
      username: 'someone',
      globalName: 'Someone',
      nickname: 'Some One',
      userAvatarHash: 'aaa',
      memberAvatarHash: null,
    });
  });

  it('records nothing and writes no baseline when nothing changed', async () => {
    const changes = await recordIdentityFor(fakeMember(), 'event');

    expect(changes).toEqual([]);
    expect(repo.recordChanges).not.toHaveBeenCalled();
    // An unchanged member must not cost a write; the sweep hits 2,008 of them.
    expect(repo.putSnapshot).not.toHaveBeenCalled();
  });

  it('records the change and advances the baseline', async () => {
    const member = fakeMember({
      user: { username: 'someone', globalName: 'Someone', avatar: 'bbb', bot: false },
    });

    const changes = await recordIdentityFor(member, 'event');

    expect(changes).toHaveLength(1);
    expect(changes[0].field).toBe('user_avatar');
    expect(repo.recordChanges).toHaveBeenCalledTimes(1);
    // Baseline must advance, or the same change re-reports on every sweep.
    expect(repo.putSnapshot).toHaveBeenCalledTimes(1);
  });

  it('writes a baseline but no change for a first sighting', async () => {
    repo.getSnapshot.mockResolvedValue(undefined);

    const changes = await recordIdentityFor(fakeMember(), 'backfill');

    expect(changes).toEqual([]);
    expect(repo.recordChanges).not.toHaveBeenCalled();
    // Backfill must persist the baseline, else day one reports 2,008 changes.
    expect(repo.putSnapshot).toHaveBeenCalledTimes(1);
  });

  it('ignores bots entirely', async () => {
    const bot = fakeMember({
      user: { username: 'bot', globalName: null, avatar: 'x', bot: true },
    });

    await recordIdentityFor(bot, 'sweep');

    expect(repo.putSnapshot).not.toHaveBeenCalled();
    expect(repo.recordChanges).not.toHaveBeenCalled();
  });
});

describe('updateBaselineSilently', () => {
  beforeEach(() => vi.clearAllMocks());

  it('advances the baseline without recording a change', async () => {
    await updateBaselineSilently(fakeMember());

    // The bot sets nicknames during onboarding; without this its own writes
    // would show up in the digest as suspicious name changes.
    expect(repo.putSnapshot).toHaveBeenCalledTimes(1);
    expect(repo.recordChanges).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn vitest run tst/lib/helpers/identityMonitor.test.ts`
Expected: FAIL — `recordIdentityFor is not a function`

- [ ] **Step 3: Write minimal implementation**

```ts
// src/lib/helpers/identityMonitor.ts
import { GuildMember } from 'discord.js';
import { Logger } from 'tslog';

import { ApplicationIdentityRepository } from '../../util/identityRepository.js';
import {
  ChangeSource,
  IdentityChange,
} from '../repositories/identityTypes.js';
import { diffIdentity } from './identityDiff.js';
import { snapshotMember } from './identitySnapshot.js';
import { fetchChangeThumbs } from './identityThumbs.js';

const logger = new Logger({ name: 'identityMonitor' });

/**
 * Diffs a member against their stored baseline, persists any changes with
 * thumbnails, and advances the baseline.
 *
 * Returns the changes so callers can log them. An unchanged member costs no
 * write at all, which matters because the daily sweep calls this for every
 * member in the guild.
 */
export async function recordIdentityFor(
  member: GuildMember,
  source: ChangeSource,
): Promise<IdentityChange[]> {
  if (member.user.bot) {
    return [];
  }
  const repo = await ApplicationIdentityRepository();
  if (!repo) {
    return [];
  }

  const after = snapshotMember(member);
  const before = await repo.getSnapshot(member.id);
  const changes = diffIdentity(before, after);

  if (!before) {
    await repo.putSnapshot(after);
    return [];
  }
  if (changes.length === 0) {
    return [];
  }

  const thumbs = await fetchChangeThumbs(changes, member.guild.id);
  await repo.recordChanges(changes, source, thumbs);
  await repo.putSnapshot(after);
  logger.info(
    `Recorded ${changes.length} identity change(s) for ${member.id} via ${source}`,
  );
  return changes;
}

/**
 * Advances the baseline without recording anything. Used after the bot writes
 * a member's nickname during onboarding, so its own writes never appear in
 * the digest as suspicious name changes.
 */
export async function updateBaselineSilently(
  member: GuildMember,
): Promise<void> {
  if (member.user.bot) {
    return;
  }
  const repo = await ApplicationIdentityRepository();
  if (!repo) {
    return;
  }
  await repo.putSnapshot(snapshotMember(member));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `yarn vitest run tst/lib/helpers/identityMonitor.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: Mutation-test each assertion**

- Remove the `changes.length === 0` early return → the no-write test must fail.
- Remove the `member.user.bot` guard → the bot test must fail.
- Remove `await repo.putSnapshot(after)` after recording → the baseline-advance test must fail.
- Record changes on the `!before` path → the first-sighting test must fail.

- [ ] **Step 6: Commit**

```bash
yarn lint
git add src/lib/helpers/identityMonitor.ts tst/lib/helpers/identityMonitor.test.ts
git commit -m "Add identity change recording and silent baseline updates"
```

---

### Task 6: Gateway event handlers and onboarding hook

Wires real-time detection, and stops the bot's own nickname writes from becoming noise.

**Files:**
- Create: `src/events/identityEvents.ts`
- Modify: `src/index.ts` (import and register)
- Modify: `src/lib/helpers/onboardUser.ts` (call `updateBaselineSilently` after `setNickname`)
- Test: `tst/events/identityEvents.test.ts`

**Interfaces:**
- Consumes: `recordIdentityFor`, `updateBaselineSilently` (Task 5).
- Produces: `function registerIdentityEvents(client: Client): void`

- [ ] **Step 1: Write the failing test**

```ts
// tst/events/identityEvents.test.ts
import { Client, GuildMember } from 'discord.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { registerIdentityEvents } from '../../src/events/identityEvents.js';
import { recordIdentityFor } from '../../src/lib/helpers/identityMonitor.js';

vi.mock('../../src/lib/helpers/identityMonitor.js', () => ({
  recordIdentityFor: vi.fn().mockResolvedValue([]),
}));

function fakeClient() {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const client = {
    on: vi.fn((event: string, handler: (...args: unknown[]) => unknown) => {
      handlers.set(event, handler);
    }),
    guilds: { cache: new Map() },
  } as unknown as Client;
  return { client, handlers };
}

const member = (id: string) =>
  ({ id, user: { bot: false }, guild: { id: 'g1' } }) as unknown as GuildMember;

describe('registerIdentityEvents', () => {
  beforeEach(() => vi.clearAllMocks());

  it('subscribes to guildMemberUpdate', () => {
    const { client, handlers } = fakeClient();

    registerIdentityEvents(client);

    // Guards the CALL SITE: a previous release shipped a correct helper that
    // nothing invoked, and only a wiring assertion catches that.
    expect(handlers.has('guildMemberUpdate')).toBe(true);
  });

  it('records the updated member on guildMemberUpdate', async () => {
    const { client, handlers } = fakeClient();
    registerIdentityEvents(client);

    await handlers.get('guildMemberUpdate')?.(member('old'), member('u1'));

    expect(recordIdentityFor).toHaveBeenCalledTimes(1);
    const [passed, source] = vi.mocked(recordIdentityFor).mock.calls[0];
    // Must record the AFTER member; recording the before re-saves the old state.
    expect(passed.id).toBe('u1');
    expect(source).toBe('event');
  });

  it('subscribes to userUpdate', () => {
    const { client, handlers } = fakeClient();

    registerIdentityEvents(client);

    // Global avatar changes arrive on userUpdate, not guildMemberUpdate.
    expect(handlers.has('userUpdate')).toBe(true);
  });

  it('survives a handler error without crashing the process', async () => {
    vi.mocked(recordIdentityFor).mockRejectedValueOnce(new Error('db down'));
    const { client, handlers } = fakeClient();
    registerIdentityEvents(client);

    // An unhandled rejection in a gateway listener takes down the dyno.
    await expect(
      handlers.get('guildMemberUpdate')?.(member('old'), member('u1')),
    ).resolves.not.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn vitest run tst/events/identityEvents.test.ts`
Expected: FAIL — cannot find `identityEvents.js`

- [ ] **Step 3: Write minimal implementation**

```ts
// src/events/identityEvents.ts
import { Client, GuildMember, User } from 'discord.js';
import { Logger } from 'tslog';

import { recordIdentityFor } from '../lib/helpers/identityMonitor.js';

const logger = new Logger({ name: 'identityEvents' });

async function safeRecord(member: GuildMember): Promise<void> {
  try {
    await recordIdentityFor(member, 'event');
  } catch (error: unknown) {
    // An unhandled rejection inside a gateway listener takes down the dyno.
    // Missing one change is survivable; the daily sweep re-detects it.
    logger.error(`Identity event handling failed: ${String(error)}`);
  }
}

/**
 * Real-time detection. guildMemberUpdate covers nickname and per-guild
 * avatar; userUpdate covers global username, display name and avatar, which
 * never appear on guildMemberUpdate.
 */
export function registerIdentityEvents(client: Client): void {
  client.on('guildMemberUpdate', (_before, after) => {
    void safeRecord(after as GuildMember);
  });

  client.on('userUpdate', (_before, after: User) => {
    // userUpdate is guild-agnostic; resolve the member in each guild we share
    // so the per-guild baseline is the thing compared.
    for (const guild of client.guilds.cache.values()) {
      const member = guild.members.cache.get(after.id);
      if (member) {
        void safeRecord(member);
      }
    }
  });

  logger.info('Identity change listeners registered');
}
```

In `src/index.ts`, add the import alongside the existing helper imports:

```ts
import { registerIdentityEvents } from './events/identityEvents.js';
```

and register it inside the `clientReady` handler, immediately after `startUnlinkedDigestScheduler(client);`:

```ts
  registerIdentityEvents(client);
```

In `src/lib/helpers/onboardUser.ts`, inside `onboardUserCommon`, immediately after the existing `logger.info(\`Explicitly set ${fullUsername}'s nickname to ${targetNickName}\`);` line, add:

```ts
    // The bot just wrote this nickname. Advance the baseline so its own write
    // is not reported as a suspicious name change in the daily digest.
    await updateBaselineSilently(guildMember);
```

and add to that file's imports:

```ts
import { updateBaselineSilently } from './identityMonitor.js';
```

- [ ] **Step 4: Run test to verify it passes**

Run: `yarn vitest run tst/events/identityEvents.test.ts && yarn test`
Expected: PASS

- [ ] **Step 5: Mutation-test each assertion**

- Pass `_before` instead of `after` to `safeRecord` → the after-member test must fail.
- Remove the `userUpdate` registration → its test must fail.
- Remove the try/catch → the error-survival test must fail.
- Comment out `registerIdentityEvents(client)` in `index.ts` and confirm `yarn lint` still passes but note the wiring test only covers the function, so **also** grep `src/index.ts` for the call before committing.

- [ ] **Step 6: Commit**

```bash
yarn lint
git add src/events/identityEvents.ts src/index.ts src/lib/helpers/onboardUser.ts tst/events/identityEvents.test.ts
git commit -m "Detect identity changes from gateway events"
```

---

### Task 7: Daily sweep and backfill

Reconciles anything missed while the dyno was down, and performs the silent first population.

**Files:**
- Create: `src/lib/helpers/identitySweep.ts`
- Test: `tst/lib/helpers/identitySweep.test.ts`

**Interfaces:**
- Consumes: `recordIdentityFor` (Task 5).
- Produces: `function runIdentitySweep(client: Client, source: ChangeSource): Promise<{ scanned: number; changed: number }>`

- [ ] **Step 1: Write the failing test**

```ts
// tst/lib/helpers/identitySweep.test.ts
import { Client } from 'discord.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { runIdentitySweep } from '../../../src/lib/helpers/identitySweep.js';
import { recordIdentityFor } from '../../../src/lib/helpers/identityMonitor.js';

vi.mock('../../../src/lib/helpers/identityMonitor.js', () => ({
  recordIdentityFor: vi.fn().mockResolvedValue([]),
}));

function fakeClient(memberIds: string[]) {
  const members = new Map(
    memberIds.map((id) => [
      id,
      { id, user: { bot: false }, guild: { id: 'g1' } },
    ]),
  );
  return {
    guilds: {
      fetch: vi
        .fn()
        .mockResolvedValueOnce(new Map([['g1', { id: 'g1' }]]))
        .mockResolvedValue({
          id: 'g1',
          members: { fetch: vi.fn().mockResolvedValue(members) },
        }),
    },
  } as unknown as Client;
}

describe('runIdentitySweep', () => {
  beforeEach(() => vi.clearAllMocks());

  it('records every member in the guild', async () => {
    const result = await runIdentitySweep(fakeClient(['a', 'b', 'c']), 'sweep');

    expect(recordIdentityFor).toHaveBeenCalledTimes(3);
    expect(result.scanned).toBe(3);
  });

  it('passes the requested source through', async () => {
    await runIdentitySweep(fakeClient(['a']), 'backfill');

    // Backfill must be distinguishable from sweep in the change log.
    expect(vi.mocked(recordIdentityFor).mock.calls[0][1]).toBe('backfill');
  });

  it('counts only members that actually changed', async () => {
    vi.mocked(recordIdentityFor)
      .mockResolvedValueOnce([
        {
          discordUserId: 'a',
          field: 'nickname',
          oldValue: 'A',
          newValue: 'B',
        },
      ])
      .mockResolvedValue([]);

    const result = await runIdentitySweep(fakeClient(['a', 'b']), 'sweep');

    expect(result.changed).toBe(1);
  });

  it('continues past a member that throws', async () => {
    vi.mocked(recordIdentityFor)
      .mockRejectedValueOnce(new Error('one bad member'))
      .mockResolvedValue([]);

    const result = await runIdentitySweep(fakeClient(['a', 'b']), 'sweep');

    // One failure must not abandon the remaining 2,000 members.
    expect(result.scanned).toBe(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn vitest run tst/lib/helpers/identitySweep.test.ts`
Expected: FAIL — `runIdentitySweep is not a function`

- [ ] **Step 3: Write minimal implementation**

```ts
// src/lib/helpers/identitySweep.ts
import { Client } from 'discord.js';
import { Logger } from 'tslog';

import { ChangeSource } from '../repositories/identityTypes.js';
import { recordIdentityFor } from './identityMonitor.js';

const logger = new Logger({ name: 'identitySweep' });

/**
 * Full reconciliation pass. Catches everything the gateway listeners missed
 * while the dyno was restarting, which happens on every deploy and on
 * Heroku's daily cycling.
 *
 * Also performs the initial backfill when called with source 'backfill':
 * members with no baseline are stored silently, so enabling the feature does
 * not report every member in the guild as having changed.
 */
export async function runIdentitySweep(
  client: Client,
  source: ChangeSource,
): Promise<{ scanned: number; changed: number }> {
  const guilds = await client.guilds.fetch();
  const guildId = guilds.first()?.id;
  if (!guildId) {
    return { scanned: 0, changed: 0 };
  }
  const guild = await client.guilds.fetch(guildId);
  const members = await guild.members.fetch();

  let scanned = 0;
  let changed = 0;
  for (const member of members.values()) {
    scanned += 1;
    try {
      // Sequential on purpose: 2,008 concurrent diffs would each want a
      // Postgres connection from a pool of three.
      // eslint-disable-next-line no-await-in-loop
      const changes = await recordIdentityFor(member, source);
      if (changes.length > 0) {
        changed += 1;
      }
    } catch (error: unknown) {
      // One bad member must not abandon the rest of the guild.
      logger.warn(`Sweep failed for ${member.id}: ${String(error)}`);
    }
  }
  logger.info(`Identity sweep (${source}): ${scanned} scanned, ${changed} changed`);
  return { scanned, changed };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `yarn vitest run tst/lib/helpers/identitySweep.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Mutation-test each assertion**

- Hard-code `'sweep'` instead of the `source` parameter → the source test must fail.
- Count every member as changed → the changed-count test must fail.
- Remove the try/catch → the continue-past-error test must fail.

- [ ] **Step 6: Commit**

```bash
yarn lint
git add src/lib/helpers/identitySweep.ts tst/lib/helpers/identitySweep.test.ts
git commit -m "Add identity reconciliation sweep and backfill pass"
```

---

### Task 8: Daily digest

Formats and posts the daily summary, including revert annotation and storage stats.

**Files:**
- Create: `src/lib/helpers/identityDigest.ts`
- Modify: `src/index.ts` (start the scheduler)
- Test: `tst/lib/helpers/identityDigest.test.ts`

**Interfaces:**
- Consumes: `IdentityChangeRecord` (Task 1), repository (Task 3), `runIdentitySweep` (Task 7).
- Produces:
  - `function formatIdentityDigest(changes: IdentityChangeRecord[], stats: { changeCount: number; totalBytes: number }): LogEntry | undefined`
  - `function annotateReverts(changes: IdentityChangeRecord[]): (IdentityChangeRecord & { revertedAt?: Date })[]`
  - `function runIdentityDigestOnce(client: Client): Promise<void>`
  - `function startIdentityDigestScheduler(client: Client): void`

- [ ] **Step 1: Write the failing test**

```ts
// tst/lib/helpers/identityDigest.test.ts
import { describe, expect, it } from 'vitest';

import {
  annotateReverts,
  formatIdentityDigest,
} from '../../../src/lib/helpers/identityDigest.js';
import { IdentityChangeRecord } from '../../../src/lib/repositories/identityTypes.js';

const at = (iso: string) => new Date(iso);

const change = (
  over: Partial<IdentityChangeRecord> = {},
): IdentityChangeRecord => ({
  id: '1',
  discordUserId: 'u1',
  field: 'user_avatar',
  oldValue: 'aaa',
  newValue: 'bbb',
  oldThumb: null,
  newThumb: null,
  detectedAt: at('2026-08-16T14:02:00Z'),
  source: 'event',
  ...over,
});

const stats = { changeCount: 1204, totalBytes: 64_000_000 };

describe('annotateReverts', () => {
  it('marks a change that was undone later the same day', () => {
    const out = annotateReverts([
      change({ id: '1', oldValue: 'aaa', newValue: 'bbb' }),
      change({
        id: '2',
        oldValue: 'bbb',
        newValue: 'aaa',
        detectedAt: at('2026-08-16T18:31:00Z'),
      }),
    ]);

    // A change reverted hours later is far more suspicious than one that
    // stuck, and a daily snapshot diff would miss the pair entirely.
    expect(out[0].revertedAt).toEqual(at('2026-08-16T18:31:00Z'));
  });

  it('leaves a change that stuck unannotated', () => {
    const out = annotateReverts([change()]);

    expect(out[0].revertedAt).toBeUndefined();
  });

  it('does not treat another member\'s change as a revert', () => {
    const out = annotateReverts([
      change({ id: '1', discordUserId: 'u1' }),
      change({
        id: '2',
        discordUserId: 'u2',
        oldValue: 'bbb',
        newValue: 'aaa',
        detectedAt: at('2026-08-16T18:31:00Z'),
      }),
    ]);

    expect(out[0].revertedAt).toBeUndefined();
  });
});

describe('formatIdentityDigest', () => {
  it('returns undefined when there were no changes', () => {
    // A silent day must post nothing rather than an empty embed.
    expect(formatIdentityDigest([], stats)).toBeUndefined();
  });

  it('lists each change and reports storage', () => {
    const entry = formatIdentityDigest([change()], stats);

    expect(entry?.title).toContain('1');
    expect(entry?.description).toContain('<@u1>');
    expect(entry?.description).toContain('user avatar');
    expect(entry?.description).toContain('1,204 changes on record');
  });

  it('notes the revert inline', () => {
    const entry = formatIdentityDigest(
      annotateReverts([
        change({ id: '1' }),
        change({
          id: '2',
          oldValue: 'bbb',
          newValue: 'aaa',
          detectedAt: at('2026-08-16T18:31:00Z'),
        }),
      ]),
      stats,
    );

    expect(entry?.description).toContain('reverted');
  });

  it('truncates a flood rather than exceeding the embed limit', () => {
    const many = Array.from({ length: 200 }, (_, i) =>
      change({ id: String(i), discordUserId: `u${i}` }),
    );

    const entry = formatIdentityDigest(many, stats);

    // Discord rejects descriptions over 4096 characters outright, which would
    // turn a busy day into no digest at all.
    expect(entry?.description.length).toBeLessThanOrEqual(4096);
    expect(entry?.description).toContain('more');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn vitest run tst/lib/helpers/identityDigest.test.ts`
Expected: FAIL — `annotateReverts is not a function`

- [ ] **Step 3: Write minimal implementation**

```ts
// src/lib/helpers/identityDigest.ts
import { Client } from 'discord.js';
import { Logger } from 'tslog';

import { ApplicationCache } from '../../util/cache.js';
import { ApplicationIdentityRepository } from '../../util/identityRepository.js';
import {
  IdentityChangeRecord,
  IdentityField,
} from '../repositories/identityTypes.js';
import { LogEntry, logAlert } from './discordLogger.js';
import { runIdentitySweep } from './identitySweep.js';

const logger = new Logger({ name: 'identityDigest' });

export const IDENTITY_DIGEST_UTC_HOUR = 17; // ≈ 9-10am Pacific
const TICK_MS = 60 * 60 * 1000; // hourly
const MAX_DESCRIPTION = 4096; // Discord's hard embed description limit

const FIELD_LABELS: Record<IdentityField, string> = {
  user_avatar: 'user avatar',
  member_avatar: 'server avatar',
  nickname: 'nickname',
  username: 'username',
  global_name: 'display name',
};

export type AnnotatedChange = IdentityChangeRecord & { revertedAt?: Date };

export function shouldRunIdentityDigestNow(now: Date): boolean {
  return now.getUTCHours() === IDENTITY_DIGEST_UTC_HOUR;
}

/**
 * Marks a change that was later undone by the same member on the same field.
 * A transient change is the signature of impersonation-then-cleanup, and it
 * is invisible to a snapshot diff -- both endpoints look identical.
 */
export function annotateReverts(
  changes: IdentityChangeRecord[],
): AnnotatedChange[] {
  return changes.map((change) => {
    const revert = changes.find(
      (other) =>
        other.id !== change.id &&
        other.discordUserId === change.discordUserId &&
        other.field === change.field &&
        other.detectedAt > change.detectedAt &&
        other.newValue === change.oldValue,
    );
    return revert ? { ...change, revertedAt: revert.detectedAt } : change;
  });
}

function line(change: AnnotatedChange): string {
  const time = change.detectedAt.toISOString().slice(11, 16);
  const label = FIELD_LABELS[change.field];
  const reverted = change.revertedAt
    ? ` (reverted ${change.revertedAt.toISOString().slice(11, 16)})`
    : '';
  if (change.field === 'user_avatar' || change.field === 'member_avatar') {
    return `${time}  <@${change.discordUserId}>  ${label} changed${reverted}`;
  }
  return `${time}  <@${change.discordUserId}>  ${label} "${
    change.oldValue ?? '—'
  }" → "${change.newValue ?? '—'}"${reverted}`;
}

export function formatIdentityDigest(
  changes: AnnotatedChange[],
  stats: { changeCount: number; totalBytes: number },
): LogEntry | undefined {
  if (changes.length === 0) {
    return undefined;
  }
  const footer = `\n\nStorage: ${stats.changeCount.toLocaleString(
    'en-US',
  )} changes on record, ${Math.round(stats.totalBytes / 1_000_000)} MB`;

  const lines: string[] = [];
  let used = footer.length;
  let shown = 0;
  for (const change of changes) {
    const next = `${line(change)}\n`;
    // Reserve room for the overflow note so a flood degrades to a truncated
    // digest rather than a rejected one.
    if (used + next.length > MAX_DESCRIPTION - 40) {
      break;
    }
    lines.push(next);
    used += next.length;
    shown += 1;
  }
  const overflow = changes.length - shown;
  const overflowNote = overflow > 0 ? `…and ${overflow} more\n` : '';

  return {
    title: `Identity changes: ${changes.length} in the last 24h`,
    description: `${lines.join('')}${overflowNote}${footer}`,
  };
}

export async function runIdentityDigestOnce(client: Client): Promise<void> {
  const repo = await ApplicationIdentityRepository();
  if (!repo) {
    return;
  }

  // Reconcile first so the digest includes anything missed while the dyno was
  // restarting, then report.
  await runIdentitySweep(client, 'sweep');

  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const changes = await repo.listChangesSince(since);
  const stats = await repo.storageStats();

  // Claim the day only after the fallible work succeeds, so a failed run
  // leaves the claim unconsumed and a restart within the hour can retry.
  const cache = await ApplicationCache();
  const today = new Date().toISOString().slice(0, 10);
  const claimed = await cache.exclusive_set(`identity-digest-${today}`, '1');
  if (!claimed) {
    return;
  }

  const entry = formatIdentityDigest(annotateReverts(changes), stats);
  if (entry) {
    await logAlert(client, entry);
  }
  logger.info(`Identity digest ran: ${changes.length} changes`);
}

export function startIdentityDigestScheduler(client: Client): void {
  const tick = () => {
    if (!shouldRunIdentityDigestNow(new Date())) {
      return;
    }
    runIdentityDigestOnce(client).catch((error) =>
      logger.error(`Identity digest failed: ${String(error)}`),
    );
  };
  tick();
  setInterval(tick, TICK_MS);
}
```

In `src/index.ts`, add the import:

```ts
import { startIdentityDigestScheduler } from './lib/helpers/identityDigest.js';
```

and inside `clientReady`, after `registerIdentityEvents(client);`:

```ts
  startIdentityDigestScheduler(client);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `yarn vitest run tst/lib/helpers/identityDigest.test.ts && yarn test`
Expected: PASS

- [ ] **Step 5: Mutation-test each assertion**

- Drop the `other.discordUserId === change.discordUserId` condition → the cross-member test must fail.
- Drop the `other.detectedAt > change.detectedAt` condition → the stuck-change test must fail.
- Return an entry for an empty list → the silent-day test must fail.
- Remove the length cap → the truncation test must fail.

- [ ] **Step 6: Commit**

```bash
yarn lint
git add src/lib/helpers/identityDigest.ts src/index.ts tst/lib/helpers/identityDigest.test.ts
git commit -m "Post a daily identity change digest with revert annotation"
```

---

### Task 9: HTML report generation

Builds the self-contained report from change records.

**Files:**
- Create: `src/lib/helpers/identityReport.ts`
- Test: `tst/lib/helpers/identityReport.test.ts`

**Interfaces:**
- Consumes: `IdentityChangeRecord` (Task 1).
- Produces:
  - `function renderIdentityReport(changes: IdentityChangeRecord[], range: { from: Date; to: Date }): string`
  - `const MAX_REPORT_BYTES = 90 * 1024 * 1024`
  - `function estimateReportBytes(changes: IdentityChangeRecord[]): number`

- [ ] **Step 1: Write the failing test**

```ts
// tst/lib/helpers/identityReport.test.ts
import { describe, expect, it } from 'vitest';

import {
  estimateReportBytes,
  renderIdentityReport,
} from '../../../src/lib/helpers/identityReport.js';
import { IdentityChangeRecord } from '../../../src/lib/repositories/identityTypes.js';

const range = {
  from: new Date('2026-08-10T00:00:00Z'),
  to: new Date('2026-08-17T00:00:00Z'),
};

const change = (
  over: Partial<IdentityChangeRecord> = {},
): IdentityChangeRecord => ({
  id: '1',
  discordUserId: 'u1',
  field: 'user_avatar',
  oldValue: 'aaa',
  newValue: 'bbb',
  oldThumb: Buffer.from([1, 2, 3]),
  newThumb: Buffer.from([4, 5, 6]),
  detectedAt: new Date('2026-08-16T14:02:00Z'),
  source: 'event',
  ...over,
});

describe('renderIdentityReport', () => {
  it('embeds thumbnails as data uris', () => {
    const html = renderIdentityReport([change()], range);

    // The whole point of storing bytes: the file must render in a year,
    // with no dependency on Discord's CDN, which purges old avatars.
    expect(html).toContain('data:image/webp;base64,AQID');
    expect(html).not.toContain('cdn.discordapp.com');
  });

  it('escapes html in names so a crafted nickname cannot inject markup', () => {
    const html = renderIdentityReport(
      [
        change({
          field: 'nickname',
          oldValue: '<script>alert(1)</script>',
          newValue: 'x',
          oldThumb: null,
          newThumb: null,
        }),
      ],
      range,
    );

    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('renders a placeholder when a thumbnail is missing', () => {
    const html = renderIdentityReport(
      [change({ oldThumb: null, newThumb: null })],
      range,
    );

    // Best-effort thumbs mean nulls are normal; the row must still render.
    expect(html).toContain('no image');
  });

  it('is a complete standalone document', () => {
    const html = renderIdentityReport([change()], range);

    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('</html>');
    // No external stylesheet or script may be referenced.
    expect(html).not.toMatch(/<link[^>]+href="http/);
    expect(html).not.toMatch(/<script[^>]+src=/);
  });

  it('reports an empty range without crashing', () => {
    const html = renderIdentityReport([], range);

    expect(html).toContain('No identity changes');
  });
});

describe('estimateReportBytes', () => {
  it('grows with thumbnail size', () => {
    const small = estimateReportBytes([change()]);
    const big = estimateReportBytes([
      change({ newThumb: Buffer.alloc(100_000) }),
    ]);

    // Used to refuse ranges Discord would reject at upload time.
    expect(big).toBeGreaterThan(small);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn vitest run tst/lib/helpers/identityReport.test.ts`
Expected: FAIL — `renderIdentityReport is not a function`

- [ ] **Step 3: Write minimal implementation**

```ts
// src/lib/helpers/identityReport.ts
import {
  IdentityChangeRecord,
  IdentityField,
} from '../repositories/identityTypes.js';

/**
 * Guild is boost tier 3, so Discord accepts 100 MB uploads. Refuse a little
 * under that: base64 inflation is already counted, but the multipart envelope
 * is not.
 */
export const MAX_REPORT_BYTES = 90 * 1024 * 1024;

const FIELD_LABELS: Record<IdentityField, string> = {
  user_avatar: 'User avatar',
  member_avatar: 'Server avatar',
  nickname: 'Nickname',
  username: 'Username',
  global_name: 'Display name',
};

function escapeHtml(value: string | null): string {
  if (value === null) {
    return '—';
  }
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function img(thumb: Buffer | null): string {
  if (!thumb) {
    return '<span class="none">no image</span>';
  }
  return `<img src="data:image/webp;base64,${thumb.toString('base64')}" alt="">`;
}

/** Base64 inflates by 4/3; the markup around each row is roughly 300 bytes. */
export function estimateReportBytes(changes: IdentityChangeRecord[]): number {
  return changes.reduce((total, change) => {
    const bytes =
      (change.oldThumb?.length ?? 0) + (change.newThumb?.length ?? 0);
    return total + Math.ceil((bytes * 4) / 3) + 300;
  }, 2048);
}

export function renderIdentityReport(
  changes: IdentityChangeRecord[],
  range: { from: Date; to: Date },
): string {
  const header = `Identity changes ${range.from
    .toISOString()
    .slice(0, 10)} to ${range.to.toISOString().slice(0, 10)}`;

  const body =
    changes.length === 0
      ? '<p class="none">No identity changes in this range.</p>'
      : `<table>
<thead><tr><th>When (UTC)</th><th>Member</th><th>Field</th><th>Before</th><th>After</th><th>Source</th></tr></thead>
<tbody>
${changes
  .map(
    (change) => `<tr>
<td class="when">${change.detectedAt.toISOString().replace('T', ' ').slice(0, 16)}</td>
<td class="who">${escapeHtml(change.discordUserId)}</td>
<td>${FIELD_LABELS[change.field]}</td>
<td>${
      change.oldThumb || change.newThumb
        ? img(change.oldThumb)
        : escapeHtml(change.oldValue)
    }</td>
<td>${
      change.oldThumb || change.newThumb
        ? img(change.newThumb)
        : escapeHtml(change.newValue)
    }</td>
<td>${escapeHtml(change.source)}</td>
</tr>`,
  )
  .join('\n')}
</tbody></table>`;

  // Self-contained by design: no external stylesheet, script, font or image.
  // The file must render identically offline and in a year's time.
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>${escapeHtml(header)}</title>
<style>
body{font:14px system-ui,sans-serif;margin:24px;color:#111;background:#fff}
h1{font-size:18px}
table{border-collapse:collapse;width:100%}
th,td{border:1px solid #ddd;padding:6px 8px;text-align:left;vertical-align:middle}
th{background:#f5f5f5}
img{width:64px;height:64px;object-fit:cover;border-radius:4px;display:block}
.when{white-space:nowrap;font-variant-numeric:tabular-nums}
.who{font-family:ui-monospace,monospace;font-size:12px}
.none{color:#888;font-style:italic}
</style></head>
<body>
<h1>${escapeHtml(header)}</h1>
<p>${changes.length} change${changes.length === 1 ? '' : 's'}.</p>
${body}
</body></html>`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `yarn vitest run tst/lib/helpers/identityReport.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 5: Mutation-test each assertion**

- Remove `escapeHtml` from the value cells → the injection test must fail.
- Emit a CDN URL instead of a data URI → the data-uri test must fail.
- Return `''` for a missing thumb → the placeholder test must fail.
- Return only the `<table>` without the document wrapper → the standalone test must fail.

- [ ] **Step 6: Commit**

```bash
yarn lint
git add src/lib/helpers/identityReport.ts tst/lib/helpers/identityReport.test.ts
git commit -m "Render a self-contained HTML identity change report"
```

---

### Task 10: The /meetup_identity_report command

Role-gated command that delivers the report as a file attachment.

**Files:**
- Create: `src/commands/meetup/identityReport.ts`
- Test: `tst/commands/meetup/identityReport.test.ts`

**Interfaces:**
- Consumes: `renderIdentityReport`, `estimateReportBytes`, `MAX_REPORT_BYTES` (Task 9), repository (Task 3), `requireModOrOrganizer` and `withDiscordFileAttachment` (existing, `src/util/discord.ts`).
- Produces: the slash command; no exported functions other than the class.

- [ ] **Step 1: Write the failing test**

```ts
// tst/commands/meetup/identityReport.test.ts
import { describe, expect, it } from 'vitest';

import { buildReportAttachment } from '../../../src/commands/meetup/identityReport.js';
import { IdentityChangeRecord } from '../../../src/lib/repositories/identityTypes.js';

const change = (
  over: Partial<IdentityChangeRecord> = {},
): IdentityChangeRecord => ({
  id: '1',
  discordUserId: 'u1',
  field: 'user_avatar',
  oldValue: 'aaa',
  newValue: 'bbb',
  oldThumb: Buffer.from([1, 2, 3]),
  newThumb: Buffer.from([4, 5, 6]),
  detectedAt: new Date('2026-08-16T14:02:00Z'),
  source: 'event',
  ...over,
});

describe('buildReportAttachment', () => {
  it('returns html and a dated filename for a normal range', () => {
    const result = buildReportAttachment([change()], 7);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.fileName).toMatch(/^identity-report-\d{4}-\d{2}-\d{2}\.html$/);
    expect(result.html).toContain('<!doctype html>');
  });

  it('refuses a range too large for Discord to accept', () => {
    const huge = Array.from({ length: 400 }, (_, i) =>
      change({ id: String(i), newThumb: Buffer.alloc(300_000) }),
    );

    const result = buildReportAttachment(huge, 365);

    // Producing a file Discord rejects wastes the whole generation pass and
    // gives the organizer nothing but a confusing upload error.
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('narrower');
  });

  it('still builds a report when there are no changes', () => {
    const result = buildReportAttachment([], 7);

    expect(result.ok).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn vitest run tst/commands/meetup/identityReport.test.ts`
Expected: FAIL — `buildReportAttachment is not a function`

- [ ] **Step 3: Write minimal implementation**

```ts
// src/commands/meetup/identityReport.ts
import {
  ApplicationCommandOptionType,
  CommandInteraction,
  PermissionFlagsBits,
} from 'discord.js';
import { Discord, Slash, SlashOption } from 'discordx';
import { Logger } from 'tslog';

import {
  MAX_REPORT_BYTES,
  estimateReportBytes,
  renderIdentityReport,
} from '../../lib/helpers/identityReport.js';
import { IdentityChangeRecord } from '../../lib/repositories/identityTypes.js';
import {
  discordCommandWrapper,
  requireModOrOrganizer,
  withDiscordFileAttachment,
} from '../../util/discord.js';
import { ApplicationIdentityRepository } from '../../util/identityRepository.js';

const logger = new Logger({ name: 'IdentityReportCommands' });

const strings = {
  notAllowed: 'Only moderators and organizers can pull identity reports.',
  unavailable:
    'Identity monitoring is not configured (no database on this instance).',
};

export type ReportAttachment =
  | { ok: true; fileName: string; html: string }
  | { ok: false; reason: string };

export function buildReportAttachment(
  changes: IdentityChangeRecord[],
  days: number,
): ReportAttachment {
  const to = new Date();
  const from = new Date(to.getTime() - days * 24 * 60 * 60 * 1000);

  const estimated = estimateReportBytes(changes);
  if (estimated > MAX_REPORT_BYTES) {
    return {
      ok: false,
      reason: `That range needs about ${Math.round(
        estimated / 1_000_000,
      )} MB, over Discord's upload limit. Try a narrower window.`,
    };
  }

  return {
    ok: true,
    fileName: `identity-report-${to.toISOString().slice(0, 10)}.html`,
    html: renderIdentityReport(changes, { from, to }),
  };
}

@Discord()
export class IdentityReportCommands {
  @Slash({
    name: 'meetup_identity_report',
    description:
      'Download a visual report of member photo and name changes (mods/organizers only)',
    defaultMemberPermissions: PermissionFlagsBits.ModerateMembers,
  })
  async identityReportHandler(
    @SlashOption({
      name: 'days',
      description: 'How many days back to include (default 7)',
      type: ApplicationCommandOptionType.Integer,
      required: false,
      minValue: 1,
      maxValue: 365,
    })
    days: number | undefined,
    interaction: CommandInteraction,
  ) {
    await discordCommandWrapper(interaction, async () => {
      await requireModOrOrganizer(interaction, strings.notAllowed);

      const repo = await ApplicationIdentityRepository();
      if (!repo) {
        throw new Error(strings.unavailable);
      }

      const windowDays = days ?? 7;
      const to = new Date();
      const from = new Date(to.getTime() - windowDays * 24 * 60 * 60 * 1000);
      const changes = await repo.listChangesBetween(from, to);

      const built = buildReportAttachment(changes, windowDays);
      if (!built.ok) {
        throw new Error(built.reason);
      }

      await withDiscordFileAttachment(
        built.fileName,
        built.html,
        async (attachmentArgs) => {
          await interaction.editReply({
            content: `Identity report: ${changes.length} change${
              changes.length === 1 ? '' : 's'
            } over the last ${windowDays} day${windowDays === 1 ? '' : 's'}.`,
            ...attachmentArgs,
          });
        },
      );
      logger.info(
        `Identity report generated: ${changes.length} changes over ${windowDays}d`,
      );
    });
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `yarn vitest run tst/commands/meetup/identityReport.test.ts && yarn test`
Expected: PASS

- [ ] **Step 5: Mutation-test each assertion**

- Remove the `estimated > MAX_REPORT_BYTES` guard → the refusal test must fail.
- Return a fixed filename with no date → the filename test must fail.
- Return `ok: false` for an empty change list → the empty-range test must fail.

- [ ] **Step 6: Commit**

```bash
yarn lint
git add src/commands/meetup/identityReport.ts tst/commands/meetup/identityReport.test.ts
git commit -m "Add /meetup_identity_report delivering a self-contained HTML file"
```

---

### Task 11: Backfill script and rollout verification

The one-time silent population, and end-to-end confirmation.

**Files:**
- Create: `scripts/backfillIdentityBaseline.ts`
- Modify: `README.md` (document the command and the backfill step)

**Interfaces:**
- Consumes: `runIdentitySweep` (Task 7).
- Produces: a runnable script; no exports.

- [ ] **Step 1: Write the script**

```ts
// scripts/backfillIdentityBaseline.ts
/**
 * One-time silent population of member_identity.
 *
 * Every member with no baseline is stored without recording a change. Skipping
 * this makes the first digest report all 2,008 members as having changed
 * identity, which is both useless and alarming.
 *
 * Run against production explicitly:
 *   DISCORD_API_KEY=$(heroku config:get DISCORD_API_KEY -a meetup-discord-bot) \
 *   DATABASE_URL=$(heroku config:get DATABASE_URL -a meetup-discord-bot) \
 *   yarn tsx scripts/backfillIdentityBaseline.ts
 */
import { Client, GatewayIntentBits } from 'discord.js';
import { Logger } from 'tslog';

import { runIdentitySweep } from '../src/lib/helpers/identitySweep.js';

const logger = new Logger({ name: 'backfillIdentityBaseline' });

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
});

client.once('clientReady', async () => {
  try {
    const result = await runIdentitySweep(client, 'backfill');
    logger.info(
      `Backfill complete: ${result.scanned} scanned, ${result.changed} changes recorded (expected 0 on a fresh table)`,
    );
  } catch (error: unknown) {
    logger.error(`Backfill failed: ${String(error)}`);
  } finally {
    await client.destroy();
  }
});

client.login(process.env.DISCORD_API_KEY).catch((error) => {
  logger.error(`Login failed: ${String(error)}`);
  process.exit(1);
});
```

- [ ] **Step 2: Verify the whole suite is green**

Run: `yarn lint && yarn test && yarn docker:up && yarn test:integration && yarn docker:down`
Expected: all pass.

- [ ] **Step 3: Confirm the call sites are wired**

Run:

```bash
grep -n "registerIdentityEvents\|startIdentityDigestScheduler" src/index.ts
grep -n "updateBaselineSilently" src/lib/helpers/onboardUser.ts
```

Expected: three matches for the first (one import + one call each), one import and one call for the second. A helper that nothing calls has shipped before on this repo — this check is the guard.

- [ ] **Step 4: Document in README.md**

Add to the commands section:

```markdown
- `/meetup_identity_report [days]` — mods/organizers only. Downloads a
  self-contained HTML report of member photo and name changes over the last
  N days (default 7), with before/after thumbnails embedded.
```

Add a deployment note:

```markdown
### Identity monitoring

Before the first digest, populate the baseline once so existing members are
not reported as changed:

    DISCORD_API_KEY=$(heroku config:get DISCORD_API_KEY -a meetup-discord-bot) \
    DATABASE_URL=$(heroku config:get DATABASE_URL -a meetup-discord-bot) \
    yarn tsx scripts/backfillIdentityBaseline.ts
```

- [ ] **Step 5: Commit**

```bash
yarn lint
git add scripts/backfillIdentityBaseline.ts README.md
git commit -m "Add identity baseline backfill script and document the report command"
```

- [ ] **Step 6: Open the PR**

```bash
git push -u origin feat/identity-monitoring
gh pr create --title "Identity change monitoring" --body "See docs/superpowers/specs/2026-08-16-identity-monitoring-design.md"
```

---

## Post-merge rollout

Ordering matters; the spec's rollout section requires it.

1. Merge and let Heroku deploy. Tables are created lazily on first repository use.
2. Run the backfill script. Confirm it reports `changes recorded: 0`.
3. Confirm the baseline is populated:
   `SELECT count(*) FROM member_identity;` should be close to 2,008 minus bots.
4. Leave it a day. The digest fires at 17:00 UTC.
5. Verify the first digest reports a plausible handful of changes, not thousands.
6. Run `/meetup_identity_report 1` and confirm the attached file opens with images.
