# Meetup ID Storage, Bot Log Channels & Unlinked Digest — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist every onboarded user's Meetup ID in Heroku Postgres, mirror bot activity into two new organizer Discord log channels, and post a daily digest of verified members with no Meetup link.

**Architecture:** Minimal `pg`-based repository behind the same env-var-selected singleton pattern the codebase already uses for Redis-vs-memory caching. A `discordLogger` helper posts green activity / red alert embeds to two hardcoded channels; `discordCommandWrapper` gets success/error hooks so every command is logged automatically. An in-process hourly tick fires the digest once daily, guarded by the existing cache's `exclusive_set`.

**Tech Stack:** TypeScript (ESM, `type: module`, tsx runtime), discord.js 14 + discordx decorators, `pg`, vitest (unit + env-gated integration suites), tslog, Heroku Postgres Essential-0.

**Spec:** `docs/superpowers/specs/2026-08-14-meetup-id-storage-design.md`

## Global Constraints

- ESM project: **all relative imports must end in `.js`** (e.g. `import { X } from '../repositories/types.js'`) even from `.ts` files.
- Package manager is **yarn** (`yarn add`, `yarn test`, `yarn test:integration`, `yarn lint`).
- Unit tests live under `tst/` (mirroring `src/`), integration tests under `tst/integration/`. Unit tests must not require network or external services.
- Integration suites are env-gated with a `describe.skip` fallback + console warning (copy the pattern from `tst/integration/redisCache.test.ts`).
- Follow existing code style: tslog `Logger` per file with a `name`, `strings` object for user-facing copy, decorator-based discordx commands.
- Lint must pass: `yarn lint` (eslint 10 flat config + prettier). Husky pre-push runs unit tests.
- The bot serves exactly one guild: `1.5 Gen Asians Meetup Group` (`912461362289061939`).
- Existing category IDs: `📜Logs` = `932896530447364146`, `🏢1.5 Leadership Team` = `912463487257686066`.
- Digest target hour: **17:00 UTC** (≈ 9–10 am Pacific).
- Commit messages end with: `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

## File Structure

| File | Responsibility |
|---|---|
| `src/lib/repositories/types.ts` (new) | `MemberRecord`, `MemberUpsert`, `OnboardMethod`, `MemberRepository` interface |
| `src/lib/repositories/inMemoryMemberRepository.ts` (new) | Map-backed repo for local dev + unit tests |
| `src/lib/repositories/postgresMemberRepository.ts` (new) | `pg` pool repo, ensures schema lazily |
| `src/util/memberRepository.ts` (new) | `ApplicationMemberRepository()` selector on `DATABASE_URL` (mirrors `src/util/cache.ts`) |
| `scripts/createLogChannels.ts` (new) | One-off: create the two log channels, print IDs |
| `src/constants.ts` (modify) | `BOT_ACTIVITY_LOG_CHANNEL_ID`, `BOT_ALERTS_CHANNEL_ID` |
| `src/lib/helpers/discordLogger.ts` (new) | `logActivity` / `logAlert`, never throw |
| `src/util/discord.ts` (modify) | wrapper hooks: activity on success, alert on error; `hasAnyServerRole` |
| `src/lib/helpers/memberLink.ts` (new) | `recordMeetupLink` (duplicate rules), `recordManualOnboard`, `DuplicateMeetupAccountError` |
| `src/lib/helpers/onboardUser.ts` (modify) | wire `recordMeetupLink` into `selfOnboardUser`, `recordManualOnboard` into `onboardUser` |
| `src/buttonMenu/meetup/syncAccountV2.ts` (modify) | wire `recordMeetupLink` with `'sync_v2'` |
| `src/commands/meetup/unlinkAccount.ts` (new) | `/meetup_unlink` mod/organizer command |
| `src/lib/helpers/unlinkedDigest.ts` (new) | digest collection, formatting, scheduler |
| `src/index.ts` (modify) | start digest scheduler on `clientReady` |
| `tst/lib/repositories/inMemoryMemberRepository.test.ts` (new) | repo semantics |
| `tst/integration/postgresMemberRepository.test.ts` (new) | real-Postgres CRUD, gated on `DATABASE_URL` |
| `tst/lib/helpers/discordLogger.test.ts` (new) | posts embeds; never throws |
| `tst/lib/helpers/memberLink.test.ts` (new) | duplicate/change/manual rules |
| `tst/lib/helpers/unlinkedDigest.test.ts` (new) | collection filter + formatting + shouldRun |
| `tst/commands/meetup/util/discord.test.ts` (new) | wrapper hooks + `hasAnyServerRole` |

---

### Task 1: Repository types + InMemoryMemberRepository

**Files:**
- Create: `src/lib/repositories/types.ts`
- Create: `src/lib/repositories/inMemoryMemberRepository.ts`
- Test: `tst/lib/repositories/inMemoryMemberRepository.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces (used by every later task):

```typescript
export type OnboardMethod = 'self_onboard' | 'sync_v2' | 'manual';

export interface MemberRecord {
  discordUserId: string;
  meetupId: string | null;
  meetupName: string | null;
  meetupMemberUrl: string | null;
  onboardMethod: OnboardMethod;
  onboardedBy: string | null; // mod's Discord ID, manual onboards only
  firstOnboardedAt: Date;
  lastSyncedAt: Date;
}

export type MemberUpsert = Omit<MemberRecord, 'firstOnboardedAt' | 'lastSyncedAt'>;

export interface MemberRepository {
  upsert(member: MemberUpsert): Promise<MemberRecord>;
  findByDiscordId(discordUserId: string): Promise<MemberRecord | undefined>;
  findByMeetupId(meetupId: string): Promise<MemberRecord | undefined>;
  listAll(): Promise<MemberRecord[]>;
  remove(discordUserId: string): Promise<void>;
}
```

- `InMemoryMemberRepository` additionally exposes a **public constructor** (unlike the cache singletons) so tests can build fresh instances, plus a static `instance()` singleton for the selector.

- [ ] **Step 1: Write the failing test**

Create `tst/lib/repositories/inMemoryMemberRepository.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';

import { InMemoryMemberRepository } from '../../../src/lib/repositories/inMemoryMemberRepository.js';

const linkedMember = {
  discordUserId: 'discord-1',
  meetupId: 'meetup-1',
  meetupName: 'Test User',
  meetupMemberUrl: 'https://www.meetup.com/members/1/',
  onboardMethod: 'self_onboard' as const,
  onboardedBy: null,
};

describe('InMemoryMemberRepository', () => {
  it('returns undefined for unknown lookups', async () => {
    const repo = new InMemoryMemberRepository();
    expect(await repo.findByDiscordId('nope')).toBeUndefined();
    expect(await repo.findByMeetupId('nope')).toBeUndefined();
  });

  it('round-trips a member through upsert/find', async () => {
    const repo = new InMemoryMemberRepository();
    const stored = await repo.upsert(linkedMember);

    expect(stored.meetupId).toBe('meetup-1');
    expect(stored.firstOnboardedAt).toBeInstanceOf(Date);
    expect(await repo.findByDiscordId('discord-1')).toMatchObject(linkedMember);
    expect(await repo.findByMeetupId('meetup-1')).toMatchObject(linkedMember);
  });

  it('upsert updates in place and preserves firstOnboardedAt', async () => {
    const repo = new InMemoryMemberRepository();
    const first = await repo.upsert(linkedMember);
    const updated = await repo.upsert({
      ...linkedMember,
      meetupName: 'Renamed User',
    });

    expect(updated.meetupName).toBe('Renamed User');
    expect(updated.firstOnboardedAt).toEqual(first.firstOnboardedAt);
    expect(await repo.listAll()).toHaveLength(1);
  });

  it('supports null meetupId rows (manual onboards)', async () => {
    const repo = new InMemoryMemberRepository();
    await repo.upsert({
      discordUserId: 'discord-2',
      meetupId: null,
      meetupName: null,
      meetupMemberUrl: null,
      onboardMethod: 'manual',
      onboardedBy: 'mod-1',
    });

    const row = await repo.findByDiscordId('discord-2');
    expect(row?.meetupId).toBeNull();
    expect(row?.onboardedBy).toBe('mod-1');
  });

  it('remove deletes the row', async () => {
    const repo = new InMemoryMemberRepository();
    await repo.upsert(linkedMember);
    await repo.remove('discord-1');

    expect(await repo.findByDiscordId('discord-1')).toBeUndefined();
    expect(await repo.listAll()).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn test tst/lib/repositories/inMemoryMemberRepository.test.ts`
