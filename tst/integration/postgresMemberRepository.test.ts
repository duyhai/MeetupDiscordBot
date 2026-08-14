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
      ).rejects.toThrow(); // unique violation on meetup_id
    });

    it('remove deletes the row', async () => {
      const member = freshMember();
      await repo.upsert(member);
      await repo.remove(member.discordUserId);

      expect(await repo.findByDiscordId(member.discordUserId)).toBeUndefined();
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
