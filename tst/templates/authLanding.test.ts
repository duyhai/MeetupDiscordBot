import { describe, expect, it } from 'vitest';

import {
  GET_VERIFIED_CHANNEL_ID,
  GUILD_ID,
  WELCOME_CHANNEL_ID,
} from '../../src/constants.js';
import {
  buildHandoffScript,
  getAuthLandingPage,
} from '../../src/templates/authLanding.js';

const DEEP = 'discord://-/channels/1/2';
const WEB = 'https://discord.com/channels/1/2';

/**
 * Executes the emitted hand-off script against fake browser globals so the
 * behaviour (not just the source text) is under test: no DOM library needed.
 */
function runHandoff() {
  const navigations: string[] = [];
  const listeners: Record<string, (() => void)[]> = {};
  let timerFn: (() => void) | undefined;

  const on = (event: string, fn: () => void) => {
    listeners[event] = [...(listeners[event] ?? []), fn];
  };

  const fakeWindow = {
    addEventListener: on,
    location: {
      set href(value: string) {
        navigations.push(value);
      },
    },
  };
  const fakeDocument = { addEventListener: on, hidden: false };
  const fakeSetTimeout = (fn: () => void) => {
    timerFn = fn;
    return 1;
  };
  let cleared = false;
  const fakeClearTimeout = () => {
    cleared = true;
  };

  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const run = new Function(
    'window',
    'document',
    'setTimeout',
    'clearTimeout',
    buildHandoffScript(DEEP, WEB),
  ) as (w: unknown, d: unknown, s: unknown, c: unknown) => void;
  run(fakeWindow, fakeDocument, fakeSetTimeout, fakeClearTimeout);

  return {
    navigations,
    fireEvent: (event: string) => listeners[event]?.forEach((fn) => fn()),
    hide: () => {
      fakeDocument.hidden = true;
      listeners.visibilitychange?.forEach((fn) => fn());
    },
    runFallbackTimer: () => timerFn?.(),
    get fallbackCleared() {
      return cleared;
    },
  };
}

describe('deep-link hand-off', () => {
  it('sends the browser to the Discord app first', () => {
    const handoff = runHandoff();
    expect(handoff.navigations).toEqual([DEEP]);
  });

  it('does not also open Discord in the browser once the app takes over', () => {
    const handoff = runHandoff();
    handoff.hide(); // the OS handed off; this tab is now in the background

    handoff.runFallbackTimer();

    expect(handoff.navigations).toEqual([DEEP]);
    expect(handoff.fallbackCleared).toBe(true);
  });

  it('treats losing focus as a successful hand-off too', () => {
    const handoff = runHandoff();
    handoff.fireEvent('blur');

    handoff.runFallbackTimer();

    expect(handoff.navigations).not.toContain(WEB);
  });

  it('falls back to the web app when nothing handled the deep link', () => {
    const handoff = runHandoff();

    handoff.runFallbackTimer();

    expect(handoff.navigations).toEqual([DEEP, WEB]);
  });
});

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

  it('points the main button at the app, not the browser', () => {
    const html = getAuthLandingPage('error', 'Nope.');
    expect(html).toContain(
      `<a href="discord://-/channels/${GUILD_ID}/${GET_VERIFIED_CHANNEL_ID}" class="btn"`,
    );
  });

  it('only auto-hands-off on success', () => {
    expect(getAuthLandingPage('error', 'Nope.')).not.toContain(
      'meetupBotHandoff',
    );
    expect(getAuthLandingPage('success', 'Yay!')).toContain('meetupBotHandoff');
  });
});
