import crypto from 'crypto';

import { safeEqual } from './session.js';

/**
 * Sign-in state kept in the browser instead of Redis, so an unauthenticated
 * request never writes to the shared cache. The cookie is
 * `base64url(JSON {s, v, e}).HMAC-SHA256(secret, 'oauth:' + that part)`.
 * Single use comes from the callback always clearing it, the 10-minute
 * expiry, and Discord codes being single-use.
 */
export interface OAuthCookiePayload {
  state: string;
  verifier: string;
  /** Epoch ms after which the cookie is refused. */
  expiresAt: number;
}

/** `oauth:` keeps this MAC apart from the session id's (`sid:`). */
const mac = (body: string, secret: string) =>
  crypto
    .createHmac('sha256', secret)
    .update(`oauth:${body}`)
    .digest('base64url');

export function sealOAuthCookie(
  { state, verifier, expiresAt }: OAuthCookiePayload,
  secret: string,
): string {
  const body = Buffer.from(
    JSON.stringify({ s: state, v: verifier, e: expiresAt }),
  ).toString('base64url');
  return `${body}.${mac(body, secret)}`;
}

/** The state and verifier, or undefined when forged, malformed or expired. */
export function openOAuthCookie(
  value: string,
  secret: string,
  now: number,
): { state: string; verifier: string } | undefined {
  const dot = value.lastIndexOf('.');
  if (dot <= 0) {
    return undefined;
  }
  const body = value.slice(0, dot);
  if (!safeEqual(value.slice(dot + 1), mac(body, secret))) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return undefined;
  }
  const { s, v, e } = (parsed ?? {}) as Record<string, unknown>;
  if (
    typeof s !== 'string' ||
    typeof v !== 'string' ||
    typeof e !== 'number' ||
    !s ||
    !v ||
    !(now < e)
  ) {
    return undefined;
  }
  return { state: s, verifier: v };
}
