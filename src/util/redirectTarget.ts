import { PUBLIC_APP_ORIGIN } from '../constants.js';

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1']);

/**
 * Where the /redirect trampoline may send someone (GitHub #109): back to this
 * app's own public origin -- production's Meetup callback passes through here
 * -- or to a local dev bot on plain-HTTP loopback. Anything else would make
 * the bot's domain an open redirect, on the same origin as the staff login.
 *
 * Compared on the parsed URL, never on the string: `origin` normalises the
 * scheme, host and default port, so look-alike hosts, userinfo tricks and
 * non-default ports all fall out.
 */
export function allowedRedirectTarget(raw: string): URL | undefined {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  if (url.username || url.password) {
    return undefined;
  }
  if (url.origin === PUBLIC_APP_ORIGIN) {
    return url;
  }
  if (url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname)) {
    return url;
  }
  return undefined;
}
