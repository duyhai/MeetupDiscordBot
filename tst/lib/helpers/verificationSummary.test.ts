import { describe, expect, it } from 'vitest';

import { buildVerificationSummary } from '../../../src/lib/helpers/verificationSummary.js';

const base = {
  meetupName: 'Hai',
  meetupMemberUrl: 'https://www.meetup.com/members/182828976/',
  rolesGranted: [] as string[],
  hostedCount: 0,
  attendedCount: 0,
};

const fieldMap = (embed: {
  data: { fields?: { name: string; value: string }[] };
}) =>
  Object.fromEntries((embed.data.fields ?? []).map((f) => [f.name, f.value]));

describe('buildVerificationSummary', () => {
  it('reports the linked account, roles and activity in one embed', () => {
    const embed = buildVerificationSummary({
      ...base,
      rolesGranted: ['Organizer', 'Guest Host'],
      hostedCount: 133,
      attendedCount: 327,
    });
    const fields = fieldMap(embed);

    expect(embed.data.title).toMatch(/verified/i);
    expect(fields.Meetup).toContain('Hai');
    expect(fields.Meetup).toContain('182828976');
    expect(fields.Roles).toBe('Organizer, Guest Host');
    expect(fields.Activity).toContain('133');
    expect(fields.Activity).toContain('327');
  });

  it('says so plainly when no extra roles were earned', () => {
    // Most new members land here; "Roles: none" reads like something failed,
    // so the copy has to be reassuring rather than empty.
    const fields = fieldMap(buildVerificationSummary(base));

    expect(fields.Roles).toMatch(/member/i);
    expect(fields.Roles).not.toMatch(/none|undefined/i);
  });

  it('keeps a brand-new member out of a zeroed-out Activity line', () => {
    // 0 hosted / 0 attended is the common case on day one; showing it as
    // "0 hosted, 0 attended" makes verification feel like a failure.
    const fields = fieldMap(buildVerificationSummary(base));

    expect(fields.Activity ?? '').not.toMatch(/^0 /);
  });

  it('always points the member at where to go next', () => {
    const embed = buildVerificationSummary(base);

    expect(embed.data.description).toContain('<id:browse>');
  });
});
