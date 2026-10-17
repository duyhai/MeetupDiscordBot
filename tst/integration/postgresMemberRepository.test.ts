import crypto from 'crypto';
import pg from 'pg';
import { Logger } from 'tslog';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import { PostgresMemberRepository } from '../../src/lib/repositories/postgresMemberRepository.js';
import { MeetupIdConflictError } from '../../src/lib/repositories/types.js';

// Exercises the repository against a real Postgres (upsert conflict targets,
// TIMESTAMPTZ round-trips, and partial-unique semantics are exactly what a
// mock would paper over). Requires DATABASE_URL; skipped otherwise, matching
// the RedisCache integration suite pattern. Locally:
//   yarn test:integration:docker   (boots the Docker stack and wires the env)
const POSTGRES_AVAILABLE = Boolean(process.env.DATABASE_URL);

if (!POSTGRES_AVAILABLE) {
  // eslint-disable-next-line no-console
  console.warn(
    'Skipping PostgresMemberRepository integration tests: set DATABASE_URL to a reachable Postgres to run them.',
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
        member,
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
      const manualA = {
        ...freshMember(),
        meetupId: null,
        onboardMethod: 'manual' as const,
      };
      const manualB = {
        ...freshMember(),
        meetupId: null,
        onboardMethod: 'manual' as const,
      };
      await repo.upsert(manualA);
      await repo.upsert(manualB); // two NULLs must coexist

      const linked = freshMember();
      await repo.upsert(linked);
      await expect(
        repo.upsert({ ...freshMember(), meetupId: linked.meetupId }),
      ).rejects.toThrow(MeetupIdConflictError); // unique violation on meetup_id
    });

    it('remove deletes the row', async () => {
      const member = freshMember();
      await repo.upsert(member);
      await repo.remove(member.discordUserId);

      expect(await repo.findByDiscordId(member.discordUserId)).toBeUndefined();
    });

    describe('discordIdsByMeetupIds', () => {
      /** A random all-digit id of `length` digits, first digit non-zero. */
      const digits = (length: number) =>
        String(crypto.randomInt(1, 10)) +
        Array.from({ length: length - 1 }, () => crypto.randomInt(0, 10)).join(
          '',
        );
      const linkedMember = (discordUserId = digits(18)) => ({
        ...freshMember(),
        discordUserId,
        meetupId: digits(15),
      });
      const poolOf = () => (repo as unknown as { pool: pg.Pool }).pool;

      it('returns links for linked ids only', async () => {
        const a = await repo.upsert(linkedMember());
        const b = await repo.upsert(linkedMember());
        const unlinked = digits(15);
        const result = await repo.discordIdsByMeetupIds([
          a.meetupId,
          unlinked,
          b.meetupId,
          a.meetupId,
        ]);
        expect(result).toEqual(
          new Map([
            [a.meetupId, a.discordUserId],
            [b.meetupId, b.discordUserId],
          ]),
        );
      });

      it('returns the stored discord id as is; the page decides if it is a mention', async () => {
        const odd = await repo.upsert(linkedMember(`discord-${digits(6)}`));
        const result = await repo.discordIdsByMeetupIds([odd.meetupId]);
        expect(result.get(odd.meetupId)).toBe(odd.discordUserId);
      });

      it('empty input runs no query', async () => {
        const query = vi.spyOn(poolOf(), 'query');
        try {
          expect(await repo.discordIdsByMeetupIds([])).toEqual(new Map());
          expect(
            await repo.discordIdsByMeetupIds(['abc', '', '1'.repeat(21)]),
          ).toEqual(new Map());
          expect(query).not.toHaveBeenCalled();
        } finally {
          query.mockRestore();
        }
      });

      it('filters out ids that are not 1-20 digits, even when such a row exists', async () => {
        // freshMember's meetup ids are "meetup-<uuid>": linked, but not digits.
        const notDigits = await repo.upsert(freshMember());
        const good = await repo.upsert(linkedMember());
        const query = vi.spyOn(poolOf(), 'query');
        try {
          const result = await repo.discordIdsByMeetupIds([
            notDigits.meetupId,
            good.meetupId,
            ' 12',
            '1'.repeat(21),
            `${good.meetupId}' OR '1'='1`,
          ]);
          expect(result).toEqual(
            new Map([[good.meetupId, good.discordUserId]]),
          );
          expect(query).toHaveBeenCalledTimes(1);
          expect(query.mock.calls[0][1]).toEqual([[good.meetupId]]);
        } finally {
          query.mockRestore();
        }
      });

      it('caps the lookup at 500 distinct ids', async () => {
        const first = await repo.upsert(linkedMember());
        const last = await repo.upsert(linkedMember());
        const filler = Array.from({ length: 600 }, (_, i) => String(9e14 + i));
        const query = vi.spyOn(poolOf(), 'query');
        try {
          const result = await repo.discordIdsByMeetupIds([
            first.meetupId,
            first.meetupId,
            ...filler,
            last.meetupId,
          ]);
          expect(query).toHaveBeenCalledTimes(1);
          const [ids] = query.mock.calls[0][1] as [string[]];
          expect(ids).toHaveLength(500);
          expect(new Set(ids).size).toBe(500);
          expect(ids[0]).toBe(first.meetupId);
          expect(ids).not.toContain(last.meetupId);
          expect(result.has(first.meetupId)).toBe(true);
          expect(result.has(last.meetupId)).toBe(false);
        } finally {
          query.mockRestore();
        }
      });

      it('a missing members table: an empty map and one warning without ids', async () => {
        const id = digits(15);
        const missing = Object.assign(
          new Error('relation "members" does not exist'),
          { code: '42P01' },
        );
        const query = vi
          .spyOn(poolOf(), 'query')
          // eslint-disable-next-line @typescript-eslint/no-misused-promises -- pool.query's callback overload
          .mockImplementation(() => Promise.reject(missing));
        const warn = vi.spyOn(Logger.prototype, 'warn');
        try {
          expect(await repo.discordIdsByMeetupIds([id])).toEqual(new Map());
          expect(warn).toHaveBeenCalledTimes(1);
          const logged = JSON.stringify(warn.mock.calls[0]);
          expect(logged).toContain('members table missing');
          expect(logged).not.toContain(id);
        } finally {
          warn.mockRestore();
          query.mockRestore();
        }
      });

      it('any other database error is rethrown', async () => {
        const broken = Object.assign(new Error('connection reset'), {
          code: '08006',
        });
        const query = vi
          .spyOn(poolOf(), 'query')
          // eslint-disable-next-line @typescript-eslint/no-misused-promises -- pool.query's callback overload
          .mockImplementation(() => Promise.reject(broken));
        try {
          await expect(
            repo.discordIdsByMeetupIds([digits(15)]),
          ).rejects.toThrow('connection reset');
        } finally {
          query.mockRestore();
        }
      });
    });

    it('listAll includes a freshly upserted member', async () => {
      const member = freshMember();
      await repo.upsert(member);

      const all = await repo.listAll();
      expect(
        all.some((row) => row.discordUserId === member.discordUserId),
      ).toBe(true);
    });
  },
);
