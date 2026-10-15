/**
 * Minimal cookie handling for the dashboard. Every cookie it sets carries
 * the same attributes, so a route cannot forget one: HttpOnly (no script
 * access), Secure (HTTPS only; browsers also accept it on localhost), and
 * SameSite=Lax (not sent on cross-site POSTs).
 */
export function parseCookies(header: string | undefined): Map<string, string> {
  const cookies = new Map<string, string>();
  for (const part of (header ?? '').split(';')) {
    const eq = part.indexOf('=');
    if (eq <= 0) {
      continue;
    }
    const name = part.slice(0, eq).trim();
    if (cookies.has(name)) {
      continue;
    }
    const raw = part.slice(eq + 1).trim();
    let value = raw;
    try {
      value = decodeURIComponent(raw);
    } catch {
      // Keep the raw value: a malformed cookie simply won't verify.
    }
    cookies.set(name, value);
  }
  return cookies;
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
