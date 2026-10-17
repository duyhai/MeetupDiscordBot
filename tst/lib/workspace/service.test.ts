import { EmbedBuilder } from 'discord.js';
import { Logger } from 'tslog';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { LogEntry } from '../../../src/lib/helpers/discordLogger.js';
import type { Period } from '../../../src/lib/reports/period.js';
import type { SuspensionRecordState } from '../../../src/lib/repositories/postgresSuspensionRepository.js';
import {
  ACTION_TITLES,
  fitFieldValue,
  leadershipRefusalEntry,
  moderationEntry,
  type ActionFieldInput,
  performWorkspaceAction,
  validateActionFields,
  REFUSED_WHAT,
  STATUS_LABELS,
  syncWorkspace,
  type WorkspaceActionInput,
  type WorkspaceServiceDeps,
  type WorkspaceSyncDeps,
} from '../../../src/lib/workspace/service.js';
import { LEADERSHIP_ONLY_ACTIONS } from '../../../src/lib/workspace/transitions.js';
import {
  type ActionOutcome,
  type ActionRequest,
  type SyncOutcome,
  type WorkspaceMonthState,
  WORKSPACE_ACTIONS,
  type WorkspaceAction,
  type WorkspaceRow,
  type WorkspaceStatus,
} from '../../../src/lib/workspace/types.js';

const SEPT: Period = { year: 2026, month: 9 };
const ACTOR = '123456789012345678';
const NOW = new Date('2026-10-05T16:15:00Z');
const PAGE =
  'https://meetup-discord-bot.herokuapp.com/dashboard/no-shows/2026-09';

type Ok = Extract<ActionOutcome, { ok: true }>;

function row(extra: Partial<WorkspaceRow> = {}): WorkspaceRow {
  return {
    id: 7,
    period: SEPT,
    memberId: '200000001',
    memberName: 'Jane Doe',
    classification: 'suspension',
    status: 'suspended',
    notes: '',
    suspensionRecordId: null,
    inLatestSnapshot: true,
    version: 2,
    updatedAt: NOW,
    updatedBy: ACTOR,
    ...extra,
  };
}

function suspension(
  extra: Partial<SuspensionRecordState> = {},
): SuspensionRecordState {
  return {
    id: 41,
    memberId: '200000001',
    memberName: 'Jane Doe',
    suspendedAt: new Date('2026-10-01T00:00:00Z'),
    durationDays: 30,
    notes: null,
    createdAt: NOW,
    voidedAt: null,
    voidedBy: null,
    voidReason: null,
    ...extra,
  };
}

/** What a successful action of each kind looks like. */
const FIXTURE: Record<
  WorkspaceAction,
  { from: WorkspaceStatus; to: WorkspaceStatus; note?: string; record?: true }
> = {
  copy_warning: { from: 'new', to: 'warning_copied' },
  mark_sent: { from: 'warning_copied', to: 'warning_sent' },
  hold: { from: 'new', to: 'on_hold', note: 'Waiting on the host' },
  skip: { from: 'new', to: 'skipped', note: 'Host error' },
  reopen: { from: 'skipped', to: 'new' },
  record_suspension: { from: 'new', to: 'suspended', record: true },
  link_suspension: { from: 'new', to: 'suspended', record: true },
  void: {
    from: 'suspended',
    to: 'voided',
    note: 'Recorded in error',
    record: true,
  },
  edit_notes: { from: 'new', to: 'new', note: 'Called on 10/3' },
};

function ok(action: WorkspaceAction, extra: Partial<Ok> = {}): Ok {
  const f = FIXTURE[action];
  return {
    ok: true,
    row: row({ status: f.to }),
    previousStatus: f.from,
    event: {
      id: '1',
      rowId: 7,
      actor: ACTOR,
      action,
      oldStatus: f.from,
      newStatus: f.to,
      note: f.note ?? null,
      suspensionRecordId: f.record ? 41 : null,
      createdAt: NOW,
    },
    ...(f.record && { suspension: suspension() }),
    linkedExisting: action === 'link_suspension',
    alreadyVoided: false,
    ...extra,
  };
}

