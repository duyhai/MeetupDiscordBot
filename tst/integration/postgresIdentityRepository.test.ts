import crypto from 'crypto';
import pg from 'pg';
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
    // Deliberately not all-ASCII: bytes like 0xff/0xfe are invalid as UTF-8
    // continuation bytes, so if the driver ever coerced this through a string
    // (e.g. Buffer.from(String(buf))) the round-trip would corrupt them.
    // Real thumbnails are binary WebP data (starting with a "RIFF" header),
    // which this fixture stands in for -- an all-ASCII buffer like [1,2,3,4]
    // would silently survive that coercion and the test would pass either way.
    const thumb = Buffer.from([0x52, 0x49, 0x46, 0x46, 0xff, 0x00, 0x89, 0xfe]);
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

    // listChangesBetween, not listChangesSince: only the report path selects
    // the thumbs. listChangesSince is metadata-only by design.
    const rows = await repo.listChangesBetween(
      start,
      new Date(Date.now() + 60_000),
    );
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

    const rows = await repo.listChangesBetween(
      start,
      new Date(Date.now() + 60_000),
    );
    const mine = rows.find((r) => r.discordUserId === snap.discordUserId);
    // Thumb fetches are best-effort; a missing thumb must not lose the change.
    expect(mine?.newThumb).toBeNull();
    expect(mine?.field).toBe('nickname');

    // The digest path selects metadata only -- it must still see the change,
    // and must not carry the thumb columns at all.
    const metadata = await repo.listChangesSince(start);
    const meta = metadata.find((r) => r.discordUserId === snap.discordUserId);
    expect(meta?.field).toBe('nickname');
    expect(Object.keys(meta ?? {})).not.toContain('newThumb');
  });

  it('returns changes within a range and excludes those outside it', async () => {
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
      'event',
      new Map(),
    );

    // Read back the row's own detected_at at full precision so the boundary
    // check below sits exactly on it, rather than tens of seconds away. A
    // window that never approaches the actual timestamp can't tell `<` from
    // `<=` apart -- it would pass identically whichever comparison was used.
    //
    // Postgres's now() carries microsecond precision, but a JS Date can only
    // hold milliseconds -- round-tripping through listChangesSince()'s Date
    // would silently floor the value below the row's real detected_at, so
    // even a broken `<=` would still exclude it and the test would lie.
    // Reading the raw text avoids that lossy round trip, letting us build an
    // upper bound that is bit-for-bit the row's own timestamp.
    const pool = (repo as unknown as { pool: pg.Pool }).pool;
    const raw = await pool.query<{ raw: string }>(
      'SELECT detected_at::text AS raw FROM member_identity_changes WHERE discord_user_id = $1',
      [snap.discordUserId],
    );
    // listChangesBetween is typed to take a Date, but pg accepts a raw
    // timestamptz-literal string identically -- passing the exact text keeps
    // the microsecond precision a Date object cannot hold. The cast is
    // deliberate: a Date could not carry this value without losing it.
    const exactly = raw.rows[0].raw as unknown as Date;

    const now = Date.now();
    const inRange = await repo.listChangesBetween(
      new Date(now - 60_000),
      new Date(now + 60_000),
    );
    // The upper bound here IS the change's own detected_at, read back at full
    // precision: this only proves the exclusive `<` semantics if the window
    // ends exactly where the row sits, not merely somewhere earlier.
    const outOfRange = await repo.listChangesBetween(
      new Date(start.getTime()),
      exactly,
    );

    // The report command slices by range; an off-by-one on the bounds would
    // silently hand organizers the wrong window.
    expect(inRange.some((r) => r.discordUserId === snap.discordUserId)).toBe(
      true,
    );
    expect(outOfRange.some((r) => r.discordUserId === snap.discordUserId)).toBe(
      false,
    );
  });

  it('reports storage stats', async () => {
    const stats = await repo.storageStats();

    expect(stats.changeCount).toBeGreaterThan(0);
    expect(stats.totalBytes).toBeGreaterThan(0);
  });
});