Expected: FAIL — cannot resolve `src/lib/repositories/inMemoryMemberRepository.js`.

- [ ] **Step 3: Write the implementation**

Create `src/lib/repositories/types.ts` with exactly the interface block from **Interfaces** above (all four `export`s).

Create `src/lib/repositories/inMemoryMemberRepository.ts`:

```typescript
import { MemberRecord, MemberRepository, MemberUpsert } from './types.js';

/**
 * Map-backed MemberRepository used for local development (no DATABASE_URL)
 * and unit tests. Mirrors the InMemoryCache/RedisCache split.
 */
export class InMemoryMemberRepository implements MemberRepository {
  private members = new Map<string, MemberRecord>();

  private static singleton: InMemoryMemberRepository;

  public static instance(): InMemoryMemberRepository {
    if (this.singleton === undefined) {
      this.singleton = new InMemoryMemberRepository();
    }
    return this.singleton;
  }

  async upsert(member: MemberUpsert): Promise<MemberRecord> {
    const existing = this.members.get(member.discordUserId);
    const now = new Date();
    const record: MemberRecord = {
      ...member,
      firstOnboardedAt: existing?.firstOnboardedAt ?? now,
      lastSyncedAt: now,
    };
    this.members.set(member.discordUserId, record);
    return { ...record };
  }

  async findByDiscordId(discordUserId: string): Promise<MemberRecord | undefined> {
    const record = this.members.get(discordUserId);
    return record ? { ...record } : undefined;
  }

  async findByMeetupId(meetupId: string): Promise<MemberRecord | undefined> {
    for (const record of this.members.values()) {
      if (record.meetupId === meetupId) {
        return { ...record };
      }
    }
    return undefined;
  }

  async listAll(): Promise<MemberRecord[]> {
    return [...this.members.values()].map((record) => ({ ...record }));
  }

  async remove(discordUserId: string): Promise<void> {
    this.members.delete(discordUserId);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `yarn test tst/lib/repositories/inMemoryMemberRepository.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Lint and commit**

```bash
yarn lint
git add src/lib/repositories tst/lib/repositories
git commit -m "feat: add MemberRepository interface and in-memory implementation

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: PostgresMemberRepository + selector + gated integration test

**Files:**
- Create: `src/lib/repositories/postgresMemberRepository.ts`
- Create: `src/util/memberRepository.ts`
- Test: `tst/integration/postgresMemberRepository.test.ts`

**Interfaces:**
- Consumes: `MemberRepository`, `MemberRecord`, `MemberUpsert` from `src/lib/repositories/types.js`; `InMemoryMemberRepository` from Task 1.
- Produces:
  - `PostgresMemberRepository.instance(): Promise<PostgresMemberRepository>` (async static, mirrors `RedisCache.instance()`; ensures schema on first call).
  - `ApplicationMemberRepository(): Promise<MemberRepository>` in `src/util/memberRepository.ts` — Postgres when `process.env.DATABASE_URL` is set, in-memory singleton otherwise. **All later tasks obtain the repo only through this function.**

- [ ] **Step 1: Add the pg dependency**

```bash
yarn add pg
yarn add -D @types/pg
```

- [ ] **Step 2: Write the failing integration test**

Create `tst/integration/postgresMemberRepository.test.ts`:

```typescript
import crypto from 'crypto';
import { beforeAll, describe, expect, it } from 'vitest';

import { PostgresMemberRepository } from '../../src/lib/repositories/postgresMemberRepository.js';

// Exercises the repository against a real Postgres (upsert conflict targets,
// TIMESTAMPTZ round-trips, and partial-unique semantics are exactly what a
// mock would paper over). Requires DATABASE_URL; skipped otherwise, matching
// the RedisCache integration suite pattern. Locally:
//   docker run --rm -p 5432:5432 -e POSTGRES_PASSWORD=pw postgres
//   DATABASE_URL=postgres://postgres:pw@localhost:5432/postgres yarn test:integration
const POSTGRES_AVAILABLE = Boolean(process.env.DATABASE_URL);

if (!POSTGRES_AVAILABLE) {
  // eslint-disable-next-line no-console
  console.warn(
    'Skipping PostgresMemberRepository integration tests: set DATABASE_URL to a reachable Postgres to run them.'
  );
}

const freshMember = () => ({
  discordUserId: `discord-${crypto.randomUUID()}`,
  meetupId: `meetup-${crypto.randomUUID()}`,
  meetupName: 'Integration Test',
  meetupMemberUrl: 'https://www.meetup.com/members/42/',
  onboardMethod: 'self_onboard' as const,
  onboardedBy: null,
});

(POSTGRES_AVAILABLE ? describe : describe.skip)(
  'PostgresMemberRepository (integration)',
  () => {
    let repo: PostgresMemberRepository;

    beforeAll(async () => {
      repo = await PostgresMemberRepository.instance();
    });

    it('returns undefined for unknown lookups', async () => {
      expect(await repo.findByDiscordId(crypto.randomUUID())).toBeUndefined();
      expect(await repo.findByMeetupId(crypto.randomUUID())).toBeUndefined();
    });

    it('round-trips a member through upsert/find', async () => {
      const member = freshMember();
      const stored = await repo.upsert(member);

      expect(stored.firstOnboardedAt).toBeInstanceOf(Date);
      expect(await repo.findByDiscordId(member.discordUserId)).toMatchObject(
        member
      );
      expect(await repo.findByMeetupId(member.meetupId)).toMatchObject(member);
    });

    it('upsert on the same discord user updates in place', async () => {
      const member = freshMember();
      const first = await repo.upsert(member);
      const updated = await repo.upsert({ ...member, meetupName: 'Renamed' });

      expect(updated.meetupName).toBe('Renamed');
      expect(updated.firstOnboardedAt).toEqual(first.firstOnboardedAt);
    });

    it('allows multiple NULL meetup_id rows but rejects duplicate meetup_id', async () => {
      const manualA = { ...freshMember(), meetupId: null, onboardMethod: 'manual' as const };
      const manualB = { ...freshMember(), meetupId: null, onboardMethod: 'manual' as const };
      await repo.upsert(manualA);
      await repo.upsert(manualB); // two NULLs must coexist

      const linked = freshMember();
      await repo.upsert(linked);
      await expect(
        repo.upsert({ ...freshMember(), meetupId: linked.meetupId })
      ).rejects.toThrow(); // unique violation on meetup_id
    });

    it('remove deletes the row', async () => {
      const member = freshMember();
      await repo.upsert(member);
      await repo.remove(member.discordUserId);

      expect(await repo.findByDiscordId(member.discordUserId)).toBeUndefined();
    });
  }
);
```

- [ ] **Step 3: Run test to verify it fails**

Run: `DATABASE_URL=postgres://postgres:pw@localhost:5432/postgres yarn test:integration tst/integration/postgresMemberRepository.test.ts`
(Start Postgres first: `docker run --rm -d -p 5432:5432 -e POSTGRES_PASSWORD=pw --name plan-pg postgres`. If Docker is unavailable on this machine, run the suite without `DATABASE_URL` and confirm it *skips with the warning* — the real run then happens in CI/rollout.)
Expected: FAIL — cannot resolve `postgresMemberRepository.js`.

- [ ] **Step 4: Write the implementation**

Create `src/lib/repositories/postgresMemberRepository.ts`:

```typescript
import pg from 'pg';

import {
  MemberRecord,
  MemberRepository,
  MemberUpsert,
  OnboardMethod,
} from './types.js';

const CREATE_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS members (
  discord_user_id    TEXT PRIMARY KEY,
  meetup_id          TEXT UNIQUE,
  meetup_name        TEXT,
  meetup_member_url  TEXT,
  onboard_method     TEXT NOT NULL,
  onboarded_by       TEXT,
  first_onboarded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_synced_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
`;

interface MemberRow {
  discord_user_id: string;
  meetup_id: string | null;
  meetup_name: string | null;
  meetup_member_url: string | null;
  onboard_method: OnboardMethod;
  onboarded_by: string | null;
  first_onboarded_at: Date;
  last_synced_at: Date;
}

