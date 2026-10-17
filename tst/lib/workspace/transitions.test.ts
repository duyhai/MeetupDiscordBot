import { describe, expect, it } from 'vitest';
import { WORKSPACE_SCHEMA_SQL } from '../../../src/lib/repositories/postgresNoShowWorkspaceRepository.js';
import {
  LEADERSHIP_ONLY_ACTIONS,
  allowedActions,
  decideTransition,
  isLeadershipOnly,
  normalizeNote,
} from '../../../src/lib/workspace/transitions.js';
import {
  Classification,
  SYNC_EVENT_ACTIONS,
  WORKSPACE_ACTIONS,
  WORKSPACE_STATUSES,
  WorkspaceAction,
  WorkspaceStatus,
} from '../../../src/lib/workspace/types.js';

const ALL_STATUSES: WorkspaceStatus[] = [
  'new',
  'warning_copied',
  'warning_sent',
  'on_hold',
  'suspended',
  'skipped',
  'voided',
];
const ALL_ACTIONS: WorkspaceAction[] = [
  'copy_warning',
  'mark_sent',
  'hold',
  'skip',
  'reopen',
  'record_suspension',
  'link_suspension',
  'void',
  'edit_notes',
];

// [action, from, classification, needsLatest]; typed from the brief's table, never from the rules.
type Row = [
  WorkspaceAction,
  WorkspaceStatus[] | 'any',
  Classification | 'any',
  boolean,
];
const TABLE: Row[] = [
  ['copy_warning', ['new', 'warning_copied'], 'warning', true],
  ['mark_sent', ['new', 'warning_copied'], 'warning', true],
  ['hold', ['new', 'warning_copied', 'warning_sent'], 'any', false],
  ['skip', ['new', 'warning_copied', 'warning_sent', 'on_hold'], 'any', false],
  ['reopen', ['on_hold', 'skipped'], 'any', false],
  [
    'record_suspension',
    ['new', 'warning_copied', 'warning_sent', 'on_hold', 'voided'],
    'suspension',
    true,
  ],
  [
    'link_suspension',
    ['new', 'warning_copied', 'warning_sent', 'on_hold', 'voided'],
    'suspension',
    false,
  ],
  ['void', ['suspended'], 'any', false],
  ['edit_notes', 'any', 'any', false],
];

const base = {
  status: 'new' as WorkspaceStatus,
  classification: 'warning' as Classification,
  inLatestSnapshot: true,
  note: 'because',
  statusBeforePark: 'new' as WorkspaceStatus,
};

describe('workspace names match the database CHECK lists', () => {
  const listAfter = (marker: RegExp): string[] => {
    const m = WORKSPACE_SCHEMA_SQL.match(marker);
    expect(m).not.toBeNull();
    return [...(m?.[1] ?? '').matchAll(/'([a-z_]+)'/g)].map((x) => x[1]);
  };
  it('statuses equal the literal list and the CHECK list, in order', () => {
    expect([...WORKSPACE_STATUSES]).toEqual(ALL_STATUSES);
    expect(
      listAfter(
        /status\s+TEXT NOT NULL DEFAULT 'new' CHECK \(status IN \(([^)]*)\)/,
      ),
    ).toEqual(ALL_STATUSES);
  });
  it('actions plus sync actions equal the events CHECK list, in order', () => {
    expect([...WORKSPACE_ACTIONS]).toEqual(ALL_ACTIONS);
    expect(
      listAfter(/action\s+TEXT NOT NULL CHECK \(action IN \(([^)]*)\)/),
    ).toEqual([...ALL_ACTIONS, ...SYNC_EVENT_ACTIONS]);
  });
});

