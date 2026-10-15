/**
 * Minimal cookie handling for the dashboard. Every cookie it sets carries
 * the same attributes, so a route cannot forget one: HttpOnly (no script
 * access), Secure (HTTPS only; browsers also accept it on localhost), and
 * SameSite=Lax (not sent on cross-site POSTs).
 */
function* cookiePairs(
  header: string | undefined,
): Generator<[name: string, value: string]> {
  for (const part of (header ?? '').split(';')) {
    const eq = part.indexOf('=');
    if (eq <= 0) {
      continue;
    }
    const raw = part.slice(eq + 1).trim();
    let value = raw;
    try {
      value = decodeURIComponent(raw);
    } catch {
      // Keep the raw value: a malformed cookie simply won't verify.
    }
    yield [part.slice(0, eq).trim(), value];
  }
}

/** First value per name. */
export function parseCookies(header: string | undefined): Map<string, string> {
  const cookies = new Map<string, string>();
  for (const [name, value] of cookiePairs(header)) {
    if (!cookies.has(name)) {
      cookies.set(name, value);
    }
  }
  return cookies;
}

/**
 * Every value sent under `name`, in header order. A page on a sibling
 * subdomain or path can plant a same-named cookie ahead of ours, so callers
 * that verify values should try each one rather than trust the first.
 */
export function parseCookieValues(
  header: string | undefined,
  name: string,
): string[] {
  const values: string[] = [];
  for (const [n, value] of cookiePairs(header)) {
    if (n === name) {
      values.push(value);
    }
  }
  return values;
}

export function serializeCookie(
  name: string,
  value: string,
  { path, maxAgeSec }: { path: string; maxAgeSec?: number },
): string {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    `Path=${path}`,
    'HttpOnly',
    'Secure',
    'SameSite=Lax',
  ];
  if (maxAgeSec !== undefined) {
    parts.push(`Max-Age=${maxAgeSec}`);
  }
  return parts.join('; ');
}

export function clearCookie(name: string, path: string): string {
  return serializeCookie(name, '', { path, maxAgeSec: 0 });
}
