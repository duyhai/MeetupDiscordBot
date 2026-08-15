import { describe, expect, it } from 'vitest';

import {
  GET_VERIFIED_CHANNEL_ID,
  GUILD_ID,
  WELCOME_CHANNEL_ID,
} from '../../src/constants.js';
import { getAuthLandingPage } from '../../src/templates/authLanding.js';

describe('getAuthLandingPage', () => {
  it('success page deep-links to the welcome channel', () => {
    const html = getAuthLandingPage('success', 'Connected!');
    expect(html).toContain(
      `discord://-/channels/${GUILD_ID}/${WELCOME_CHANNEL_ID}`,
    );
    expect(html).toContain(
      `https://discord.com/channels/${GUILD_ID}/${WELCOME_CHANNEL_ID}`,
    );
    expect(html).toContain('Connected!');
  });

  it('error page deep-links to the get-verified channel', () => {
    const html = getAuthLandingPage('error', 'Nope.');
    expect(html).toContain(
      `discord://-/channels/${GUILD_ID}/${GET_VERIFIED_CHANNEL_ID}`,
    );
    expect(html).toContain(
      `https://discord.com/channels/${GUILD_ID}/${GET_VERIFIED_CHANNEL_ID}`,
    );
    expect(html).toContain('Nope.');
  });
});