interface ServiceHarness {
  deps: WorkspaceServiceDeps;
  applyAction: ReturnType<
    typeof vi.fn<(req: ActionRequest) => Promise<ActionOutcome>>
  >;
  repository: ReturnType<typeof vi.fn>;
  moderationLog: ReturnType<
    typeof vi.fn<(entry: LogEntry) => Promise<unknown>>
  >;
  isLeadership: ReturnType<typeof vi.fn<(id: string) => Promise<boolean>>>;
}

function service(
  outcome: ActionOutcome = ok('copy_warning'),
  moderationLog: (entry: LogEntry) => Promise<unknown> = async () => true,
): ServiceHarness {
  const applyAction = vi.fn(async (_req: ActionRequest) => outcome);
  const repository = vi.fn(async () => ({ applyAction }));
  const log = vi.fn(moderationLog);
  const isLeadership = vi.fn(async (_id: string) => true);
  return {
    deps: { now: () => NOW, repository, moderationLog: log, isLeadership },
    applyAction,
    repository,
    moderationLog: log,
    isLeadership,
  };
}

const input = (extra: Record<string, unknown> = {}) => ({
  period: SEPT,
  rowId: 7,
  actor: ACTOR,
  action: 'copy_warning' as unknown,
  version: '2' as unknown,
  ...extra,
});

