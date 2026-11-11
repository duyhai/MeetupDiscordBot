import pg from 'pg';

import { CachedWrapped } from '../wrapped/cache.js';
import { dashboardPool } from './dashboardPool.js';

/**
 * The durable Wrapped store (wrapped_entries): one row per member and year,
 * the same JSON the Redis tier holds. `put` also drops the member's rows
 * built for another Meetup account (a relink), so the guard in store.ts
 * never has to see them again.
 */
export interface WrappedEntryStore {
  get(discordUserId: string, year: number): Promise<CachedWrapped | undefined>;
  put(
    discordUserId: string,
    year: number,
    wrapped: CachedWrapped,
    builtAt: Date,
  ): Promise<void>;
  count(): Promise<number>;
}

export class PostgresWrappedEntryRepository implements WrappedEntryStore {
  private static singleton: Promise<PostgresWrappedEntryRepository> | undefined;

  constructor(private readonly pool: pg.Pool) {}

  static instance(): Promise<PostgresWrappedEntryRepository> {
    if (this.singleton === undefined) {
      const pending = dashboardPool().then(
        (pool) => new PostgresWrappedEntryRepository(pool),
      );
      this.singleton = pending;
      pending.catch(() => {
        if (this.singleton === pending) {
          this.singleton = undefined;
        }
      });
    }
    return this.singleton;
  }

  async get(
    discordUserId: string,
    year: number,
  ): Promise<CachedWrapped | undefined> {
    const result = await this.pool.query<{ payload: CachedWrapped }>(
      'SELECT payload FROM wrapped_entries WHERE discord_user_id = $1 AND year = $2',
      [discordUserId, year],
    );
    return result.rows[0]?.payload;
  }

  async put(
    discordUserId: string,
    year: number,
    wrapped: CachedWrapped,
    builtAt: Date,
  ): Promise<void> {
    await this.pool.query(
      'DELETE FROM wrapped_entries WHERE discord_user_id = $1 AND meetup_id <> $2',
      [discordUserId, wrapped.meetupId],
    );
    await this.pool.query(
      `INSERT INTO wrapped_entries (discord_user_id, year, meetup_id, payload, built_at)
       VALUES ($1, $2, $3, $4::jsonb, $5)
       ON CONFLICT (discord_user_id, year) DO UPDATE
         SET meetup_id = EXCLUDED.meetup_id, payload = EXCLUDED.payload, built_at = EXCLUDED.built_at`,
      [discordUserId, year, wrapped.meetupId, JSON.stringify(wrapped), builtAt],
    );
  }

  async count(): Promise<number> {
    const result = await this.pool.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM wrapped_entries',
    );
    return Number(result.rows[0].n);
  }
}