describe('decideTransition', () => {
  it('full matrix: every (status, action, classification, inLatest) is allowed exactly as the table says', () => {
    let cases = 0;
    for (const [action, from, cls, needsLatest] of TABLE) {
      for (const status of ALL_STATUSES) {
        for (const classification of ['warning', 'suspension'] as const) {
          for (const inLatestSnapshot of [true, false]) {
            cases += 1;
            const got = decideTransition({
              ...base,
              action,
              status,
              classification,
              inLatestSnapshot,
            });
            const fromOk = from === 'any' || from.includes(status);
            const clsOk = cls === 'any' || cls === classification;
            const latestOk = !needsLatest || inLatestSnapshot;
            const label = `${action}/${status}/${classification}/${inLatestSnapshot}`;
            if (fromOk && clsOk && latestOk) {
              expect(got.ok, label).toBe(true);
            } else {
              expect(got.ok, label).toBe(false);
              const reason = !fromOk
                ? 'not-allowed'
                : !clsOk
                  ? 'wrong-classification'
                  : 'not-in-report';
              expect('reason' in got ? got.reason : '', label).toBe(reason);
            }
          }
        }
      }
    }
    expect(cases).toBe(9 * 7 * 2 * 2);
  });

  it('refuses an unknown action', () => {
    expect(
      decideTransition({ ...base, action: 'nope' as WorkspaceAction }),
    ).toEqual({ ok: false, reason: 'not-allowed' });
  });

  it('note required for hold, skip, void', () => {
    for (const [action, status] of [
      ['hold', 'new'],
      ['skip', 'new'],
      ['void', 'suspended'],
    ] as const) {
      expect(decideTransition({ ...base, action, status, note: '' })).toEqual({
        ok: false,
        reason: 'note-required',
      });
      expect(
        decideTransition({ ...base, action, status, note: ' why ' }),
      ).toEqual({
        ok: true,
        to:
          action === 'hold'
            ? 'on_hold'
            : action === 'skip'
              ? 'skipped'
              : 'voided',
        note: 'why',
      });
    }
  });

  it('blank-after-trim note refused', () => {
    expect(
      decideTransition({ ...base, action: 'hold', note: '  \r\n ' }),
    ).toEqual({ ok: false, reason: 'note-required' });
  });

  it('note over 2000 characters refused; void reason over 500 refused; 2000 emoji count as 2000', () => {
    expect(
      decideTransition({ ...base, action: 'hold', note: 'a'.repeat(2001) }),
    ).toEqual({ ok: false, reason: 'note-too-long' });
    expect(
      decideTransition({ ...base, action: 'hold', note: 'a'.repeat(2000) }).ok,
    ).toBe(true);
    expect(
      decideTransition({ ...base, action: 'hold', note: '😀'.repeat(2000) }).ok,
    ).toBe(true);
    expect(
      decideTransition({
        ...base,
        action: 'edit_notes',
        note: 'a'.repeat(2001),
      }),
    ).toEqual({ ok: false, reason: 'note-too-long' });
    const v = {
      ...base,
      action: 'void' as const,
      status: 'suspended' as const,
    };
    expect(decideTransition({ ...v, note: 'a'.repeat(501) })).toEqual({
      ok: false,
      reason: 'note-too-long',
    });
    expect(decideTransition({ ...v, note: 'a'.repeat(500) }).ok).toBe(true);
  });

  it('ignored-note actions neither store the note nor refuse a long one', () => {
    const got = decideTransition({
      ...base,
      action: 'copy_warning',
      note: 'a'.repeat(5000),
    });
    expect(got).toEqual({ ok: true, to: 'warning_copied', note: null });
  });

  it('reopen restores warning_sent', () => {
    expect(
      decideTransition({
        ...base,
        action: 'reopen',
        status: 'on_hold',
        statusBeforePark: 'warning_sent',
      }),
    ).toEqual({ ok: true, to: 'warning_sent', note: null });
  });
  it('reopen restores new', () => {
    expect(
      decideTransition({
        ...base,
        action: 'reopen',
        status: 'skipped',
        statusBeforePark: 'new',
      }),
    ).toEqual({ ok: true, to: 'new', note: null });
  });
  it('reopen from a skip that followed a hold restores on_hold', () => {
    expect(
      decideTransition({
        ...base,
        action: 'reopen',
        status: 'skipped',
        statusBeforePark: 'on_hold',
      }),
    ).toEqual({ ok: true, to: 'on_hold', note: null });
  });
  it('reopen without a hold or skip in the log is refused', () => {
    expect(
      decideTransition({
        ...base,
        action: 'reopen',
        status: 'on_hold',
        statusBeforePark: undefined,
      }),
    ).toEqual({ ok: false, reason: 'no-earlier-status' });
  });
  it('reopen with an impossible earlier status is refused', () => {
    for (const bad of ['suspended', 'skipped', 'voided'] as const) {
      expect(
        decideTransition({
          ...base,
          action: 'reopen',
          status: 'on_hold',
          statusBeforePark: bad,
        }),
      ).toEqual({ ok: false, reason: 'no-earlier-status' });
    }
  });

  it('record_suspension allowed from voided', () => {
    expect(
      decideTransition({
        ...base,
        action: 'record_suspension',
        status: 'voided',
        classification: 'suspension',
      }),
    ).toEqual({ ok: true, to: 'suspended', note: null });
  });
  it('record_suspension allowed from warning_sent once reclassified as a suspension', () => {
    expect(
      decideTransition({
        ...base,
        action: 'record_suspension',
        status: 'warning_sent',
        classification: 'suspension',
      }).ok,
    ).toBe(true);
  });

  it('a row no longer in the report cannot be warned or suspended, but can be linked, held, skipped, voided or noted', () => {
    const gone = { ...base, inLatestSnapshot: false };
    expect(decideTransition({ ...gone, action: 'copy_warning' })).toEqual({
      ok: false,
      reason: 'not-in-report',
    });
    expect(decideTransition({ ...gone, action: 'mark_sent' }).ok).toBe(false);
    expect(
      decideTransition({
        ...gone,
        action: 'record_suspension',
        classification: 'suspension',
      }),
    ).toEqual({ ok: false, reason: 'not-in-report' });
    expect(
      decideTransition({
        ...gone,
        action: 'link_suspension',
        classification: 'suspension',
      }).ok,
    ).toBe(true);
    expect(decideTransition({ ...gone, action: 'hold' }).ok).toBe(true);
    expect(decideTransition({ ...gone, action: 'skip' }).ok).toBe(true);
    expect(
      decideTransition({ ...gone, action: 'void', status: 'suspended' }).ok,
    ).toBe(true);
    expect(decideTransition({ ...gone, action: 'edit_notes' }).ok).toBe(true);
  });

  it('edit_notes keeps the status and allows clearing', () => {
    for (const status of ALL_STATUSES) {
      expect(
        decideTransition({ ...base, action: 'edit_notes', status, note: '' }),
      ).toEqual({ ok: true, to: status, note: '' });
    }
    expect(
      decideTransition({
        ...base,
        action: 'edit_notes',
        status: 'on_hold',
        note: ' a\r\nb ',
      }),
    ).toEqual({ ok: true, to: 'on_hold', note: 'a\nb' });
  });

  it('normalizeNote turns CRLF and CR into LF and trims; non-strings become empty', () => {
    expect(normalizeNote(' a\r\nb\rc ')).toBe('a\nb\nc');
    expect(normalizeNote(undefined)).toBe('');
    expect(normalizeNote(5)).toBe('');
  });
});

