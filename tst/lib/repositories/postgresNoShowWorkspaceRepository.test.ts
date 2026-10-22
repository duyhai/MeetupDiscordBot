import type pg from 'pg';
import { beforeEach, describe, expect, it } from 'vitest';

import { PostgresNoShowWorkspaceRepository } from '../../../src/lib/repositories/postgresNoShowWorkspaceRepository.js';
import type {
  ActionRequest,
  WorkspaceAction,
} from '../../../src/lib/workspace/types.js';

/** Every SQL text the stub clients were sent, in order. */
let calls: string[] = [];
/** Whether the stub's member_bans lookup finds an active ban. */
let banned = true;

/** A card that may be suspended: status new, classification suspension. */
const ROW = {
  id: 7,
  period_key: '2026-10',
  meetup_member_id: '123',
  member_name: 'Fixture Member',
  classification: 'suspension',
  status: 'new',
  notes: '',
  suspension_record_id: null,
  in_latest_snapshot: true,
  version: 2,
  updated_at: new Date('2026-10-20T00:00:00Z'),
  updated_by: null,
};

const result = (rows: unknown[], command = 'SELECT') => ({
  rows,
  rowCount: rows.length,
  command,
});

/**
 * No database, the way the ban repository's unit test stubs its pool: the
 * client records what it is sent and answers the version bump with ROW and
 * the active-ban lookup with one row while `banned` is true.
 */
function answer(text: string) {
  if (text.startsWith('UPDATE noshow_workspace_rows SET version')) {
    return result([ROW], 'UPDATE');
  }
  if (text.includes('FROM member_bans')) {
    return result(banned ? [{ '?column?': 1 }] : []);
  }
  return result([], text.trim().split(/\s+/)[0].toUpperCase());
}

const stubPool = {
  query(text: string) {
    calls.push(text);
    return Promise.resolve(answer(text));
  },
  connect() {
    return Promise.resolve({
      query(text: string) {
        calls.push(text);
        return Promise.resolve(answer(text));
      },
      on() {},
      removeListener() {},
      release() {},
    });
  },
} as unknown as pg.Pool;

const request = (action: WorkspaceAction): ActionRequest => ({
  period: { year: 2026, month: 10 },
  rowId: ROW.id,
  expectedVersion: ROW.version,
  actor: '123456789012345678',
  action,
  note: '',
  suspendedOn: new Date('2026-10-21T00:00:00Z'),
  linkRecordId: 99,
});

describe('PostgresNoShowWorkspaceRepository.applyAction and an active ban', () => {
  beforeEach(() => {
    calls = [];
    banned = true;
  });

  for (const action of ['record_suspension', 'link_suspension'] as const) {
    it(`${action} is refused as banned when the ban query returns a row, and nothing is written`, async () => {
      const repo = new PostgresNoShowWorkspaceRepository(stubPool);
      expect(await repo.applyAction(request(action))).toEqual({
        ok: false,
        reason: 'banned',
      });
      const ban = calls.findIndex((sql) => sql.includes('FROM member_bans'));
      const lock = calls.findIndex((sql) =>
        sql.includes('pg_advisory_xact_lock'),
      );
      // The ban is read after the member lock (D9), and the action rolls back.
      expect(lock).toBeGreaterThan(-1);
      expect(ban).toBeGreaterThan(lock);
      expect(calls.at(-1)).toBe('ROLLBACK');
      expect(calls.slice(ban + 1)).toEqual(['ROLLBACK']);
      expect(calls.some((sql) => /INSERT|COMMIT/.test(sql))).toBe(false);
    });

    it(`${action} is not refused as banned when the ban query returns no row`, async () => {
      banned = false;
      const repo = new PostgresNoShowWorkspaceRepository(stubPool);
      // The stub answers nothing past the ban check, so the action may
      // refuse or throw later; it must just not be a ban refusal.
      let outcome: unknown;
      try {
        outcome = await repo.applyAction(request(action));
      } catch {
        outcome = undefined;
      }
      expect(outcome).not.toEqual({ ok: false, reason: 'banned' });
      const ban = calls.findIndex((sql) => sql.includes('FROM member_bans'));
      expect(calls.length).toBeGreaterThan(ban + 2);
    });
  }
});
