/**
 * Meetup's event photo host: the one image host the host site's CSP admits
 * (hostRouter), and the only one an event photo URL may point at. Both
 * checks (toHostEvent and html.ts meetupPhotoSrc) use meetupPhotoUrl, so
 * the CSP and the checks cannot drift apart. No imports: html.ts uses it.
 */
export const MEETUP_PHOTO_HOST = 'secure.meetupstatic.com';

/**
 * The URL, normalised, when it is plain https on MEETUP_PHOTO_HOST with no
 * port and no credentials; else undefined.
 */
export function meetupPhotoUrl(url: unknown): string | undefined {
  if (typeof url !== 'string') {
    return undefined;
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  return parsed.protocol === 'https:' &&
    parsed.hostname === MEETUP_PHOTO_HOST &&
    parsed.port === '' &&
    parsed.username === '' &&
    parsed.password === ''
    ? parsed.href
    : undefined;
}
