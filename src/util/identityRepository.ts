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
