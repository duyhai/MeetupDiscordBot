import { Logger } from 'tslog';

import { InMemoryMemberRepository } from '../lib/repositories/inMemoryMemberRepository.js';
import { PostgresMemberRepository } from '../lib/repositories/postgresMemberRepository.js';
import { MemberRepository } from '../lib/repositories/types.js';

const logger = new Logger({ name: 'memberRepository' });

let warned = false;

export const ApplicationMemberRepository =
  async (): Promise<MemberRepository> => {
    if (process.env.DATABASE_URL) {
      return PostgresMemberRepository.instance();
    }
    if (!warned) {
      warned = true;
      logger.warn(
        'DATABASE_URL is not set - falling back to in-memory member storage. Member links will NOT survive restarts.',
      );
    }
    return InMemoryMemberRepository.instance();
  };
