import {
  VerificationSummary,
  verificationSummaryText,
} from '../../lib/helpers/verificationSummary.js';
import { SafeHtml, html, localUrl, memberText, safeHref } from '../html.js';
import { hostLayout } from './hostLayout.js';
import { HOST_BASE, HostSession } from './hostSession.js';

/** Where the member ended up in our server, carried from Discord's step to Meetup's. */
export type ServerJoinResult =
  | { joined: boolean; pending: boolean }
  /** Discord would not let us add them. */
  | 'failed'
  /** Not attempted (no join wired in). */
  | undefined;

/**
 * The sealed Meetup cookie's marker for "Verify on Discord": this session's
 * tag, the Discord account just linked, and the join result as two flags
 * (j/- joined, p/- pending), "f" (failed) or "x" (not attempted).
 */
export const VERIFY_MARK =
  /^verify\.([A-Za-z0-9_-]{22})\.([0-9]{17,20})\.(f|x|[j-][p-])$/;

export function joinFlags(join: ServerJoinResult): string {
  if (join === undefined) {
    return 'x';
  }
  if (join === 'failed') {
    return 'f';
  }
  return `${join.joined ? 'j' : '-'}${join.pending ? 'p' : '-'}`;
}

export function joinOf(flags: string): ServerJoinResult {
  if (flags === 'x') {
    return undefined;
  }
  if (flags === 'f') {
    return 'failed';
  }
  return { joined: flags[0] === 'j', pending: flags[1] === 'p' };
}

/** How Verify on the website ended. Each kind has a fixed text. */
export type VerifyResult =
  | { kind: 'verified'; summary: VerificationSummary }
  /** Not a group member, or the Meetup account is someone else's link. */
  | { kind: 'refused'; message: string; retry: boolean }
  /** Signed in to a different Meetup account at the Meetup step. */
  | { kind: 'other-account' }
  /** Cancelled at Meetup, or Meetup did not answer. */
  | { kind: 'unfinished' }
  /** Linked, but the roles and badges step failed. */
  | { kind: 'roles-failed' }
  /** Linked, but Discord would not let us add them to the server. */
  | { kind: 'not-in-server'; maxServers: boolean }
  /** Came back from Discord as a different account from the linked one. */
  | { kind: 'discord-mismatch' }
  /** A refresh again within 10 minutes. */
  | { kind: 'too-soon' };

function serverNote(join: ServerJoinResult): SafeHtml | '' {
  if (join === 'failed') {
    return html`<p class="note attn">
      We could not add you to our Discord server. Join it from the link on our
      Meetup group page, then press Verify in our Discord server.
    </p>`;
  }
  if (join?.pending) {
    return html`<p class="note attn">
      One more step: open our Discord server and accept the server rules. Until
      then Discord keeps you in its waiting room.
    </p>`;
  }
  if (join?.joined) {
    return html`<p class="note info">We added you to our Discord server.</p>`;
  }
  return '';
}

/**
 * "Finish verification": the Meetup step again for a host already linked,
 * without redoing Discord's (a same-origin POST).
 */
function finish(session: HostSession): SafeHtml {
  return html`<form
    method="post"
    action="${localUrl(`${HOST_BASE}/verify/finish`)}"
  >
    <input type="hidden" name="_csrf" value="${session.csrfToken}" />
    <button type="submit">Finish verification</button>
  </form>`;
}

function resultBody(
  session: HostSession,
  result: VerifyResult,
  join: ServerJoinResult,
): SafeHtml {
  const home = html`<p><a href="${localUrl(HOST_BASE)}">Back to home</a></p>`;
  switch (result.kind) {
    case 'verified': {
      const { summary } = result;
      const text = verificationSummaryText(summary);
      const profile = safeHref(summary.meetupMemberUrl);
      return html`<div class="card">
        <h1>${text.title}</h1>
        <p>
          You now have access to the members-only channels in our Discord
          server. Pick the ones you want under Browse Channels.
        </p>
        ${serverNote(join)}
        <dl class="verify-summary">
          <dt>Meetup</dt>
          <dd>
            ${
              profile
                ? html`<a
                    href="${profile}"
                    rel="noopener noreferrer"
                    target="_blank"
                    >${memberText(summary.meetupName)}</a
                  >`
                : memberText(summary.meetupName)
            }
          </dd>
          <dt>Roles</dt>
          <dd>${text.roles}</dd>
          ${
            text.activity
              ? html`<dt>Activity</dt>
                  <dd>${text.activity}</dd>`
              : ''
          }
        </dl>
        ${home}
      </div>`;
    }
    case 'refused':
      return html`<div class="card">
        <h1>Not verified</h1>
        <p>${result.message}</p>
        ${serverNote(join)} ${result.retry ? finish(session) : ''} ${home}
      </div>`;
    case 'other-account':
      return html`<div class="card">
        <h1>A different Meetup account</h1>
        <p>
          Meetup answered for a different account from the one you signed in
          here with, so nothing was verified. Sign in to meetup.com with the
          account you use here, then finish verification.
        </p>
        ${finish(session)} ${home}
      </div>`;
    case 'roles-failed':
      return html`<div class="card">
        <h1>Linked, not verified yet</h1>
        <p>
          Your Meetup and Discord accounts are linked, but your roles could not
          be updated. Try again, or press Verify in our Discord server.
        </p>
        ${serverNote(join)} ${finish(session)} ${home}
      </div>`;
    case 'not-in-server':
      return html`<div class="card">
        <h1>Linked, not in our server yet</h1>
        ${
          result.maxServers
            ? html`<p>
                Your Meetup and Discord accounts are linked, but you are already
                in as many Discord servers as Discord allows, so we could not
                add you to ours. Leave a server first, then join ours from the
                link on our Meetup group page and press Verify in our Discord
                server.
              </p>`
            : html`<p>
                Your Meetup and Discord accounts are linked, but Discord did not
                let us add you to our server, so your roles could not be set.
                Join it from the link on our Meetup group page, then press
                Verify in our Discord server.
              </p>`
        }
        ${home}
      </div>`;
    case 'discord-mismatch':
      return html`<div class="card">
        <h1>A different Discord account</h1>
        <p>
          Discord answered for a different account from the one linked to your
          Meetup account, so nothing was changed. Sign in to Discord with your
          linked account, then try again.
        </p>
        ${home}
      </div>`;
    case 'too-soon':
      return html`<div class="card">
        <h1>Verified a few minutes ago</h1>
        <p>
          You refreshed your roles and badges a few minutes ago. Try again a
          little later.
        </p>
        ${home}
      </div>`;
    default:
      return html`<div class="card">
        <h1>Linked, not verified yet</h1>
        <p>
          Your Meetup and Discord accounts are linked, but Meetup did not
          confirm your account, so your roles were not updated. Try again, or
          press Verify in our Discord server.
        </p>
        ${serverNote(join)} ${finish(session)} ${home}
      </div>`;
  }
}

/** The page "Verify on Discord" ends on: same-origin, no cross-site form. */
export function verifyResultPage(
  nonce: string,
  session: HostSession,
  result: VerifyResult,
  join: ServerJoinResult,
): string {
  return hostLayout({
    title: result.kind === 'verified' ? 'Verified' : 'Verify on Discord',
    nonce,
    user: session,
    current: 'home',
    body: resultBody(session, result, join),
  });
}
