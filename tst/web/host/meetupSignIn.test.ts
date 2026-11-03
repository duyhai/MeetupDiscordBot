import nock from 'nock';
import { afterEach, describe, expect, it } from 'vitest';

import {
  buildHostMeetupAuthUrl,
  displayName,
  fetchMeetupSelf,
  isHostState,
  newHostState,
} from '../../../src/web/host/meetupSignIn.js';

const API = 'https://api.meetup.com';

afterEach(() => {
  nock.cleanAll();
});

describe('host Meetup states', () => {
  it('a new state is a host state and unguessable', () => {
    const a = newHostState();
    expect(isHostState(a)).toBe(true);
    expect(a).not.toBe(newHostState());
  });

  it('refuses member-link uuids, short, long and odd-character states', () => {
    expect(isHostState('6f1c1c2e-1b0b-4a8f-9a7e-2d7f3f1c9b1a')).toBe(false);
    expect(isHostState('host-short')).toBe(false);
    expect(isHostState(`host-${'a'.repeat(65)}`)).toBe(false);
    expect(isHostState(`host-${'a'.repeat(31)}/`)).toBe(false);
    expect(isHostState(undefined)).toBe(false);
  });

  it('the authorize URL carries the state, the basic scope and the shared redirect URI', () => {
    const state = newHostState();
    const url = new URL(buildHostMeetupAuthUrl(state));
    expect(url.origin + url.pathname).toBe(
      'https://secure.meetup.com/oauth2/authorize',
    );
    expect(url.searchParams.get('state')).toBe(state);
    expect(url.searchParams.get('scope')).toBe('basic');
    expect(url.searchParams.get('redirect_uri')).toMatch(
      /\/connect\/meetup\/callback$|\/redirect\//,
    );
  });
});

describe('fetchMeetupSelf', () => {
  it('returns the id and name, sending the token as a bearer', async () => {
    nock(API, { reqheaders: { authorization: 'Bearer tok' } })
      .post('/gql-ext')
      .reply(200, { data: { self: { id: '4242', name: 'Ann' } } });
    await expect(fetchMeetupSelf('tok')).resolves.toEqual({
      id: '4242',
      name: 'Ann',
    });
  });

  it('falls back to the id for a blank name', async () => {
    nock(API)
      .post('/gql-ext')
      .reply(200, { data: { self: { id: '4242', name: '  ' } } });
    await expect(fetchMeetupSelf('tok')).resolves.toEqual({
      id: '4242',
      name: '4242',
    });
  });

  it('a non-JSON 200 is a fixed error that quotes nothing', async () => {
    nock(API).post('/gql-ext').reply(200, '<html>secret page</html>');
    const error = await fetchMeetupSelf('tok').catch((e: unknown) => e);
    expect(String(error)).toContain('no JSON');
    expect(String(error)).not.toContain('secret');
  });

  it('a numeric id is refused (GraphQL IDs are strings)', async () => {
    nock(API)
      .post('/gql-ext')
      .reply(200, { data: { self: { id: 4242, name: 'A' } } });
    await expect(fetchMeetupSelf('tok')).rejects.toThrow('no usable id');
  });

  it('cleans and caps the display name', () => {
    expect(displayName('  Ann\u0000\u001b[31m Nguyen\u0085 ')).toBe(
      'Ann[31m Nguyen',
    );
    expect([...displayName('é'.repeat(150))]).toHaveLength(100);
    expect(displayName(7)).toBe('');
  });

  it('rejects a non-digit id', async () => {
    nock(API)
      .post('/gql-ext')
      .reply(200, { data: { self: { id: '../x', name: 'A' } } });
    await expect(fetchMeetupSelf('tok')).rejects.toThrow('no usable id');
  });

  it('a failed response names the status, never the body', async () => {
    nock(API).post('/gql-ext').reply(401, 'secret body');
    const error = await fetchMeetupSelf('tok').catch((e: unknown) => e);
    expect(String(error)).toContain('401');
    expect(String(error)).not.toContain('secret body');
  });
});
