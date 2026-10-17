import { describe, expect, it } from 'vitest';

import { toEventRef, toMemberRef } from '../../../src/lib/reports/types.js';

const NUL = String.fromCharCode(0);

describe('payload refs', () => {
  it('strip U+0000, which a JSONB column cannot store', () => {
    expect(
      toMemberRef({
        id: `12${NUL}3`,
        name: `Ann${NUL}${NUL} Lee`,
        memberUrl: `https://www.meetup.com/members/123/${NUL}`,
      }),
    ).toEqual({
      id: '123',
      name: 'Ann Lee',
      memberUrl: 'https://www.meetup.com/members/123/',
    });
    expect(
      toEventRef({
        id: `e${NUL}1`,
        title: `Pho${NUL} night`,
        eventUrl: `https://www.meetup.com/g/events/1/${NUL}`,
        dateTime: `2026-09-03T19:00-07:00${NUL}`,
      }),
    ).toEqual({
      id: 'e1',
      title: 'Pho night',
      eventUrl: 'https://www.meetup.com/g/events/1/',
      dateTime: '2026-09-03T19:00-07:00',
    });
  });

  it('leave every other character alone (RTL marks, emoji, controls, spaces)', () => {
    const name = '‏مريم‎ 🍜 ‮evil‬\t \u0001x  ';
    expect(
      toMemberRef({
        id: '1',
        name,
        memberUrl: 'https://www.meetup.com/members/1/',
      }).name,
    ).toBe(name);
    const title = 'Café 👩🏽‍💻 ⁦x⁩';
    expect(
      toEventRef({
        id: '1',
        title,
        eventUrl: 'https://www.meetup.com/g/events/1/',
        dateTime: '2026-09-03T19:00-07:00',
      }).title,
    ).toBe(title);
  });

  it('still copies only the stored fields', () => {
    const ref = toMemberRef({
      id: '1',
      name: 'A',
      memberUrl: 'u',
      gender: 'X',
      bio: 'b',
    } as never);
    expect(Object.keys(ref).sort()).toEqual(['id', 'memberUrl', 'name']);
  });
});