function toRecord(row: MemberRow): MemberRecord {
  return {
    discordUserId: row.discord_user_id,
    meetupId: row.meetup_id,
    meetupName: row.meetup_name,
    meetupMemberUrl: row.meetup_member_url,
    onboardMethod: row.onboard_method,
    onboardedBy: row.onboarded_by,
    firstOnboardedAt: row.first_onboarded_at,
    lastSyncedAt: row.last_synced_at,
  };
}

/**
 * Postgres-backed MemberRepository. Used when DATABASE_URL is set (Heroku
 * Postgres injects it). Schema is ensured once, lazily, on instance().
 */
export class PostgresMemberRepository implements MemberRepository {
  private pool: pg.Pool;

  private static singleton: PostgresMemberRepository;

  private constructor() {
    const connectionString = process.env.DATABASE_URL;
    const isLocal =
      connectionString.includes('localhost') ||
      connectionString.includes('127.0.0.1');
    this.pool = new pg.Pool({
      connectionString,
      max: 5, // Essential-0 allows 20 connections total; leave headroom
      // Heroku Postgres requires TLS but uses certs node rejects by default
      ssl: isLocal ? undefined : { rejectUnauthorized: false },
    });
  }

  public static async instance(): Promise<PostgresMemberRepository> {
    if (this.singleton === undefined) {
      this.singleton = new PostgresMemberRepository();
      await this.singleton.pool.query(CREATE_TABLE_SQL);
    }
    return this.singleton;
  }

  async upsert(member: MemberUpsert): Promise<MemberRecord> {
    const result = await this.pool.query<MemberRow>(
      `INSERT INTO members
         (discord_user_id, meetup_id, meetup_name, meetup_member_url, onboard_method, onboarded_by)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (discord_user_id) DO UPDATE SET
         meetup_id = EXCLUDED.meetup_id,
         meetup_name = EXCLUDED.meetup_name,
         meetup_member_url = EXCLUDED.meetup_member_url,
         onboard_method = EXCLUDED.onboard_method,
         onboarded_by = EXCLUDED.onboarded_by,
         last_synced_at = now()
       RETURNING *`,
      [
        member.discordUserId,
        member.meetupId,
        member.meetupName,
        member.meetupMemberUrl,
        member.onboardMethod,
        member.onboardedBy,
      ]
    );
    return toRecord(result.rows[0]);
  }

  async findByDiscordId(discordUserId: string): Promise<MemberRecord | undefined> {
    const result = await this.pool.query<MemberRow>(
      'SELECT * FROM members WHERE discord_user_id = $1',
      [discordUserId]
    );
    return result.rows[0] ? toRecord(result.rows[0]) : undefined;
  }

  async findByMeetupId(meetupId: string): Promise<MemberRecord | undefined> {
    const result = await this.pool.query<MemberRow>(
      'SELECT * FROM members WHERE meetup_id = $1',
      [meetupId]
    );
    return result.rows[0] ? toRecord(result.rows[0]) : undefined;
  }

  async listAll(): Promise<MemberRecord[]> {
    const result = await this.pool.query<MemberRow>('SELECT * FROM members');
    return result.rows.map(toRecord);
  }

  async remove(discordUserId: string): Promise<void> {
    await this.pool.query('DELETE FROM members WHERE discord_user_id = $1', [
      discordUserId,
    ]);
  }
}
```

Create `src/util/memberRepository.ts` (mirrors `src/util/cache.ts`):

```typescript
import { InMemoryMemberRepository } from '../lib/repositories/inMemoryMemberRepository.js';
import { PostgresMemberRepository } from '../lib/repositories/postgresMemberRepository.js';
import { MemberRepository } from '../lib/repositories/types.js';

export const ApplicationMemberRepository = async (): Promise<MemberRepository> => {
  return process.env.DATABASE_URL
    ? PostgresMemberRepository.instance()
    : InMemoryMemberRepository.instance();
};
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `DATABASE_URL=postgres://postgres:pw@localhost:5432/postgres yarn test:integration tst/integration/postgresMemberRepository.test.ts`
Expected: PASS (5 tests). Without Docker: run `yarn test:integration` (no DATABASE_URL) and confirm the suite skips with the warning; also run `yarn test` to confirm nothing else broke.

- [ ] **Step 6: Lint and commit**

```bash
yarn lint
git add package.json yarn.lock src/lib/repositories/postgresMemberRepository.ts src/util/memberRepository.ts tst/integration/postgresMemberRepository.test.ts
git commit -m "feat: add Postgres member repository behind DATABASE_URL selector

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Create the two log channels + constants

**Files:**
- Create: `scripts/createLogChannels.ts`
- Modify: `src/constants.ts` (append after `LGBTQ_CHANNEL_ID`, line ~50)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `BOT_ACTIVITY_LOG_CHANNEL_ID` and `BOT_ALERTS_CHANNEL_ID` string constants in `src/constants.ts` — Task 4's logger reads these.

**Note:** this task has a live side effect (creates two channels in the production Discord server). It was explicitly approved during brainstorming. The script is idempotent-safe to re-run only in the sense that re-running creates duplicates — run it once, and if run twice, delete the extras in Discord.

- [ ] **Step 1: Write the script**

Create `scripts/createLogChannels.ts`:

```typescript
/* eslint-disable no-console */
// One-off script: creates the two Meetup-bot log channels and prints their
// IDs so they can be hardcoded in src/constants.ts. Run once:
//   source .env && npx tsx scripts/createLogChannels.ts
import { ChannelType, Client, GatewayIntentBits } from 'discord.js';

const LOGS_CATEGORY_ID = '932896530447364146'; // 📜Logs
const LEADERSHIP_CATEGORY_ID = '912463487257686066'; // 🏢1.5 Leadership Team

