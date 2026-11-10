import { ButtonInteraction } from 'discord.js';
import { describe, expect, it } from 'vitest';

import { verifyContextOf } from '../../../src/lib/helpers/verifyContext.js';

describe('verifyContextOf', () => {
  it('takes what the Verify steps need off a button interaction', () => {
    const guild = { id: 'g' };
    const client = { id: 'c' };
    const interaction = {
      guild,
      client,
      user: { id: '123456789012345678', username: 'member' },
      isButton: () => true,
      customId: 'sync_meetup_account',
    } as unknown as ButtonInteraction;
    expect(verifyContextOf(interaction)).toEqual({
      guild,
      client,
      userId: '123456789012345678',
      username: 'member',
      attempt: 'button:sync_meetup_account',
    });
  });
});
