import { Logger } from 'tslog';

import { PostgresCredentialRepository } from '../lib/repositories/postgresCredentialRepository.js';

const logger = new Logger({ name: 'credentialRepository' });

let warned = false;

export const MEETUP_ORGANIZER_CREDENTIAL_KEY = 'meetup_organizer';

/**
 * Credential storage is Postgres-only, mirroring identityRepository: a
 * process without DATABASE_URL runs with Meetup-side monitoring disabled
 * rather than falling back to an in-memory store that a restart would empty.
 */
export const ApplicationCredentialRepository = async (): Promise<
  PostgresCredentialRepository | undefined
> => {
  if (process.env.DATABASE_URL) {
    return PostgresCredentialRepository.instance();
  }
  if (!warned) {
    warned = true;
    logger.warn(
      'DATABASE_URL is not set - the credential store is disabled for this process.',
    );
  }
  return undefined;
};