async function main() {
  const client = new Client({ intents: [GatewayIntentBits.Guilds] });
  await client.login(process.env.DISCORD_API_KEY);

  const guilds = await client.guilds.fetch();
  const guildId = guilds.first()?.id;
  if (!guildId) {
    throw new Error('Bot is not in any guild');
  }
  const guild = await client.guilds.fetch(guildId);
  console.log(`Creating log channels in guild: ${guild.name}`);

  const activity = await guild.channels.create({
    name: '🟥🤖meetup-bot-activity',
    type: ChannelType.GuildText,
    parent: LOGS_CATEGORY_ID,
    reason: 'Meetup bot activity log (created by createLogChannels script)',
  });
  const alerts = await guild.channels.create({
    name: '🟥🚨meetup-bot-alerts',
    type: ChannelType.GuildText,
    parent: LEADERSHIP_CATEGORY_ID,
    reason: 'Meetup bot alerts log (created by createLogChannels script)',
  });

  console.log(`BOT_ACTIVITY_LOG_CHANNEL_ID = '${activity.id}'`);
  console.log(`BOT_ALERTS_CHANNEL_ID = '${alerts.id}'`);

  await client.destroy();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
```

- [ ] **Step 2: Run the script once**

Run: `source .env && npx tsx scripts/createLogChannels.ts`
Expected output (IDs will differ):

```
Creating log channels in guild: 1.5 Gen Asians Meetup Group
BOT_ACTIVITY_LOG_CHANNEL_ID = '14xxxxxxxxxxxxxxxxx'
BOT_ALERTS_CHANNEL_ID = '14xxxxxxxxxxxxxxxxx'
```

- [ ] **Step 3: Add the printed IDs to constants**

In `src/constants.ts`, directly below the `LGBTQ_CHANNEL_ID` line, add (using the *actual* IDs printed in Step 2):

```typescript
// Meetup bot log channels (created by scripts/createLogChannels.ts)
export const BOT_ACTIVITY_LOG_CHANNEL_ID = '<id printed in step 2>';
export const BOT_ALERTS_CHANNEL_ID = '<id printed in step 2>';
```

- [ ] **Step 4: Verify channels exist in Discord**

Run: `source .env && curl -s -H "Authorization: Bot $DISCORD_API_KEY" "https://discord.com/api/v10/channels/<BOT_ACTIVITY_LOG_CHANNEL_ID>" | head -c 300`
Expected: JSON for the channel with `"name":"🟥🤖meetup-bot-activity"` and `"parent_id":"932896530447364146"`. Repeat for the alerts channel (`parent_id` `912463487257686066`).

- [ ] **Step 5: Lint and commit**

```bash
yarn lint
git add scripts/createLogChannels.ts src/constants.ts
git commit -m "feat: create meetup-bot-activity and meetup-bot-alerts log channels

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: discordLogger helper

**Files:**
- Create: `src/lib/helpers/discordLogger.ts`
- Test: `tst/lib/helpers/discordLogger.test.ts`

**Interfaces:**
- Consumes: `BOT_ACTIVITY_LOG_CHANNEL_ID`, `BOT_ALERTS_CHANNEL_ID` from `src/constants.js` (Task 3).
- Produces (used by Tasks 5–9):

```typescript
export interface LogEntry {
  title: string;
  description?: string;
  fields?: { name: string; value: string; inline?: boolean }[];
}
export function logActivity(client: Client, entry: LogEntry): Promise<void>;
export function logAlert(client: Client, entry: LogEntry): Promise<void>;
```

Both resolve (never reject, never throw) regardless of Discord failures.

- [ ] **Step 1: Write the failing test**

Create `tst/lib/helpers/discordLogger.test.ts`:

```typescript
/* eslint-disable @typescript-eslint/no-explicit-any */
import { Client, TextChannel } from 'discord.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { BOT_ACTIVITY_LOG_CHANNEL_ID } from '../../../src/constants.js';
import { logActivity, logAlert } from '../../../src/lib/helpers/discordLogger.js';

function makeClient(sendMock: ReturnType<typeof vi.fn>, options?: { fetchFails?: boolean }) {
  const channel = Object.create(TextChannel.prototype) as TextChannel;
  (channel as any).send = sendMock;
  return {
    channels: {
      fetch: options?.fetchFails
        ? vi.fn().mockRejectedValue(new Error('fetch failed'))
        : vi.fn().mockResolvedValue(channel),
    },
  } as unknown as Client;
}

describe('discordLogger', () => {
  let sendMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    sendMock = vi.fn().mockResolvedValue(undefined);
  });

  it('logActivity sends one embed to the activity channel with pings disabled', async () => {
    const client = makeClient(sendMock);
    await logActivity(client, { title: 'User onboarded' });

    expect(client.channels.fetch).toHaveBeenCalledWith(
      BOT_ACTIVITY_LOG_CHANNEL_ID
    );
    expect(sendMock).toHaveBeenCalledTimes(1);
    const payload = sendMock.mock.calls[0][0];
    expect(payload.embeds).toHaveLength(1);
    expect(payload.allowedMentions).toEqual({ parse: [] });
  });

  it('logAlert includes fields in the embed', async () => {
    const client = makeClient(sendMock);
    await logAlert(client, {
      title: 'Duplicate blocked',
      fields: [{ name: 'Meetup ID', value: '123' }],
    });

    const embed = sendMock.mock.calls[0][0].embeds[0];
    expect(embed.data.title).toBe('Duplicate blocked');
    expect(embed.data.fields).toEqual([
      { name: 'Meetup ID', value: '123', inline: undefined },
    ]);
  });

  it('never throws when channel fetch fails', async () => {
    const client = makeClient(sendMock, { fetchFails: true });
    await expect(logActivity(client, { title: 'x' })).resolves.toBeUndefined();
    await expect(logAlert(client, { title: 'x' })).resolves.toBeUndefined();
  });

  it('never throws when send fails', async () => {
    sendMock.mockRejectedValue(new Error('rate limited'));
    const client = makeClient(sendMock);
    await expect(logActivity(client, { title: 'x' })).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn test tst/lib/helpers/discordLogger.test.ts`
Expected: FAIL — module `discordLogger.js` not found.

- [ ] **Step 3: Write the implementation**

Create `src/lib/helpers/discordLogger.ts`:

```typescript
import { Client, EmbedBuilder, TextChannel } from 'discord.js';
import { Logger } from 'tslog';

import {
  BOT_ACTIVITY_LOG_CHANNEL_ID,
  BOT_ALERTS_CHANNEL_ID,
} from '../../constants.js';

const logger = new Logger({ name: 'discordLogger' });

const COLORS = {
  activity: 0x2ecc71, // green
  alert: 0xe74c3c, // red
};

export interface LogEntry {
  title: string;
  description?: string;
  fields?: { name: string; value: string; inline?: boolean }[];
}

/**
 * Posts an embed to a log channel. Deliberately swallows every error:
 * Discord logging must never break the command that triggered it.
 */
async function postToChannel(
  client: Client,
  channelId: string,
  color: number,
  entry: LogEntry
): Promise<void> {
  try {
    const channel = await client.channels.fetch(channelId);
    if (!(channel instanceof TextChannel)) {
      logger.warn(`Log channel ${channelId} is missing or not a text channel`);
      return;
    }
    const embed = new EmbedBuilder()
      .setTitle(entry.title)
      .setColor(color)
      .setTimestamp(new Date());
    if (entry.description) {
      embed.setDescription(entry.description);
    }
    for (const field of entry.fields ?? []) {
      embed.addFields(field);
    }
    await channel.send({
      embeds: [embed],
      // Log entries mention users for readability; never ping them.
      allowedMentions: { parse: [] },
    });
  } catch (error) {
    logger.warn(`Failed to post log entry "${entry.title}": ${String(error)}`);
  }
}

export async function logActivity(client: Client, entry: LogEntry): Promise<void> {
  await postToChannel(client, BOT_ACTIVITY_LOG_CHANNEL_ID, COLORS.activity, entry);
}

export async function logAlert(client: Client, entry: LogEntry): Promise<void> {
  await postToChannel(client, BOT_ALERTS_CHANNEL_ID, COLORS.alert, entry);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `yarn test tst/lib/helpers/discordLogger.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Lint and commit**

```bash
yarn lint
git add src/lib/helpers/discordLogger.ts tst/lib/helpers/discordLogger.test.ts
git commit -m "feat: add discordLogger helper for activity and alert channels

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: discordCommandWrapper hooks + hasAnyServerRole

**Files:**
- Modify: `src/util/discord.ts` (wrapper at lines 22–43; add `hasAnyServerRole` near `isAdmin`)
- Test: `tst/commands/meetup/util/discord.test.ts`

**Interfaces:**
- Consumes: `logActivity`, `logAlert` from Task 4.
- Produces:
  - `discordCommandWrapper` (same signature) now also posts an activity entry on success and an alert entry on error.
  - `describeInteraction(interaction): string` — `"/name"` for commands, `"button:custom_id"` for buttons, `"modal:custom_id"` for modals.
  - `hasAnyServerRole(member: GuildMember, roles: ServerRoles[]): boolean` — used by Task 8's `/meetup_unlink` gate.

- [ ] **Step 1: Write the failing test**

Create `tst/commands/meetup/util/discord.test.ts`:

```typescript
/* eslint-disable @typescript-eslint/no-explicit-any */
import { ButtonInteraction, CommandInteraction, GuildMember } from 'discord.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { SERVER_ROLES } from '../../../../src/constants.js';
import * as discordLogger from '../../../../src/lib/helpers/discordLogger.js';
import {
  describeInteraction,
  discordCommandWrapper,
  hasAnyServerRole,
} from '../../../../src/util/discord.js';

vi.mock('../../../../src/lib/helpers/discordLogger.js', () => ({
  logActivity: vi.fn().mockResolvedValue(undefined),
  logAlert: vi.fn().mockResolvedValue(undefined),
}));

function makeInteraction(overrides: Record<string, unknown> = {}) {
  return {
    client: {},
    user: { id: 'user-1', username: 'testUser', toString: () => '<@user-1>' },
    commandName: 'test_command',
    isChatInputCommand: () => true,
    reply: vi.fn().mockResolvedValue({ delete: vi.fn().mockResolvedValue(undefined) }),
    editReply: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as CommandInteraction;
}

describe('describeInteraction', () => {
  it('formats slash commands and buttons', () => {
    expect(describeInteraction(makeInteraction())).toBe('/test_command');
    const button = {
      isChatInputCommand: () => false,
      isButton: () => true,
      customId: 'sync_meetup_account',
    } as unknown as ButtonInteraction;
    expect(describeInteraction(button)).toBe('button:sync_meetup_account');
  });
});

describe('discordCommandWrapper logging hooks', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('posts an activity entry on success', async () => {
    const interaction = makeInteraction();
    await discordCommandWrapper(interaction, async () => {});

    expect(vi.mocked(discordLogger.logActivity)).toHaveBeenCalledTimes(1);
    const [, entry] = vi.mocked(discordLogger.logActivity).mock.calls[0];
    expect(entry.title).toContain('/test_command');
    expect(vi.mocked(discordLogger.logAlert)).not.toHaveBeenCalled();
  });

  it('posts an alert entry on error and still edits the reply', async () => {
    const interaction = makeInteraction();
    await discordCommandWrapper(interaction, async () => {
      throw new Error('boom');
    });

    expect(vi.mocked(discordLogger.logAlert)).toHaveBeenCalledTimes(1);
    const [, entry] = vi.mocked(discordLogger.logAlert).mock.calls[0];
    expect(entry.title).toContain('/test_command');
    expect(entry.description).toContain('boom');
    expect(interaction.editReply).toHaveBeenCalled();
  });
});

describe('hasAnyServerRole', () => {
  const memberWithRoles = (...roleIds: string[]) =>
    ({
      roles: { cache: new Map(roleIds.map((id) => [id, {}])) },
    }) as unknown as GuildMember;

  it('matches when the member has one of the roles', () => {
    const member = memberWithRoles(SERVER_ROLES.moderator);
    expect(hasAnyServerRole(member, ['moderator', 'organizer'])).toBe(true);
  });

  it('does not match when the member has none of the roles', () => {
    const member = memberWithRoles(SERVER_ROLES.bots);
    expect(hasAnyServerRole(member, ['moderator', 'organizer'])).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn test tst/commands/meetup/util/discord.test.ts`
Expected: FAIL — `describeInteraction` / `hasAnyServerRole` not exported.

- [ ] **Step 3: Modify src/util/discord.ts**

Add imports at the top (keeping existing ones):

```typescript
import { SERVER_ROLES, ServerRoles } from '../constants.js';
import { logActivity, logAlert } from '../lib/helpers/discordLogger.js';
```

Add above `discordCommandWrapper`:

```typescript
export function describeInteraction(
  interaction: ButtonInteraction | CommandInteraction | ModalSubmitInteraction
): string {
  if (interaction.isChatInputCommand?.()) {
    return `/${interaction.commandName}`;
  }
  if ('commandName' in interaction) {
    return `/${interaction.commandName}`;
  }
  if (interaction.isButton?.()) {
    return `button:${interaction.customId}`;
  }
  return `modal:${interaction.customId}`;
}
```

Replace the body of `discordCommandWrapper` with:

```typescript
export async function discordCommandWrapper(
  interaction: ButtonInteraction | CommandInteraction | ModalSubmitInteraction,
  commandFn: () => Promise<void>
) {
  const message = await interaction.reply({
    content: 'Executing command',
    ephemeral: true,
  });
  const action = describeInteraction(interaction);
  try {
    await commandFn();
    await message.delete();
    await logActivity(interaction.client, {
      title: `${action} used`,
      description: `By ${interaction.user.toString()} (${interaction.user.username})`,
    });
  } catch (error: unknown) {
    if (error instanceof Error) {
      logger.error(error);
      await logAlert(interaction.client, {
        title: `${action} failed`,
        description: `User: ${interaction.user.toString()} (${interaction.user.username})\nError: ${error.message}`,
      });
      await interaction.editReply({
        content: `${interaction.user.toString()} Error: ${
          error?.message
        } Please reach out to a moderator for help.`,
      });
    }
  }
}
```

Add next to `isAdmin`:

```typescript
export function hasAnyServerRole(member: GuildMember, roles: ServerRoles[]) {
  return roles.some((role) => member.roles.cache.has(SERVER_ROLES[role]));
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `yarn test`
Expected: PASS — new suite green, and the pre-existing `getUserRoles` suite still green (it exercises code paths that call the wrapper indirectly; if it now fails on the discordLogger import, add the same `vi.mock` of `discordLogger.js` there).

- [ ] **Step 5: Lint and commit**

```bash
yarn lint
git add src/util/discord.ts tst/commands/meetup/util/discord.test.ts
git commit -m "feat: log every command invocation and failure to Discord channels

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: memberLink helper (duplicate rules)

**Files:**
- Create: `src/lib/helpers/memberLink.ts`
- Test: `tst/lib/helpers/memberLink.test.ts`

**Interfaces:**
- Consumes: `ApplicationMemberRepository()` (Task 2), `logActivity`/`logAlert` (Task 4), `linkStr` from `src/util/discord.js`.
- Produces (used by Task 7):

```typescript
export class DuplicateMeetupAccountError extends Error {}

export interface MeetupLinkInfo {
  meetupId: string;
  meetupName: string;
  meetupMemberUrl: string;
}

// Throws DuplicateMeetupAccountError when the Meetup account belongs to a
// different Discord user. Swallows repository failures (alerting instead).
export function recordMeetupLink(
  interaction: ButtonInteraction | CommandInteraction,
  info: MeetupLinkInfo,
  method: 'self_onboard' | 'sync_v2'
): Promise<void>;

// Never throws. Skips the write when the target already has a linked row.
export function recordManualOnboard(
  interaction: CommandInteraction | MessageContextMenuCommandInteraction | UserContextMenuCommandInteraction,
  targetUserId: string
): Promise<void>;
```

- [ ] **Step 1: Write the failing test**

Create `tst/lib/helpers/memberLink.test.ts`:

```typescript
/* eslint-disable @typescript-eslint/no-explicit-any */
import { CommandInteraction } from 'discord.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import * as discordLogger from '../../../src/lib/helpers/discordLogger.js';
import {
  DuplicateMeetupAccountError,
  recordManualOnboard,
  recordMeetupLink,
} from '../../../src/lib/helpers/memberLink.js';
import { InMemoryMemberRepository } from '../../../src/lib/repositories/inMemoryMemberRepository.js';
import * as memberRepository from '../../../src/util/memberRepository.js';

vi.mock('../../../src/lib/helpers/discordLogger.js', () => ({
  logActivity: vi.fn().mockResolvedValue(undefined),
  logAlert: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../../src/util/memberRepository.js', () => ({
  ApplicationMemberRepository: vi.fn(),
}));

const info = {
  meetupId: 'meetup-1',
  meetupName: 'Test User',
  meetupMemberUrl: 'https://www.meetup.com/members/1/',
};

function makeInteraction(userId = 'discord-1') {
  return {
    client: {},
    user: { id: userId, username: 'testUser', toString: () => `<@${userId}>` },
  } as unknown as CommandInteraction;
}

describe('recordMeetupLink', () => {
  let repo: InMemoryMemberRepository;

  beforeEach(() => {
    vi.clearAllMocks();
    repo = new InMemoryMemberRepository();
    vi.mocked(memberRepository.ApplicationMemberRepository).mockResolvedValue(repo);
  });

  it('stores a new link and logs activity', async () => {
    await recordMeetupLink(makeInteraction(), info, 'self_onboard');

    const row = await repo.findByDiscordId('discord-1');
    expect(row).toMatchObject({
      meetupId: 'meetup-1',
      meetupName: 'Test User',
      onboardMethod: 'self_onboard',
    });
    expect(vi.mocked(discordLogger.logActivity)).toHaveBeenCalled();
    expect(vi.mocked(discordLogger.logAlert)).not.toHaveBeenCalled();
  });

  it('blocks when the Meetup account is linked to another Discord user', async () => {
    await recordMeetupLink(makeInteraction('discord-1'), info, 'self_onboard');

    await expect(
      recordMeetupLink(makeInteraction('discord-2'), info, 'sync_v2')
    ).rejects.toThrow(DuplicateMeetupAccountError);

    expect(await repo.findByDiscordId('discord-2')).toBeUndefined();
    expect(vi.mocked(discordLogger.logAlert)).toHaveBeenCalledTimes(1);
  });

  it('alerts (but allows) when a user switches Meetup accounts', async () => {
    await recordMeetupLink(makeInteraction(), info, 'self_onboard');
    await recordMeetupLink(
      makeInteraction(),
      { ...info, meetupId: 'meetup-2' },
      'self_onboard'
    );

    expect((await repo.findByDiscordId('discord-1'))?.meetupId).toBe('meetup-2');
    expect(vi.mocked(discordLogger.logAlert)).toHaveBeenCalledTimes(1);
  });

  it('re-sync of the same account is activity only', async () => {
    await recordMeetupLink(makeInteraction(), info, 'self_onboard');
    await recordMeetupLink(makeInteraction(), info, 'self_onboard');

    expect(vi.mocked(discordLogger.logAlert)).not.toHaveBeenCalled();
    expect(vi.mocked(discordLogger.logActivity)).toHaveBeenCalledTimes(2);
  });

  it('swallows repository failures and alerts instead of throwing', async () => {
    vi.mocked(memberRepository.ApplicationMemberRepository).mockRejectedValue(
      new Error('db down')
    );

    await expect(
      recordMeetupLink(makeInteraction(), info, 'self_onboard')
    ).resolves.toBeUndefined();
    expect(vi.mocked(discordLogger.logAlert)).toHaveBeenCalledTimes(1);
  });
});

describe('recordManualOnboard', () => {
  let repo: InMemoryMemberRepository;

  beforeEach(() => {
    vi.clearAllMocks();
    repo = new InMemoryMemberRepository();
    vi.mocked(memberRepository.ApplicationMemberRepository).mockResolvedValue(repo);
  });

  it('records a null-meetup row and alerts (deprecated flow)', async () => {
    await recordManualOnboard(makeInteraction('mod-1') as any, 'target-1');

    const row = await repo.findByDiscordId('target-1');
    expect(row).toMatchObject({
      meetupId: null,
      onboardMethod: 'manual',
      onboardedBy: 'mod-1',
    });
    expect(vi.mocked(discordLogger.logAlert)).toHaveBeenCalledTimes(1);
  });

  it('does not overwrite an existing linked row', async () => {
    await recordMeetupLink(makeInteraction('target-1'), info, 'self_onboard');
    vi.clearAllMocks();
    vi.mocked(memberRepository.ApplicationMemberRepository).mockResolvedValue(repo);

    await recordManualOnboard(makeInteraction('mod-1') as any, 'target-1');

    expect((await repo.findByDiscordId('target-1'))?.meetupId).toBe('meetup-1');
  });

  it('never throws on repository failure', async () => {
    vi.mocked(memberRepository.ApplicationMemberRepository).mockRejectedValue(
      new Error('db down')
    );
    await expect(
      recordManualOnboard(makeInteraction('mod-1') as any, 'target-1')
    ).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn test tst/lib/helpers/memberLink.test.ts`
Expected: FAIL — module `memberLink.js` not found.

- [ ] **Step 3: Write the implementation**

Create `src/lib/helpers/memberLink.ts`:

```typescript
import {
  ButtonInteraction,
  CommandInteraction,
  MessageContextMenuCommandInteraction,
  UserContextMenuCommandInteraction,
} from 'discord.js';
import { Logger } from 'tslog';

import { linkStr } from '../../util/discord.js';
import { ApplicationMemberRepository } from '../../util/memberRepository.js';
import { logActivity, logAlert } from './discordLogger.js';

const logger = new Logger({ name: 'memberLink' });

const strings = {
  duplicateAccount:
    'This Meetup account is already linked to another Discord account — please contact the mods.',
};

export class DuplicateMeetupAccountError extends Error {}

export interface MeetupLinkInfo {
  meetupId: string;
  meetupName: string;
  meetupMemberUrl: string;
}

/**
 * Records a successful Meetup link in the members table.
 * - Blocks (throws DuplicateMeetupAccountError) when the Meetup account is
 *   already linked to a different Discord user.
 * - Alerts (but allows) when this Discord user switches Meetup accounts.
 * - Repository failures never block onboarding: they alert instead.
 */
export async function recordMeetupLink(
  interaction: ButtonInteraction | CommandInteraction,
  info: MeetupLinkInfo,
  method: 'self_onboard' | 'sync_v2'
): Promise<void> {
  const { client, user } = interaction;
  const meetupLink = linkStr(info.meetupName, info.meetupMemberUrl);
  try {
    const repo = await ApplicationMemberRepository();

    const claimedBy = await repo.findByMeetupId(info.meetupId);
    if (claimedBy && claimedBy.discordUserId !== user.id) {
      await logAlert(client, {
        title: 'Duplicate Meetup link blocked',
        description: `${user.toString()} tried to link ${meetupLink}, already linked to <@${claimedBy.discordUserId}>.`,
        fields: [{ name: 'Meetup ID', value: info.meetupId }],
      });
      throw new DuplicateMeetupAccountError(strings.duplicateAccount);
    }

    const existing = await repo.findByDiscordId(user.id);
    if (existing?.meetupId && existing.meetupId !== info.meetupId) {
      await logAlert(client, {
        title: 'Meetup account changed',
        description: `${user.toString()} switched their linked Meetup account.`,
        fields: [
          { name: 'Old Meetup ID', value: existing.meetupId, inline: true },
          { name: 'New Meetup ID', value: info.meetupId, inline: true },
        ],
      });
    }

    await repo.upsert({
      discordUserId: user.id,
      meetupId: info.meetupId,
      meetupName: info.meetupName,
      meetupMemberUrl: info.meetupMemberUrl,
      onboardMethod: method,
      onboardedBy: null,
    });

    await logActivity(client, {
      title: 'Meetup account linked',
      description: `${user.toString()} (${user.username}) ↔ ${meetupLink}`,
      fields: [
        { name: 'Meetup ID', value: info.meetupId, inline: true },
        { name: 'Method', value: method, inline: true },
      ],
    });
  } catch (error) {
    if (error instanceof DuplicateMeetupAccountError) {
      throw error;
    }
    logger.error(`Failed to record Meetup link: ${String(error)}`);
    await logAlert(client, {
      title: 'Database write failed during onboarding',
      description: `Could not record Meetup link for ${user.toString()}: ${String(error)}`,
    });
  }
}

/**
 * Records a manual (mod-driven) onboard as a meetup_id=NULL row. The manual
 * flow is deprecated; every use is also alerted. Never throws, and never
 * downgrades an existing linked row.
 */
export async function recordManualOnboard(
  interaction:
    | CommandInteraction
    | MessageContextMenuCommandInteraction
    | UserContextMenuCommandInteraction,
  targetUserId: string
): Promise<void> {
  const { client, user: mod } = interaction;
  try {
    const repo = await ApplicationMemberRepository();

    const existing = await repo.findByDiscordId(targetUserId);
    if (!existing?.meetupId) {
      await repo.upsert({
        discordUserId: targetUserId,
        meetupId: null,
        meetupName: null,
        meetupMemberUrl: null,
        onboardMethod: 'manual',
        onboardedBy: mod.id,
      });
    }

    await logAlert(client, {
      title: 'Manual onboard used (deprecated flow)',
      description: `${mod.toString()} manually onboarded <@${targetUserId}>. They have no Meetup account on record and should go through automated verification.`,
    });
  } catch (error) {
    logger.error(`Failed to record manual onboard: ${String(error)}`);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `yarn test tst/lib/helpers/memberLink.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Lint and commit**

```bash
yarn lint
git add src/lib/helpers/memberLink.ts tst/lib/helpers/memberLink.test.ts
git commit -m "feat: add memberLink helper with duplicate-link rules

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 7: Wire memberLink into all onboarding flows

**Files:**
- Modify: `src/lib/helpers/onboardUser.ts` (`selfOnboardUser` ~line 144; `onboardUser` ~line 123)
- Modify: `src/buttonMenu/meetup/syncAccountV2.ts` (after membership check, ~line 102)

**Interfaces:**
- Consumes: `recordMeetupLink`, `recordManualOnboard` (Task 6). `userInfo.self` provides `{ id, name, gender, memberUrl }` (see `UserFragment` in `src/lib/client/meetup/queries.ts`).
- Produces: no new exports — behavior change only. After this task every onboard path writes a row.

- [ ] **Step 1: Wire selfOnboardUser (covers live V1 button + /meetup_self_onboard)**

In `src/lib/helpers/onboardUser.ts`, add the import:

```typescript
import { recordMeetupLink } from './memberLink.js';
```

In `selfOnboardUser`, insert the `recordMeetupLink` call **immediately before** the existing `onboardUserCommon(...)` call — a `DuplicateMeetupAccountError` must abort onboarding before any nickname/role changes, and `discordCommandWrapper` turns the throw into the user-facing error reply:

```typescript
  await recordMeetupLink(
    interaction,
    {
      meetupId: userInfo.self.id,
      meetupName: userInfo.self.name,
      meetupMemberUrl: userInfo.self.memberUrl,
    },
    'self_onboard'
  );
  await onboardUserCommon(
    interaction,
    discordUser.id,
    userInfo.self.gender,
    cleanedName
  );
```

- [ ] **Step 2: Wire the V2 sync button**

In `src/buttonMenu/meetup/syncAccountV2.ts`, add the import:

```typescript
import { recordMeetupLink } from '../../lib/helpers/memberLink.js';
```

Immediately after the non-member check block (after the `throw new Error(...)` for non-members, before the `cleanedName` computation), insert:

```typescript
      await recordMeetupLink(
        interaction,
        {
          meetupId: userInfo.self.id,
          meetupName: userInfo.self.name,
          meetupMemberUrl: userInfo.self.memberUrl,
        },
        'sync_v2'
      );
```

- [ ] **Step 3: Wire manual onboards**

In `src/lib/helpers/onboardUser.ts`, add to the same import line from Step 1:

```typescript
import { recordManualOnboard, recordMeetupLink } from './memberLink.js';
```

In the `onboardUser` function (the manual flow), after `onboardUserCommon(...)` and before the moderator follow-up, insert:

```typescript
  await recordManualOnboard(interaction, userId);
```

- [ ] **Step 4: Typecheck, run full unit suite**

Run: `npx tsc --noEmit && yarn test`
Expected: clean typecheck; all suites PASS. The existing `getUserRoles.test.ts` mocks `onboardUser.js` wholesale, so it is unaffected.

- [ ] **Step 5: Commit**

```bash
yarn lint
git add src/lib/helpers/onboardUser.ts src/buttonMenu/meetup/syncAccountV2.ts
git commit -m "feat: persist Meetup link on every onboarding path

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 8: /meetup_unlink command

**Files:**
- Create: `src/commands/meetup/unlinkAccount.ts`

**Interfaces:**
- Consumes: `ApplicationMemberRepository()` (Task 2), `logActivity` (Task 4), `hasAnyServerRole`, `isAdmin`, `discordCommandWrapper` (Task 5). Registered automatically via the barrel import below.
- Produces: `/meetup_unlink user:<User>` slash command, usable by moderators, organizers, and admins.

- [ ] **Step 1: Write the command**

Create `src/commands/meetup/unlinkAccount.ts`:

```typescript
import {
  ApplicationCommandOptionType,
  CommandInteraction,
  User,
} from 'discord.js';
import { Discord, Slash, SlashOption } from 'discordx';
import { Logger } from 'tslog';

import { logActivity } from '../../lib/helpers/discordLogger.js';
import {
  discordCommandWrapper,
  hasAnyServerRole,
  isAdmin,
} from '../../util/discord.js';
import { ApplicationMemberRepository } from '../../util/memberRepository.js';

const logger = new Logger({ name: 'UnlinkAccountCommands' });

const strings = {
  notAllowed: 'Only moderators and organizers can unlink accounts.',
  noRow: (user: User) => `${user.toString()} has no member record to unlink.`,
  done: (user: User) =>
    `Unlinked ${user.toString()}. They can re-link via the Get Verified button.`,
};

@Discord()
export class UnlinkAccountCommands {
  @Slash({
    name: 'meetup_unlink',
    description: 'Remove a member\'s stored Meetup link (mods/organizers only)',
  })
  async meetupUnlinkHandler(
    @SlashOption({
      name: 'user',
      description: 'The Discord user to unlink',
      type: ApplicationCommandOptionType.User,
      required: true,
    })
    user: User,
    interaction: CommandInteraction
  ) {
    await discordCommandWrapper(interaction, async () => {
      const member = await interaction.guild.members.fetch(interaction.user.id);
      if (!isAdmin(member) && !hasAnyServerRole(member, ['moderator', 'organizer'])) {
        throw new Error(strings.notAllowed);
      }

      const repo = await ApplicationMemberRepository();
      const row = await repo.findByDiscordId(user.id);
      if (!row) {
        await interaction.followUp({
          content: strings.noRow(user),
          ephemeral: true,
        });
        return;
      }

      await repo.remove(user.id);
      logger.info(
        `${interaction.user.username} unlinked member record for ${user.username}`
      );
      await logActivity(interaction.client, {
        title: 'Member record unlinked',
        description: `${interaction.user.toString()} removed the stored link for ${user.toString()}.`,
        fields: [
          { name: 'Meetup ID', value: row.meetupId ?? 'none (manual row)' },
        ],
      });
      await interaction.followUp({
        content: strings.done(user),
        ephemeral: true,
      });
    });
  }
}
```

- [ ] **Step 2: Verify the command registers (barrel import)**

`src/commands/index.ts` imports command modules for discordx registration. Open it and add, following its existing style:

```typescript
import './meetup/unlinkAccount.js';
```

(If the barrel uses a different mechanism — e.g. `export * from`, or directory glob — match whatever pattern the neighboring meetup command files use.)

- [ ] **Step 3: Typecheck and unit tests**

Run: `npx tsc --noEmit && yarn test`
Expected: clean. (The permission gate's building blocks — `hasAnyServerRole`, repo `remove` — are unit-tested in Tasks 5 and 1; the decorator wiring is verified live in Task 10.)

- [ ] **Step 4: Lint and commit**

```bash
yarn lint
git add src/commands/meetup/unlinkAccount.ts src/commands/index.ts
git commit -m "feat: add /meetup_unlink escape-hatch command for mods

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 9: Daily unlinked-member digest

**Files:**
- Create: `src/lib/helpers/unlinkedDigest.ts`
- Modify: `src/index.ts` (`clientReady` handler, ~line 41)
- Test: `tst/lib/helpers/unlinkedDigest.test.ts`

**Interfaces:**
- Consumes: `ApplicationMemberRepository()` (Task 2), `ApplicationCache()` from `src/util/cache.js` (existing — `exclusive_set(key, value): Promise<boolean>`), `logAlert` (Task 4), `SERVER_ROLES` from `src/constants.js`.
- Produces:

```typescript
export const DIGEST_UTC_HOUR = 17;
export function shouldRunDigestNow(now: Date): boolean;
export function collectUnlinkedMemberIds(
  members: { id: string; isBot: boolean; hasOnboardingRole: boolean }[],
  rows: MemberRecord[]
): string[];
export function formatUnlinkedDigest(unlinkedIds: string[]): LogEntry | undefined;
export function startUnlinkedDigestScheduler(client: Client): void;
```

- [ ] **Step 1: Write the failing test**

Create `tst/lib/helpers/unlinkedDigest.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';

import {
  collectUnlinkedMemberIds,
  formatUnlinkedDigest,
  shouldRunDigestNow,
} from '../../../src/lib/helpers/unlinkedDigest.js';
import { MemberRecord } from '../../../src/lib/repositories/types.js';

const linkedRow = (discordUserId: string): MemberRecord => ({
  discordUserId,
  meetupId: `meetup-${discordUserId}`,
  meetupName: 'x',
  meetupMemberUrl: 'x',
  onboardMethod: 'self_onboard',
  onboardedBy: null,
  firstOnboardedAt: new Date(),
  lastSyncedAt: new Date(),
});

const manualRow = (discordUserId: string): MemberRecord => ({
  ...linkedRow(discordUserId),
  meetupId: null,
  onboardMethod: 'manual',
});

describe('shouldRunDigestNow', () => {
  it('fires only during the 17:00 UTC hour', () => {
    expect(shouldRunDigestNow(new Date('2026-08-14T17:30:00Z'))).toBe(true);
    expect(shouldRunDigestNow(new Date('2026-08-14T16:59:00Z'))).toBe(false);
    expect(shouldRunDigestNow(new Date('2026-08-14T18:00:00Z'))).toBe(false);
  });
});

describe('collectUnlinkedMemberIds', () => {
  it('flags verified humans with no row or a null-meetup row', () => {
    const members = [
      { id: 'linked', isBot: false, hasOnboardingRole: false },
      { id: 'norow', isBot: false, hasOnboardingRole: false },
      { id: 'manual', isBot: false, hasOnboardingRole: false },
      { id: 'bot', isBot: true, hasOnboardingRole: false },
      { id: 'newbie', isBot: false, hasOnboardingRole: true },
    ];
    const rows = [linkedRow('linked'), manualRow('manual')];

    expect(collectUnlinkedMemberIds(members, rows)).toEqual([
      'norow',
      'manual',
    ]);
  });
});

describe('formatUnlinkedDigest', () => {
  it('returns undefined when everyone is linked', () => {
    expect(formatUnlinkedDigest([])).toBeUndefined();
  });

  it('lists members and caps at 50 with an overflow note', () => {
    const few = formatUnlinkedDigest(['a', 'b']);
    expect(few?.title).toContain('2');
    expect(few?.description).toContain('<@a>');
    expect(few?.description).toContain('<@b>');

    const ids = Array.from({ length: 120 }, (_, i) => `user-${i}`);
    const many = formatUnlinkedDigest(ids);
    expect(many?.title).toContain('120');
    expect(many?.description).toContain('<@user-49>');
    expect(many?.description).not.toContain('<@user-50>');
    expect(many?.description).toContain('…and 70 more');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn test tst/lib/helpers/unlinkedDigest.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

Create `src/lib/helpers/unlinkedDigest.ts`:

```typescript
import { Client } from 'discord.js';
import { Logger } from 'tslog';

import { SERVER_ROLES } from '../../constants.js';
import { ApplicationCache } from '../../util/cache.js';
import { ApplicationMemberRepository } from '../../util/memberRepository.js';
import { MemberRecord } from '../repositories/types.js';
import { LogEntry, logAlert } from './discordLogger.js';

const logger = new Logger({ name: 'unlinkedDigest' });

export const DIGEST_UTC_HOUR = 17; // ≈ 9-10am Pacific
const TICK_MS = 60 * 60 * 1000; // hourly
const MAX_LISTED = 50;

export function shouldRunDigestNow(now: Date): boolean {
  return now.getUTCHours() === DIGEST_UTC_HOUR;
}

export function collectUnlinkedMemberIds(
  members: { id: string; isBot: boolean; hasOnboardingRole: boolean }[],
  rows: MemberRecord[]
): string[] {
  const linkedIds = new Set(
    rows.filter((row) => row.meetupId !== null).map((row) => row.discordUserId)
  );
  return members
    .filter(
      (member) =>
        !member.isBot && !member.hasOnboardingRole && !linkedIds.has(member.id)
    )
    .map((member) => member.id);
}

export function formatUnlinkedDigest(
  unlinkedIds: string[]
): LogEntry | undefined {
  if (unlinkedIds.length === 0) {
    return undefined;
  }
  const listed = unlinkedIds.slice(0, MAX_LISTED).map((id) => `<@${id}>`);
  const overflow = unlinkedIds.length - listed.length;
  const overflowNote = overflow > 0 ? `\n…and ${overflow} more` : '';
  return {
    title: `Unlinked member digest: ${unlinkedIds.length} verified members have no Meetup account on record`,
    description: `${listed.join(' ')}${overflowNote}`,
  };
}

async function runDigestOnce(client: Client): Promise<void> {
  const cache = await ApplicationCache();
  const today = new Date().toISOString().slice(0, 10);
  // exclusive_set guards against double-posting across dyno restarts; the
  // cache TTL (12h on Redis) is fine because the key encodes the date.
  const claimed = await cache.exclusive_set(`unlinked-digest-${today}`, '1');
  if (!claimed) {
    return;
  }

  const guilds = await client.guilds.fetch();
  const guildId = guilds.first()?.id;
  if (!guildId) {
    return;
  }
  const guild = await client.guilds.fetch(guildId);
  const guildMembers = await guild.members.fetch();

  const repo = await ApplicationMemberRepository();
  const rows = await repo.listAll();

  const unlinked = collectUnlinkedMemberIds(
    guildMembers.map((member) => ({
      id: member.id,
      isBot: member.user.bot,
      hasOnboardingRole: member.roles.cache.has(SERVER_ROLES.onboarding),
    })),
    rows
  );

  const entry = formatUnlinkedDigest(unlinked);
  if (entry) {
    await logAlert(client, entry);
  }
  logger.info(`Unlinked digest ran: ${unlinked.length} unlinked members`);
}

/**
 * Hourly tick that posts the digest once per day during the target UTC hour.
 * Survives Heroku's ~daily dyno cycling (a naive 24h setInterval may never
 * fire); the cache guard prevents restart double-posts within the hour.
 */
export function startUnlinkedDigestScheduler(client: Client): void {
  const tick = () => {
    if (!shouldRunDigestNow(new Date())) {
      return;
    }
    runDigestOnce(client).catch((error) =>
      logger.error(`Unlinked digest failed: ${String(error)}`)
    );
  };
  tick();
  setInterval(tick, TICK_MS);
}
```

- [ ] **Step 4: Wire into src/index.ts**

Add the import:

```typescript
import { startUnlinkedDigestScheduler } from './lib/helpers/unlinkedDigest.js';
```

In the `client.once('clientReady', ...)` handler, after `await client.initApplicationCommands();`, add:

```typescript
  startUnlinkedDigestScheduler(client);
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `yarn test && npx tsc --noEmit`
Expected: all PASS, clean typecheck.

- [ ] **Step 6: Lint and commit**

```bash
yarn lint
git add src/lib/helpers/unlinkedDigest.ts src/index.ts tst/lib/helpers/unlinkedDigest.test.ts
git commit -m "feat: post daily unlinked-member digest to alerts channel

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 10: Full verification + rollout

**Files:** none created — verification and deployment only.

- [ ] **Step 1: Full local verification**

```bash
yarn lint && npx tsc --noEmit && yarn test:all
```

Expected: lint clean, typecheck clean, unit suite green; integration suite green for any service with an env var set, skip-with-warning otherwise.

- [ ] **Step 2: Provision Heroku Postgres (Hai runs this — requires billing consent)**

```bash
heroku addons:create heroku-postgresql:essential-0 -a meetup-discord-bot
heroku config:get DATABASE_URL -a meetup-discord-bot
```

Expected: addon provisions (~$5/month) and `DATABASE_URL` is set.

- [ ] **Step 3: Deploy and verify boot**

Push the branch through the repo's normal deploy path (PR → merge → Heroku deploy). Then:

```bash
heroku logs --tail -a meetup-discord-bot
```

Expected: "Bot started", no Postgres connection errors (schema creates on first repository use).

- [ ] **Step 4: End-to-end verification in Discord (from 🤖bot-testing)**

1. Click the Get Verified sync button with a test account → onboard completes → row appears (`heroku pg:psql -a meetup-discord-bot -c "SELECT * FROM members;"`) → "Meetup account linked" embed in `🟥🤖meetup-bot-activity`.
2. Run a command that fails (e.g. `/meetup_unlink` as a non-mod) → red embed in `🟥🚨meetup-bot-alerts`.
3. Run `/meetup_unlink` as a mod on the test account → row deleted, activity embed posted.
4. Manually onboard a test account via the context menu → NULL-meetup row + deprecated-flow alert.
5. Next day (or temporarily set `DIGEST_UTC_HOUR` to the current hour on a test deploy): digest posts in the alerts channel.

- [ ] **Step 5: Finish the branch**

Use the superpowers:finishing-a-development-branch skill — open a PR from `meetup-id-storage` to `main` with a summary of the feature, linking the spec and this plan.

---

## Self-Review Notes (already applied)

- Spec coverage: schema §1 → Task 1/2; plumbing §2 → Task 2; write paths §3 → Task 7; duplicates §4 → Task 6; channels §5 → Task 3; logger §6 → Tasks 4–5; digest §7 → Task 9; testing §8 → embedded per task; rollout §9 → Task 10. `/meetup_unlink` (§4 escape hatch) → Task 8.
- Type consistency: `MemberRecord`/`MemberUpsert`/`OnboardMethod` defined once in Task 1 and imported everywhere; `LogEntry` defined in Task 4 and reused by Task 9's `formatUnlinkedDigest`.
- Placeholder scan: the only fill-in-later values are the two channel IDs in Task 3, which cannot exist until the creation script runs — the step says exactly how to obtain them.
