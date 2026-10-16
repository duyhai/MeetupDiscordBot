import { SafeHtml, html, memberText, safeHref } from './html.js';

/**
 * Every link to a member, event or Discord user on a dashboard page is built
 * here, and every href passes safeHref. Profile links come only from all-digit
 * ids with bounded length, never from a URL in a payload.
 */
const MEETUP_ID = /^[0-9]{1,20}$/;
const DISCORD_ID = /^[0-9]{17,20}$/;

/** Only from an all-digit id; never from a payload's memberUrl. */
export function meetupProfileUrl(id: unknown): string | undefined {
  return typeof id === 'string' && MEETUP_ID.test(id)
    ? safeHref(`https://www.meetup.com/members/${id}/`)
    : undefined;
}

export function discordProfileUrl(id: unknown): string | undefined {
  return typeof id === 'string' && DISCORD_ID.test(id)
    ? safeHref(`https://discord.com/users/${id}`)
    : undefined;
}

const external = (href: string, text: SafeHtml) =>
  html`<a href="${href}" rel="noopener noreferrer" target="_blank">${text}</a>`;

function asText(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

export function memberLink(member: { id: unknown; name: unknown }): SafeHtml {
  const href = meetupProfileUrl(member.id);
  const name = memberText(asText(member.name) || 'Unknown member');
  return href ? external(href, name) : name;
}

/** Event titles are member-written (hosts): escaped and isolated; linked only if safeHref accepts the URL. */
export function eventLink(event: {
  title: unknown;
  eventUrl: unknown;
}): SafeHtml {
  const title = memberText(asText(event.title) || 'Untitled event');
  const href =
    typeof event.eventUrl === 'string' ? safeHref(event.eventUrl) : undefined;
  return href ? external(href, title) : title;
}

export function discordUserLink(id: unknown, label: string): SafeHtml {
  const href = discordProfileUrl(id);
  return href ? external(href, html`${label}`) : html`${label}`;
}
