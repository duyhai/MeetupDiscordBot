import { Client } from 'discord.js';

import Configuration from '../configuration.js';
import { Tokens } from '../lib/client/discord/types.js';
import { GqlMeetupClient } from '../lib/client/meetup/gqlClient.js';
import {
  buildMeetupAuthUrl,
  exchangeMeetupCode,
} from '../lib/client/oauth/providers.js';
import {
  claimOAuthState,
  createOrganizerRenewState,
  resolveOAuthState,
} from '../lib/client/oauth/state.js';
import { logAlert, logModeration } from '../lib/helpers/discordLogger.js';
import {
  ORGANIZER_RESTORED_ALERT,
  noteOrganizerCredentialRenewed,
} from '../lib/helpers/organizerMeetupClient.js';
import { PostgresCredentialRepository } from '../lib/repositories/postgresCredentialRepository.js';
import {
  ApplicationCredentialRepository,
  MEETUP_ORGANIZER_CREDENTIAL_KEY,
} from '../util/credentialRepository.js';
import { OrganizerLoginDeps } from './routes/organizerLogin.js';

/**
 * The in-lock guard refused: a different organizer account was recorded
 * after the route checked it. Named so the log tells it from an outage.
 */
export class OrganizerAccountChangedError extends Error {
  constructor() {
    super('A different organizer account was recorded during the renewal');
    this.name = 'OrganizerAccountChangedError';
  }
}

/**
 * Stores a renewed organizer credential through the same advisory-locked
 * transaction refresh uses: tokens, member id and the episode close commit
 * together or not at all. True iff a failure episode was open (post the
 * recovery message).
 *
 * The route has already matched `memberId` against the expected account;
 * the re-check here, under the lock, refuses if a different account was
 * recorded meanwhile.
 */
export async function renewOrganizerCredential(
  repo: PostgresCredentialRepository,
  tokens: Tokens,
  memberId: string,
  key: string = MEETUP_ORGANIZER_CREDENTIAL_KEY,
): Promise<boolean> {
  return repo.withLockedCredential(key, async (locked) => {
    if (locked.meta.memberId !== null && locked.meta.memberId !== memberId) {
      throw new OrganizerAccountChangedError();
    }
    await locked.write(tokens);
    await locked.setMemberId(memberId);
    return locked.clearFailing();
  });
}

async function requireStore(): Promise<PostgresCredentialRepository> {
  const repo = await ApplicationCredentialRepository();
  if (!repo) {
    throw new Error('No credential store: DATABASE_URL is not set');
  }
  return repo;
}

/** Production wiring for the "Renew organizer login" routes. */
export function organizerLoginDeps(
  getClient: () => Client | undefined,
): OrganizerLoginDeps {
  return {
    credentialStatus: async () => {
      const repo = await ApplicationCredentialRepository();
      if (!repo) {
        return undefined;
      }
      // getMeta first: it ensures the schema. Only whether a credential
      // exists leaves here, never the tokens.
      const meta = await repo.getMeta(MEETUP_ORGANIZER_CREDENTIAL_KEY);
      const stored =
        (await repo.get(MEETUP_ORGANIZER_CREDENTIAL_KEY)) !== undefined;
      return { ...meta, stored };
    },
    // Hai's bootstrap rule: the recorded id, else MEETUP_ORGANIZER_MEMBER_ID,
    // else nothing (the route refuses). An empty config var counts as unset.
    expectedMemberId: async () => {
      const { memberId } = await (
        await requireStore()
      ).getMeta(MEETUP_ORGANIZER_CREDENTIAL_KEY);
      return memberId ?? (Configuration.meetup.organizerMemberId || undefined);
    },
    createState: createOrganizerRenewState,
    resolveState: resolveOAuthState,
    claimState: claimOAuthState,
    buildAuthUrl: buildMeetupAuthUrl,
    exchangeCode: exchangeMeetupCode,
    // Minimal `self { id }` lookup: no profile is fetched or logged, and the
    // id is refused unless it is all digits.
    fetchMeetupMemberId: async (accessToken) =>
      new GqlMeetupClient(accessToken).getSelfId(),
    saveRenewedCredential: async (tokens, memberId) => {
      const recovered = await renewOrganizerCredential(
        await requireStore(),
        tokens,
        memberId,
      );
      const client = getClient();
      if (recovered && client) {
        // logAlert never throws: a failed post cannot undo a saved renewal.
        await logAlert(client, ORGANIZER_RESTORED_ALERT);
      }
      noteOrganizerCredentialRenewed();
    },
    audit: async (entry) => {
      const client = getClient();
      return client ? logModeration(client, entry) : false;
    },
  };
}