/** Lets the fire-and-forget log run. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

afterEach(() => {
  vi.restoreAllMocks();
});

describe('performWorkspaceAction', () => {
  it.each(WORKSPACE_ACTIONS.map((a) => [a]))(
    'logs %s to the moderation channel naming the actor as <@id>',
    async (action) => {
      const h = service(ok(action));
      const extra: Record<string, unknown> = { action };
      if (action === 'record_suspension') {
        extra.date = '2026-10-01';
      }
      if (action === 'link_suspension') {
        extra.recordId = '41';
      }
      expect(await performWorkspaceAction(h.deps, input(extra))).toEqual({
        code: 'done',
      });
      await flush();
      expect(h.moderationLog).toHaveBeenCalledTimes(1);
      const entry = h.moderationLog.mock.calls[0][0];
      expect(entry.title).toBe(`No-show workspace: ${ACTION_TITLES[action]}`);
      expect(entry.description?.startsWith(`<@${ACTOR}>`)).toBe(true);
      expect(entry.description).toContain(PAGE);
    },
  );

  it('the log escapes member names, notes and reasons', () => {
    const name = '**@everyone** [x](https://evil.example)';
    const note = '<@&1> hi @here <#99> </x:1>';
    const entry = moderationEntry(
      SEPT,
      ok('void', {
        row: row({ status: 'voided', memberName: name }),
        event: { ...ok('void').event, note },
      }),
      'void',
      ACTOR,
    );
    const text = JSON.stringify(entry);
    expect(text).not.toContain('**@everyone**');
    expect(text).not.toContain('[x](');
    expect(text).not.toContain('<@&1>');
    const member = entry.fields?.find((f) => f.name === 'Member')?.value ?? '';
    expect(member).toContain('\\@\u200beveryone');
    expect(member).toContain('\\[');
    expect(member).toContain('\\*\\*');
    const reason = entry.fields?.find((f) => f.name === 'Reason')?.value ?? '';
    expect(reason).toContain('\\<');
    expect(reason).toContain('\\@\u200bhere');
    // Every "@" is defused twice over: escaped and followed by U+200B.
    expect(/@(?!\u200b)/.test(member + reason)).toBe(false);
    expect(/<#(?!\u200b)/.test(reason)).toBe(false);
  });

  it('the log carries no content', () => {
    for (const action of WORKSPACE_ACTIONS) {
      expect(
        Object.keys(moderationEntry(SEPT, ok(action), action, ACTOR)),
      ).not.toContain('content');
    }
  });

  it('a void logs the reason and the record span', () => {
    const entry = moderationEntry(SEPT, ok('void'), 'void', ACTOR);
    expect(entry.fields).toEqual([
      { name: 'Member', value: 'Jane Doe (200000001)' },
      { name: 'Status', value: 'Suspended → Suspension voided' },
      { name: 'Reason', value: 'Recorded in error' },
      {
        name: 'Suspension',
        value: '#41: 30 days from 2026-10-01 through 2026-10-30',
      },
    ]);
    const already = moderationEntry(
      SEPT,
      ok('void', { alreadyVoided: true }),
      'void',
      ACTOR,
    );
    expect(already.fields?.[3].value).toBe(
      '#41: 30 days from 2026-10-01 through 2026-10-30 (already voided with /meetup_void_suspension)',
    );
    const linked = moderationEntry(
      SEPT,
      ok('link_suspension'),
      'link_suspension',
      ACTOR,
    );
    expect(linked.fields?.[2].value).toBe(
      '#41: 30 days from 2026-10-01 through 2026-10-30 (existing record linked)',
    );
  });

  it('labels every status and titles every action', () => {
    expect(Object.keys(ACTION_TITLES).sort()).toEqual(
      [...WORKSPACE_ACTIONS].sort(),
    );
    expect(Object.keys(STATUS_LABELS)).toHaveLength(7);
  });

  it('a failed moderation post does not fail the action', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn');
    const h = service(ok('copy_warning'), async () => {
      throw new TypeError('Discord is down: secret text');
    });
    expect(await performWorkspaceAction(h.deps, input())).toEqual({
      code: 'done',
    });
    await flush();
    expect(h.moderationLog).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      'Workspace moderation log failed: TypeError',
    );
  });

  it('a moderation log that throws synchronously does not fail the action', async () => {
    const h = service(ok('copy_warning'));
    h.deps.moderationLog = () => {
      throw new Error('sync throw');
    };
    expect(await performWorkspaceAction(h.deps, input())).toEqual({
      code: 'done',
    });
    await flush();
  });

  it('a slow moderation post does not hold up the action', async () => {
    const h = service(ok('copy_warning'), () => new Promise(() => undefined));
    expect(await performWorkspaceAction(h.deps, input())).toEqual({
      code: 'done',
    });
  });

  it('a refusal logs nothing', async () => {
    const h = service({ ok: false, reason: 'stale' });
    expect(await performWorkspaceAction(h.deps, input())).toEqual({
      code: 'stale',
    });
    await flush();
    expect(h.moderationLog).not.toHaveBeenCalled();
  });

  it.each<[string, Record<string, unknown>]>([
    ['unknown action', { action: 'delete_everything' }],
    ['action not a string', { action: ['copy_warning'] }],
    ['version missing', { version: undefined }],
    ['version not digits', { version: '2a' }],
    ['version negative', { version: '-1' }],
    ['version too long', { version: '1234567890' }],
    ['version a number', { version: 2 }],
    ['actor not an id', { actor: 'sync' }],
    ['actor too short', { actor: '1234' }],
    ['actor with a mention', { actor: `<@${ACTOR}>` }],
    ['row id zero', { rowId: 0 }],
    ['row id fraction', { rowId: 1.5 }],
    ['row id NaN', { rowId: Number.NaN }],
  ])(
    'refuses a malformed request (%s) as invalid without touching the repository',
    async (_label, extra) => {
      const h = service();
      expect(
        await performWorkspaceAction(
          h.deps,
          input(extra) as WorkspaceActionInput,
        ),
      ).toEqual({
        code: 'invalid',
      });
      expect(h.repository).not.toHaveBeenCalled();
      expect(h.applyAction).not.toHaveBeenCalled();
    },
  );

  it.each<[string, string]>([
    ['2026-08-31', 'bad-date'],
    ['2026-10-06', 'bad-date'],
    ['2026-02-30', 'bad-date'],
    ['2026-9-01', 'bad-date'],
    ['', 'bad-date'],
    ['2026-09-01', 'done'],
    ['2026-10-05', 'done'],
  ])(
    "record suspension date must be from the month's first day through today (Pacific): %s → %s",
    async (date, code) => {
      const h = service(ok('record_suspension'));
      const result = await performWorkspaceAction(
        h.deps,
        input({ action: 'record_suspension', date }),
      );
      expect(result.code).toBe(code);
      if (code === 'done') {
        expect(h.applyAction.mock.calls[0][0].suspendedOn).toEqual(
          new Date(`${date}T00:00:00.000Z`),
        );
      } else {
        expect(h.applyAction).not.toHaveBeenCalled();
      }
    },
  );

  it('a record suspension date that is not a string is bad-date', async () => {
    const h = service(ok('record_suspension'));
    expect(
      (
        await performWorkspaceAction(
          h.deps,
          input({ action: 'record_suspension', date: ['2026-09-01'] }),
        )
      ).code,
    ).toBe('bad-date');
    expect(h.applyAction).not.toHaveBeenCalled();
  });

  it.each([
    ['', 'invalid'],
    ['abc', 'invalid'],
    ['4.1', 'invalid'],
    ['1234567890', 'invalid'],
    [undefined, 'invalid'],
    ['41', 'done'],
  ])('link needs a numeric record id (%s → %s)', async (recordId, code) => {
    const h = service(ok('link_suspension'));
    const result = await performWorkspaceAction(
      h.deps,
      input({ action: 'link_suspension', recordId }),
    );
    expect(result.code).toBe(code);
    if (code === 'done') {
      expect(h.applyAction.mock.calls[0][0].linkRecordId).toBe(41);
    } else {
      expect(h.applyAction).not.toHaveBeenCalled();
    }
  });

  it('passes the request to the repository with the version as a number', async () => {
    const h = service(ok('hold'));
    await performWorkspaceAction(
      h.deps,
      input({ action: 'hold', note: ' wait ' }),
    );
    expect(h.applyAction).toHaveBeenCalledWith({
      period: SEPT,
      rowId: 7,
      expectedVersion: 2,
      actor: ACTOR,
      action: 'hold',
      note: ' wait ',
      suspendedOn: undefined,
      linkRecordId: undefined,
    });
  });

  it('passes the untrimmed note to the repository; a non-string note is empty', async () => {
    const h = service(ok('edit_notes'));
    await performWorkspaceAction(
      h.deps,
      input({ action: 'edit_notes', note: '  line\r\n  ' }),
    );
    expect(h.applyAction.mock.calls[0][0].note).toBe('  line\r\n  ');
    await performWorkspaceAction(
      h.deps,
      input({ action: 'edit_notes', note: ['x'] }),
    );
    expect(h.applyAction.mock.calls[1][0].note).toBe('');
  });

  it.each([
    'not-found',
    'stale',
    'not-allowed',
    'wrong-classification',
    'not-in-report',
    'note-required',
    'note-too-long',
    'no-earlier-status',
    'record-unavailable',
    'bad-date',
  ] as const)('maps the repository refusal %s to its code', async (reason) => {
    const h = service({ ok: false, reason });
    const result = await performWorkspaceAction(h.deps, input());
    expect(result).toEqual({ code: reason });
    expect('existing' in result).toBe(false);
  });

  it('keeps both shapes of already-suspended: the link offer and the overlap', async () => {
    const existing = { id: 41, suspendedAt: new Date('2026-10-01T00:00:00Z') };
    const offer = service({ ok: false, reason: 'already-suspended', existing });
    expect(
      await performWorkspaceAction(
        offer.deps,
        input({ action: 'record_suspension', date: '2026-10-01' }),
      ),
    ).toEqual({ code: 'already-suspended', existing });
    const overlap = service({ ok: false, reason: 'already-suspended' });
    const result = await performWorkspaceAction(
      overlap.deps,
      input({ action: 'record_suspension', date: '2026-10-01' }),
    );
    expect(result).toEqual({ code: 'already-suspended' });
    expect('existing' in result).toBe(false);
  });

  it('an overlap refusal sends the chosen date, has no record to offer, and logs nothing', async () => {
    const h = service({ ok: false, reason: 'already-suspended' });
    const result = await performWorkspaceAction(
      h.deps,
      input({
        action: 'record_suspension',
        date: '2026-09-15',
        leadershipConfirmed: true,
      }),
    );
    expect(result).toEqual({ code: 'already-suspended' });
    expect(h.applyAction).toHaveBeenCalledTimes(1);
    expect(h.applyAction.mock.calls[0][0]).toMatchObject({
      action: 'record_suspension',
      expectedVersion: 2,
      suspendedOn: new Date('2026-09-15T00:00:00.000Z'),
    });
    await flush();
    expect(h.moderationLog).not.toHaveBeenCalled();
  });

  it('a stale refusal of a Leadership action is stale, with nothing logged', async () => {
    const h = service({ ok: false, reason: 'stale' });
    const result = await performWorkspaceAction(
      h.deps,
      input({ action: 'void', note: 'mistake', leadershipConfirmed: true }),
    );
    expect(result).toEqual({ code: 'stale' });
    expect('existing' in result).toBe(false);
    await flush();
    expect(h.moderationLog).not.toHaveBeenCalled();
  });

  it('a repository error propagates (the route answers it), and nothing is logged', async () => {
    const h = service();
    h.applyAction.mockRejectedValueOnce(new Error('connection lost'));
    await expect(performWorkspaceAction(h.deps, input())).rejects.toThrow(
      'connection lost',
    );
    await flush();
    expect(h.moderationLog).not.toHaveBeenCalled();
  });
});

describe('moderationEntry text', () => {
  it('an edit of notes says Notes, a hold says Note, and an empty note adds no field', () => {
    expect(
      moderationEntry(SEPT, ok('edit_notes'), 'edit_notes', ACTOR).fields?.[2],
    ).toEqual({
      name: 'Notes',
      value: 'Called on 10/3',
    });
    expect(
      moderationEntry(SEPT, ok('hold'), 'hold', ACTOR).fields?.[2],
    ).toEqual({
      name: 'Note',
      value: 'Waiting on the host',
    });
    expect(
      moderationEntry(SEPT, ok('copy_warning'), 'copy_warning', ACTOR).fields,
    ).toHaveLength(2);
  });

  it('a nameless member is Unknown member, and a non-digit member id is not shown raw', () => {
    const entry = moderationEntry(
      SEPT,
      ok('copy_warning', { row: row({ memberName: '', memberId: '<@1>' }) }),
      'copy_warning',
      ACTOR,
    );
    expect(entry.fields?.[0].value).toBe('Unknown member (unknown id)');
  });

  it('the full copy_warning entry', () => {
    expect(
      moderationEntry(SEPT, ok('copy_warning'), 'copy_warning', ACTOR),
    ).toEqual({
      title: 'No-show workspace: Warning copied',
      description: `<@${ACTOR}> in the September 2026 workspace.\n${PAGE}`,
      fields: [
        { name: 'Member', value: 'Jane Doe (200000001)' },
        { name: 'Status', value: 'New → Warning copied' },
      ],
    });
  });

  it('a refused Leadership-only action has its own entry, naming the actor, the action and the card', () => {
    expect(
      leadershipRefusalEntry(
        SEPT,
        7,
        'record_suspension',
        ACTOR,
        'not-leadership',
      ),
    ).toEqual({
      title: 'No-show workspace: Leadership-only action refused',
      description:
        `<@${ACTOR}> tried to record a suspension in the September 2026 workspace (card 7) ` +
        `without the 1.5 Leadership Team role. Nothing was changed.\n${PAGE}`,
    });
    expect(
      leadershipRefusalEntry(SEPT, 7, 'void', ACTOR, 'discord-unreachable')
        .description,
    ).toBe(
      `<@${ACTOR}> tried to void a suspension in the September 2026 workspace (card 7), ` +
        `but Discord could not confirm their role. Nothing was changed.\n${PAGE}`,
    );
    expect(
      leadershipRefusalEntry(
        SEPT,
        0,
        'link_suspension',
        '<@&1>',
        'not-leadership',
      ).description,
    ).toBe(
      `Someone tried to link a suspension in the September 2026 workspace ` +
        `without the 1.5 Leadership Team role. Nothing was changed.\n${PAGE}`,
    );
  });
});

describe('syncWorkspace', () => {
  const payload = {
    reportType: 'no_show',
    cases: [
      {
        member: { id: '200000001', name: 'Jane Doe' },
        classification: 'suspension',
      },
    ],
  };

  function sync(
    snapshot: unknown = {
      id: 9,
      builtAt: new Date('2026-10-02T16:00:00Z'),
      payload,
    },
    now: Date = NOW,
  ) {
    const syncFromSnapshot = vi.fn(async (): Promise<SyncOutcome> => ({
      status: 'synced',
      created: 1,
      reclassified: 0,
      dropped: 0,
      returned: 0,
    }));
    const getCurrent = vi.fn(async () => snapshot as never);
    const s = snapshot as { id: number; builtAt: Date } | null;
    const getCurrentMeta = vi.fn(async () => {
      return s ? ({ id: s.id, builtAt: s.builtAt } as never) : undefined;
    });
    const monthState = vi.fn(
      async (): Promise<WorkspaceMonthState | undefined> => undefined,
    );
    const repository = vi.fn(async () => ({ syncFromSnapshot, monthState }));
    const snapshots = vi.fn(async () => ({ getCurrent, getCurrentMeta }));
    const deps: WorkspaceSyncDeps = { now: () => now, repository, snapshots };
    return {
      deps,
      syncFromSnapshot,
      getCurrent,
      getCurrentMeta,
      monthState,
      repository,
      snapshots,
    };
  }

  it('reads the current no-show snapshot and passes its id and built time', async () => {
    const h = sync();
    expect(await syncWorkspace(h.deps, SEPT)).toBe('synced');
    expect(h.getCurrent).toHaveBeenCalledWith('no_show', SEPT);
    expect(h.syncFromSnapshot).toHaveBeenCalledWith({
      period: SEPT,
      snapshotId: 9,
      snapshotBuiltAt: new Date('2026-10-02T16:00:00Z'),
      cases: [
        {
          memberId: '200000001',
          memberName: 'Jane Doe',
          classification: 'suspension',
        },
      ],
    });
  });

  it.each<[string, Period]>([
    ['before the first workspace month', { year: 2026, month: 8 }],
    ['a future month', { year: 2026, month: 11 }],
    ['not a month', { year: 2026, month: 13 }],
  ])('refuses %s without reading anything', async (_label, period) => {
    const h = sync();
    expect(await syncWorkspace(h.deps, period)).toBe('not-eligible');
    expect(h.snapshots).not.toHaveBeenCalled();
    expect(h.repository).not.toHaveBeenCalled();
  });

  it('a malformed payload writes nothing and logs', async () => {
    const error = vi.spyOn(Logger.prototype, 'error');
    const h = sync({
      id: 9,
      builtAt: NOW,
      payload: { reportType: 'no_show', cases: [{}] },
    });
    expect(await syncWorkspace(h.deps, SEPT)).toBe('malformed');
    expect(h.syncFromSnapshot).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(
      'Workspace sync 2026-09: the stored no-show report is not in the expected shape; nothing synced',
    );
  });

  it('a month with no report says no-report and never opens the workspace repository', async () => {
    const h = sync(null);
    expect(await syncWorkspace(h.deps, SEPT)).toBe('no-report');
    expect(h.repository).not.toHaveBeenCalled();
  });

  it('skips reading the payload when the workspace is already synced from the current build', async () => {
    const h = sync();
    h.monthState.mockResolvedValueOnce({
      period: SEPT,
      snapshotId: 9,
      snapshotBuiltAt: new Date('2026-10-02T16:00:00Z'),
      syncedAt: NOW,
    });
    expect(await syncWorkspace(h.deps, SEPT)).toBe('current');
    expect(h.getCurrentMeta).toHaveBeenCalledWith('no_show', SEPT);
    expect(h.monthState).toHaveBeenCalledWith(SEPT);
    expect(h.getCurrent).not.toHaveBeenCalled();
    expect(h.syncFromSnapshot).not.toHaveBeenCalled();
  });

  it.each<[string, number, string]>([
    ['another build', 8, '2026-10-02T16:00:00Z'],
    ['the open month rebuilt in place', 9, '2026-10-01T16:00:00Z'],
  ])('reads and syncs when the workspace holds %s', async (_label, id, at) => {
    const h = sync();
    h.monthState.mockResolvedValueOnce({
      period: SEPT,
      snapshotId: id,
      snapshotBuiltAt: new Date(at),
      syncedAt: NOW,
    });
    expect(await syncWorkspace(h.deps, SEPT)).toBe('synced');
    expect(h.getCurrent).toHaveBeenCalledTimes(1);
    expect(h.syncFromSnapshot).toHaveBeenCalledTimes(1);
  });

  it('a month never synced reads and syncs', async () => {
    const h = sync();
    expect(await syncWorkspace(h.deps, SEPT)).toBe('synced');
    expect(h.monthState).toHaveBeenCalledWith(SEPT);
    expect(h.getCurrent).toHaveBeenCalledTimes(1);
  });

  it('no current build: no-report without reading the payload or opening the workspace', async () => {
    const h = sync(null);
    expect(await syncWorkspace(h.deps, SEPT)).toBe('no-report');
    expect(h.getCurrent).not.toHaveBeenCalled();
    expect(h.repository).not.toHaveBeenCalled();
  });

  it("passes the repository's status through", async () => {
    const h = sync();
    h.syncFromSnapshot.mockResolvedValueOnce({
      status: 'current',
      created: 0,
      reclassified: 0,
      dropped: 0,
      returned: 0,
    });
    expect(await syncWorkspace(h.deps, SEPT)).toBe('current');
  });
});

describe('moderationEntry field sizes', () => {
  it('a long note full of markup still fits one embed field (1024)', () => {
    const note = '@<#'.repeat(300);
    const entry = moderationEntry(
      SEPT,
      ok('hold', { event: { ...ok('hold').event, note } }),
      'hold',
      ACTOR,
    );
    const value = entry.fields?.find((f) => f.name === 'Note')?.value ?? '';
    expect(value.length).toBeLessThanOrEqual(1024);
    expect(value.endsWith('…')).toBe(true);
    expect(/@(?!​)/.test(value.slice(0, -2))).toBe(false);
  });
});

describe('field values fit Discord (UTF-16 length)', () => {
  const lone =
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

  it('a long all-emoji note fits one field and builds an embed', () => {
    const note = '\u{1F600}'.repeat(900);
    const entry = moderationEntry(
      SEPT,
      ok('hold', { event: { ...ok('hold').event, note } }),
      'hold',
      ACTOR,
    );
    for (const field of entry.fields ?? []) {
      expect(field.value.length).toBeLessThanOrEqual(1024);
      expect(lone.test(field.value)).toBe(false);
    }
    expect(() =>
      new EmbedBuilder()
        .setTitle(entry.title)
        .addFields(...(entry.fields ?? [])),
    ).not.toThrow();
  });

  it('a long emoji name fits too', () => {
    const entry = moderationEntry(
      SEPT,
      ok('copy_warning', { row: row({ memberName: '\u{1F600}'.repeat(600) }) }),
      'copy_warning',
      ACTOR,
    );
    expect(() =>
      new EmbedBuilder().addFields(...(entry.fields ?? [])),
    ).not.toThrow();
  });

  it('a cut at a surrogate boundary leaves no lone surrogate', () => {
    // 999 ASCII then an emoji: the cut at 999 units would split the pair.
    for (const pad of [997, 998, 999, 1000]) {
      const value = fitFieldValue(
        `${'a'.repeat(pad)}${'\u{1F600}'.repeat(10)}`,
      );
      expect(value.length).toBeLessThanOrEqual(1000);
      expect(value.endsWith('…')).toBe(true);
      expect(lone.test(value)).toBe(false);
    }
    expect(fitFieldValue('short')).toBe('short');
    expect(fitFieldValue('x'.repeat(1000))).toBe('x'.repeat(1000));
  });
});

describe('REFUSED_WHAT', () => {
  it('names exactly the Leadership-only actions', () => {
    expect(Object.keys(REFUSED_WHAT)).toEqual([...LEADERSHIP_ONLY_ACTIONS]);
  });
});

describe('validateActionFields (shared by the route and the service)', () => {
  const at = (action: WorkspaceAction, fields: ActionFieldInput) =>
    validateActionFields(action, fields, SEPT, NOW);

  it('accepts a digit version and returns it as a number', () => {
    expect(at('hold', { version: '12' })).toEqual({
      ok: true,
      fields: { expectedVersion: 12 },
    });
  });

  it.each([undefined, '', '-1', '1.5', ' 1', '1234567890', ['1'], 1])(
    'refuses version %j as invalid',
    (version) => {
      expect(at('hold', { version })).toEqual({ ok: false, code: 'invalid' });
    },
  );

  it('parses a record date to UTC midnight within the month through today', () => {
    expect(
      at('record_suspension', { version: '1', date: '2026-09-15' }),
    ).toEqual({
      ok: true,
      fields: {
        expectedVersion: 1,
        suspendedOn: new Date('2026-09-15T00:00:00.000Z'),
      },
    });
    for (const date of [
      '2026-08-31',
      '2026-10-06',
      '2026-02-30',
      '2026-9-15',
      '',
      undefined,
    ]) {
      expect(
        at('record_suspension', { version: '1', date }),
        String(date),
      ).toEqual({
        ok: false,
        code: 'bad-date',
      });
    }
  });

  it('needs digit record ids for a link', () => {
    expect(at('link_suspension', { version: '1', recordId: '41' })).toEqual({
      ok: true,
      fields: { expectedVersion: 1, linkRecordId: 41 },
    });
    for (const recordId of ['', '4a', '-4', '1e3', undefined, ['41']]) {
      expect(
        at('link_suspension', { version: '1', recordId }),
        String(recordId),
      ).toEqual({ ok: false, code: 'invalid' });
    }
  });
});

describe('performWorkspaceAction: the Leadership gate', () => {
  const leadershipInput = (action: WorkspaceAction) =>
    input({
      action,
      ...(action === 'record_suspension' && { date: '2026-10-01' }),
      ...(action === 'link_suspension' && { recordId: '41' }),
      ...(action === 'void' && { note: 'recorded twice' }),
    });

  it.each(LEADERSHIP_ONLY_ACTIONS.map((a) => [a]))(
    '%s called directly without Leadership is refused and writes nothing',
    async (action) => {
      const h = service(ok(action));
      h.isLeadership.mockResolvedValue(false);
      const result = await performWorkspaceAction(
        h.deps,
        leadershipInput(action),
      );
      expect(result).toEqual({ code: 'not-leadership' });
      expect(h.isLeadership).toHaveBeenCalledWith(ACTOR);
      expect(h.repository).not.toHaveBeenCalled();
      expect(h.applyAction).not.toHaveBeenCalled();
      await flush();
      expect(h.moderationLog).toHaveBeenCalledWith(
        leadershipRefusalEntry(SEPT, 7, action, ACTOR, 'not-leadership'),
      );
    },
  );

  it('a Leadership check that fails is refused as unreachable', async () => {
    const h = service(ok('void'));
    h.isLeadership.mockRejectedValue(new Error('gateway down'));
    const result = await performWorkspaceAction(
      h.deps,
      leadershipInput('void'),
    );
    expect(result).toEqual({ code: 'leadership-unavailable' });
    expect(h.applyAction).not.toHaveBeenCalled();
    await flush();
    expect(h.moderationLog).toHaveBeenCalledWith(
      leadershipRefusalEntry(SEPT, 7, 'void', ACTOR, 'discord-unreachable'),
    );
  });

  it('a caller that already checked live passes the flag, and Discord is not asked again', async () => {
    const h = service(ok('void'));
    h.isLeadership.mockResolvedValue(false);
    const result = await performWorkspaceAction(h.deps, {
      ...leadershipInput('void'),
      leadershipConfirmed: true,
    });
    expect(result).toEqual({ code: 'done' });
    expect(h.isLeadership).not.toHaveBeenCalled();
  });

  it('a Leadership member calling directly is asked once and acts', async () => {
    const h = service(ok('record_suspension'));
    const result = await performWorkspaceAction(
      h.deps,
      leadershipInput('record_suspension'),
    );
    expect(result).toEqual({ code: 'done' });
    expect(h.isLeadership).toHaveBeenCalledTimes(1);
  });

  it('every other action never asks Discord', async () => {
    for (const action of WORKSPACE_ACTIONS.filter(
      (a) => !LEADERSHIP_ONLY_ACTIONS.includes(a),
    )) {
      const h = service(ok(action));
      h.isLeadership.mockResolvedValue(false);
      // eslint-disable-next-line no-await-in-loop -- one action at a time, so a failure names it
      const result = await performWorkspaceAction(
        h.deps,
        input({ action, note: 'why' }),
      );
      expect(result.code, action).toBe('done');
      expect(h.isLeadership, action).not.toHaveBeenCalled();
    }
  });
});
