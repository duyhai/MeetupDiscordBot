import dayjs from 'dayjs';
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Client,
  MessageActionRowComponentBuilder,
} from 'discord.js';
import { Logger } from 'tslog';

import { DASHBOARD_BASE } from '../reports/dashboardPaths.js';
import {
  DISCORD_ID,
  EventRequest,
  PostgresEventRequestRepository,
} from '../repositories/postgresEventRequestRepository.js';
import { GUEST_HOST_EVENT_DESCRIPTION } from '../../templates/createEventTemplate.js';
import { LogEntry, alertText } from '../helpers/discordLogger.js';

const logger = new Logger({ name: 'requestPost' });

const REQUEST_ID = '([1-9][0-9]{0,17})';
export const APPROVE_ID = (id: string) => `request-approve:${id}`;
export const DENY_ID = (id: string) => `request-deny:${id}`;
export const APPROVE_ID_PATTERN = new RegExp(`^request-approve:${REQUEST_ID}$`);
export const DENY_ID_PATTERN = new RegExp(`^request-deny:${REQUEST_ID}$`);

/** The request id a button or modal custom id names; undefined for anything else. */
export function requestIdFrom(customId: string): string | undefined {
  const match =
    APPROVE_ID_PATTERN.exec(customId) ?? DENY_ID_PATTERN.exec(customId);
  return match?.[1];
}

/** The Approve and Deny buttons of a request's post. */
export function requestButtons(
  id: string,
  disabled: boolean,
): ActionRowBuilder<MessageActionRowComponentBuilder> {
  const approve = new ButtonBuilder()
    .setLabel('Approve')
    .setEmoji('✅')
    .setStyle(ButtonStyle.Success)
    .setCustomId(APPROVE_ID(id))
    .setDisabled(disabled);
  const deny = new ButtonBuilder()
    .setLabel('Deny')
    .setEmoji('✖️')
    .setStyle(ButtonStyle.Danger)
    .setCustomId(DENY_ID(id))
    .setDisabled(disabled);
  return new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
    approve,
    deny,
  );
}

export interface PostLinks {
  /** The site's origin, for the request's pages. */
  origin: string;
}

/** The host's page for a request. */
export const hostRequestUrl = (origin: string, id: string) =>
  `${origin}/host/requests/${id}`;
/** The leadership queue. */
export const queueUrl = (origin: string) =>
  `${origin}${DASHBOARD_BASE}/hosts/requests`;

const TIP_LINE = /^💡 Host Tip: (.*) 💡\n\n/u;

const whenLabel = (startLocal: string) =>
  dayjs(startLocal).format('ddd, MMM D, YYYY [at] h:mm A');

/** The new-request alert for #meetup-bot-alerts: plain text, no mentions, markdown escaped. */
export function newRequestAlert(
  origin: string,
  request: EventRequest,
): LogEntry {
  return {
    title: 'New host event request',
    description: `Review it at ${queueUrl(origin)}`,
    fields: [
      { name: 'Host', value: alertText(request.hostName), inline: true },
      { name: 'When', value: whenLabel(request.startLocal), inline: true },
      { name: 'Title', value: alertText(request.title) },
    ],
  };
}

/** Who asked: a mention when the Discord account is known, else the stored name. */
function requester(request: EventRequest): string {
  return request.discordUserId !== null
    ? `<@${request.discordUserId}>`
    : alertText(request.hostName);
}

function durationLabel(duration: string): string {
  const m = /^PT(\d+)H(?:(\d+)M)?$/.exec(duration);
  const hours = Number(m?.[1] ?? 0);
  const minutes = Number(m?.[2] ?? 0);
  return minutes ? `${hours} h ${minutes} min` : `${hours} h`;
}

/** The description and limits in one phrase, so a leader sees what approving publishes. */
function settingsLabel(request: EventRequest): string {
  const body = request.description.replace(TIP_LINE, '');
  const description =
    request.kind === 'copy'
      ? "description from the host's event"
      : body === GUEST_HOST_EVENT_DESCRIPTION
        ? 'standard description'
        : "host's own description";
  const guests = `${request.guestLimit} guest${request.guestLimit === 1 ? '' : 's'}`;
  return `${description} and RSVP limits (${request.rsvpLimit}, ${guests})`;
}

/**
 * The public request post: today's format (requester, Meetup id, hosted
 * count, date, title, tip) plus what the defaults are and where the
 * request lives on the website. `hostedCount` undefined omits its line.
 */
export function requestPostContent(
  request: EventRequest,
  hostedCount: number | undefined,
  links: PostLinks,
): string {
  const [day, time] = request.startLocal.split('T');
  const tip = TIP_LINE.exec(request.description)?.[1];
  const lines = [
    `❗${requester(request)} is requesting the creation of a new Meetup event.❗`,
    `**Meetup User ID**: ${request.meetupMemberId}`,
    ...(hostedCount === undefined
      ? []
      : [`**Number of hosted events**: ${hostedCount}`]),
    `**Event Date**: ${day}`,
    `**Event Title**: ${alertText(request.title)}`,
    `**Starts**: ${dayjs(`2000-01-01T${time}`).format('h:mm A')} for ${durationLabel(request.duration)} · ${settingsLabel(request)}`,
    `**Request**: #${request.id} · <${hostRequestUrl(links.origin, request.id)}> (the host) · <${queueUrl(links.origin)}> (leadership)`,
    ``,
    ...(tip === undefined ? [] : [`💡 **Host Tip**: ${tip} 💡`]),
    `Please reach out to us if you have any questions while setting up your event.`,
    `Organizers, please approve or deny below:`,
  ];
  return lines.join('\n');
}