describe('allowedActions', () => {
  it('lists exactly the allowed actions', () => {
    expect(
      allowedActions({
        status: 'new',
        classification: 'warning',
        inLatestSnapshot: true,
      }),
    ).toEqual(['copy_warning', 'mark_sent', 'hold', 'skip', 'edit_notes']);
    expect(
      allowedActions({
        status: 'new',
        classification: 'suspension',
        inLatestSnapshot: true,
      }),
    ).toEqual([
      'hold',
      'skip',
      'record_suspension',
      'link_suspension',
      'edit_notes',
    ]);
    expect(
      allowedActions({
        status: 'suspended',
        classification: 'suspension',
        inLatestSnapshot: true,
      }),
    ).toEqual(['void', 'edit_notes']);
    expect(
      allowedActions({
        status: 'on_hold',
        classification: 'warning',
        inLatestSnapshot: false,
      }),
    ).toEqual(['skip', 'reopen', 'edit_notes']);
    expect(
      allowedActions({
        status: 'warning_sent',
        classification: 'warning',
        inLatestSnapshot: true,
      }),
    ).toEqual(['hold', 'skip', 'edit_notes']);
    expect(
      allowedActions({
        status: 'voided',
        classification: 'suspension',
        inLatestSnapshot: false,
      }),
    ).toEqual(['link_suspension', 'edit_notes']);
  });
});

describe('Leadership-only actions (Hai, 2026-10-16)', () => {
  it('are exactly record_suspension, link_suspension and void', () => {
    expect([...LEADERSHIP_ONLY_ACTIONS].sort()).toEqual(
      ['record_suspension', 'link_suspension', 'void'].sort(),
    );
    for (const action of ALL_ACTIONS) {
      expect(isLeadershipOnly(action), action).toBe(
        action === 'record_suspension' ||
          action === 'link_suspension' ||
          action === 'void',
      );
    }
  });
  it("does not change what allowedActions offers (the role check is the caller's)", () => {
    expect(
      allowedActions({
        status: 'new',
        classification: 'suspension',
        inLatestSnapshot: true,
      }),
    ).toContain('record_suspension');
  });
});
