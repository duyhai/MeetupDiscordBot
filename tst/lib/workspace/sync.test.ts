import { describe, expect, it } from 'vitest';

import { MEMBER_NAME_MAX } from '../../../src/lib/workspace/types.js';
import { casesFromPayload } from '../../../src/lib/workspace/sync.js';

const member = (id: unknown, name: unknown = 'Ann') => ({
  id,
  name,
  memberUrl: `https://www.meetup.com/members/${String(id)}/`,
});

const noShow = (cases: unknown[]) => ({
  version: 1,
  reportType: 'no_show',
  period: '2026-09',
  cases,
  cleared: [],
  departed: [],
});

describe('casesFromPayload', () => {
  it('casesFromPayload reads cases[].member.id as strings', () => {
    expect(
      casesFromPayload(
        noShow([
          { member: member('111', 'Ann'), classification: 'warning' },
          { member: member('222', 'Bo'), classification: 'suspension' },
        ]),
      ),
    ).toEqual([
      { memberId: '111', memberName: 'Ann', classification: 'warning' },
      { memberId: '222', memberName: 'Bo', classification: 'suspension' },
    ]);
    expect(casesFromPayload(noShow([]))).toEqual([]);
  });

  it('refuses a payload with a numeric or non-digit member id', () => {
    expect(
      casesFromPayload(
        noShow([{ member: member(123), classification: 'warning' }]),
      ),
    ).toBeUndefined();
    expect(
      casesFromPayload(
        noShow([{ member: member('12a'), classification: 'warning' }]),
      ),
    ).toBeUndefined();
    expect(
      casesFromPayload(
        noShow([{ member: member(''), classification: 'warning' }]),
      ),
    ).toBeUndefined();
    // One bad case refuses the whole payload: a sync is all or nothing.
    expect(
      casesFromPayload(
        noShow([
          { member: member('111'), classification: 'warning' },
          { member: member(222), classification: 'warning' },
        ]),
      ),
    ).toBeUndefined();
  });

  it('refuses a non-no-show payload or an unknown classification', () => {
    expect(
      casesFromPayload({
        ...noShow([]),
        reportType: 'hall_of_fame',
      }),
    ).toBeUndefined();
    expect(casesFromPayload(null)).toBeUndefined();
    expect(casesFromPayload('no_show')).toBeUndefined();
    expect(
      casesFromPayload({ reportType: 'no_show', cases: {} }),
    ).toBeUndefined();
    expect(
      casesFromPayload(
        noShow([{ member: member('111'), classification: 'ban' }]),
      ),
    ).toBeUndefined();
    expect(casesFromPayload(noShow([null]))).toBeUndefined();
    expect(
      casesFromPayload(noShow([{ classification: 'warning' }])),
    ).toBeUndefined();
  });

  it('caps member names at 500 code points without splitting an emoji', () => {
    const name = `${'a'.repeat(MEMBER_NAME_MAX - 1)}😀😀`;
    const [c] =
      casesFromPayload(
        noShow([{ member: member('111', name), classification: 'warning' }]),
      ) ?? [];
    expect(Array.from(c.memberName)).toHaveLength(MEMBER_NAME_MAX);
    expect(c.memberName.endsWith('a😀')).toBe(true);
    // A missing or non-string name becomes ''.
    const [d] =
      casesFromPayload(
        noShow([{ member: member('111', 7), classification: 'warning' }]),
      ) ?? [];
    expect(d.memberName).toBe('');
  });

  it('keeps the first case of a repeated member', () => {
    expect(
      casesFromPayload(
        noShow([
          { member: member('111', 'First'), classification: 'warning' },
          { member: member('111', 'Second'), classification: 'suspension' },
        ]),
      ),
    ).toEqual([
      { memberId: '111', memberName: 'First', classification: 'warning' },
    ]);
  });
});