/** The decider: a mention for a Discord id (leadership), else the host's name (their own publish). */
function decider(request: EventRequest): string {
  return request.decidedBy !== null && DISCORD_ID.test(request.decidedBy)
    ? `<@${request.decidedBy}>`
    : alertText(request.hostName);
}

/** A post with one of these carries its final outcome; nothing is appended after. */
const FINAL_MARKS = ['\n✅ Request approved by', '\n❌ Request denied by'];
/** The failed line may be followed by a final outcome (Retry, Resolve, Deny), but never by itself again. */
const FAILED_MARK = '\n⚠️ Approved by';

/** The outcome line appended to the post, or undefined while the request is open. */
export function decisionLine(request: EventRequest): string | undefined {
  switch (request.status) {
    case 'published':
      return (
        `✅ Request approved by ${decider(request)}.` +
        (request.eventUrl ? `\nLink to event: <${request.eventUrl}>` : '')
      );
    case 'denied':
      return (
        `❌ Request denied by ${decider(request)}.` +
        `\nReason: ${alertText(request.denyReason ?? '')}`
      );
    case 'failed':
      return `⚠️ Approved by ${decider(request)}, but publishing failed; leadership is retrying on the website.`;
    default:
      return undefined;
  }
}

/** Where a post goes: a channel's send, or an interaction's public follow-up. */
export interface PostTarget {
  send: (payload: {
    content: string;
    components: ActionRowBuilder<MessageActionRowComponentBuilder>[];
    allowedMentions: { parse: [] };
  }) => Promise<{ id: string; channelId: string }>;
}

export interface RequestPostDeps {
  store: () => Promise<Pick<PostgresEventRequestRepository, 'setDiscordPost'>>;
  /** PAST events hosted by the member (organizer read); may throw. */
  pastHostedCount: (meetupMemberId: string) => Promise<number>;
  /** #meetup-bot-alerts, plain; fire and forget. */
  alert: (entry: LogEntry) => Promise<unknown>;
  origin: string;
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : 'Error';
}

/**
 * Posts a request's message and records where it went. A request already
 * decided (a promoted host's own publish) posts with its outcome and no
 * live buttons. Never throws: a failure is logged and alerted, and the
 * request stands without a post.
 */
export async function postRequest(
  deps: RequestPostDeps,
  request: EventRequest,
  target: PostTarget,
): Promise<void> {
  let hostedCount: number | undefined;
  try {
    hostedCount = await deps.pastHostedCount(request.meetupMemberId);
  } catch (error: unknown) {
    logger.warn(`Hosted count unavailable for the post: ${errorName(error)}`);
  }
  const outcome = decisionLine(request);
  const content =
    requestPostContent(request, hostedCount, { origin: deps.origin }) +
    (outcome === undefined ? '' : `\n${outcome}`);
  try {
    const sent = await target.send({
      content,
      components: [requestButtons(request.id, outcome !== undefined)],
      allowedMentions: { parse: [] },
    });
    await (
      await deps.store()
    ).setDiscordPost(request.id, sent.channelId, sent.id);
  } catch (error: unknown) {
    logger.warn(`Request post failed for #${request.id}: ${errorName(error)}`);
    deps
      .alert({
        title: 'Host request post failed',
        description:
          `Could not post request #${request.id} to Discord (${errorName(error)}). ` +
          'The request itself is saved; decide it on the website.',
      })
      .catch(() => undefined);
  }
}

export interface MirrorDeps {
  getClient: () => Client | undefined;
  alert: (entry: LogEntry) => Promise<unknown>;
}

/**
 * Shows a decision on the request's Discord post: the outcome line is
 * appended and both buttons disabled. Nothing to do without a post. Any
 * failure (bot offline, message deleted, no access) is logged and alerted;
 * the decision itself is already recorded and never rolled back.
 */
export async function mirrorDecision(
  deps: MirrorDeps,
  request: EventRequest,
): Promise<void> {
  const post = request.discordPost;
  const line = decisionLine(request);
  if (post === null || line === undefined) {
    return;
  }
  const failed = (why: string) => {
    logger.warn(`Request post mirror failed for #${request.id}: ${why}`);
    deps
      .alert({
        title: 'Host request post not updated',
        description:
          `Could not update the Discord post for request #${request.id} (${why}). ` +
          'The decision is recorded; the post still shows its buttons.',
      })
      .catch(() => undefined);
  };
  const client = deps.getClient();
  if (!client) {
    failed('bot offline');
    return;
  }
  try {
    const channel = await client.channels.fetch(post.channelId);
    if (!channel?.isTextBased()) {
      failed('channel missing');
      return;
    }
    const message = await channel.messages.fetch(post.messageId);
    if (
      FINAL_MARKS.some((mark) => message.content.includes(mark)) ||
      (request.status === 'failed' && message.content.includes(FAILED_MARK))
    ) {
      return;
    }
    await message.edit({
      content: `${message.content}\n${line}`,
      components: [requestButtons(request.id, true)],
      allowedMentions: { parse: [] },
    });
  } catch (error: unknown) {
    failed(errorName(error));
  }
}
