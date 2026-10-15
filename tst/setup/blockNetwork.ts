import nock from 'nock';

/**
 * No test may reach the network: any request nock has not intercepted fails
 * with NetConnectNotAllowedError, except to loopback (supertest servers).
 * Anchored, because nock turns a string host into an unanchored RegExp.
 */
const LOOPBACK = /^(127\.0\.0\.1|localhost)(:\d+)?$/;

export function applyNetworkBlock(): void {
  nock.disableNetConnect();
  nock.enableNetConnect((host) => LOOPBACK.test(host));
}

applyNetworkBlock();
