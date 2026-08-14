import { InMemoryMemberRepository } from '../lib/repositories/inMemoryMemberRepository.js';
import { PostgresMemberRepository } from '../lib/repositories/postgresMemberRepository.js';
import { MemberRepository } from '../lib/repositories/types.js';

export const ApplicationMemberRepository =
  async (): Promise<MemberRepository> => {
    return process.env.DATABASE_URL
      ? PostgresMemberRepository.instance()
      : InMemoryMemberRepository.instance();
  };
