import nock from 'nock';
import { describe, expect, it } from 'vitest';

// HTTP blocked (nock intercepts http/fetch; raw TCP such as pg and redis is
// not affected): the integration suites still reach their throwaway
// Postgres and Redis.
describe('integration HTTP policy', () => {
  it('fails an unmocked external request loudly, from nock and not DNS', async () => {
    // .invalid never resolves: a DNS failure would be ENOTFOUND, not this.
    const request = fetch('https://example.invalid/');
    await expect(request).rejects.toMatchObject({
      name: 'NetConnectNotAllowedError',
      code: 'ENETUNREACH',
    });
    await expect(request).rejects.toThrow('Nock: Disallowed net connect');
  });

  it('blocks hosts that merely contain a loopback name', async () => {
    for (const url of [
      'https://127.0.0.1.example.invalid/',
      'https://localhost.example.invalid/',
      'https://evil-localhost/',
    ]) {
      // eslint-disable-next-line no-await-in-loop
      await expect(fetch(url)).rejects.toMatchObject({
        name: 'NetConnectNotAllowedError',
      });
    }
    expect(nock.isActive()).toBe(true);
  });
});
