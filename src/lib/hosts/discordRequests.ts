import {
  ActionRowBuilder,
  ButtonInteraction,
  CommandInteraction,
  ModalBuilder,
  ModalSubmitInteraction,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';
import { Logger } from 'tslog';

import {
  DENY_REASON_MAX,
  EventRequest,
  NewEventRequest,
  PostgresEventRequestRepository,
} from '../repositories/postgresEventRequestRepository.js';
import { LogEntry } from '../helpers/discordLogger.js';
import { keepReplyVisible, markActivityLogged } from '../../util/discord.js';
import { HostResolution, publishTier } from './eligibility.js';
import {
  DEFAULT_DURATION,
  DEFAULT_TIME,
  MAX_PENDING,
  freshSettings,
  parseRequestForm,
} from './eventRequest.js';
import { pacificDay } from './hostEvents.js';
import { PublishOutcome, startHasPassed } from './publishRequest.js';
import {
  DECISION_MESSAGES,
  DecisionCode,
  DecisionInput,
  DecisionOutcome,
} from './requestDecision.js';
import {
  DENY_ID,
  RequestPostDeps,
  hostRequestUrl,
  newRequestAlert,
  postRequest,
  publishedAlert,
  queueUrl,
  requestIdFrom,
} from './requestPost.js';

const logger = new Logger({ name: 'discordRequests' });

/** The modal's one field. */
export const DENY_REASON_FIELD = 'reason';

/** The request store's reads and writes the command and buttons use. */
export interface DiscordRequestStore extends Pick<
  PostgresEventRequestRepository,
  'findBySubmitToken' | 'countPending' | 'get' | 'setDiscordPost'
> {
  /** 'full': the host is at `maxPending` waiting requests (counted under a lock). */
  create: (
    input: NewEventRequest,
    options?: { maxPending?: number },
  ) => Promise<EventRequest | undefined | 'full'>;
}

export interface DiscordRequestDeps {
  now: () => Date;
  /** The member's linked Meetup id (the members table); undefined when unlinked. */
  meetupIdForDiscord: (discordUserId: string) => Promise<string | undefined>;
  /** resolveHost for the linked member: the tier, or a refusal. */
  resolve: (who: { meetupMemberId: string }) => Promise<HostResolution>;
  store: () => Promise<DiscordRequestStore>;
  /** PAST events hosted by the member (organizer read); may throw. */
  pastHostedCount: (meetupMemberId: string) => Promise<number>;
  /** publishRequest for a Community Host's own request (actor: their Meetup id). */
  publish: (
    id: string,
    version: number,
    actor: string,
  ) => Promise<PublishOutcome>;
  /** decideRequest on the production decision deps. */
  decide: (input: DecisionInput) => Promise<DecisionOutcome>;
  /** A Host Tip for a regular host's event. */
  tip: () => string;
  /** #meetup-bot-alerts, plain; fire and forget. */
  alert: (entry: LogEntry) => Promise<unknown>;
  /** The site's origin, for the links in posts and replies. */
  origin: string;
  /** mirrorDecision: brings a post up to date after a stale press or a pre-pointer decision. */
  mirror: (request: EventRequest) => Promise<unknown>;
}

export const UNLINKED_NUDGE = (origin: string) =>
  'Your Discord account is not linked to a Meetup account yet, so the request ' +
  'could not be made. Link it first: press **Verify** in the server, or open ' +
  `<${origin}/host> and use **Verify on Discord**. Then run the command again.`;

const ALREADY_MADE = (origin: string, request: EventRequest) =>
  `This request was already made (a repeated command): <${hostRequestUrl(origin, request.id)}>`;

const postDeps = (deps: DiscordRequestDeps): RequestPostDeps => ({
  store: deps.store,
  pastHostedCount: deps.pastHostedCount,
  alert: deps.alert,
  origin: deps.origin,
  mirror: deps.mirror,
});

/** The website's wording for a request whose start has passed; publishing would only fail. */
export const START_PASSED =
  'The start time has passed, so this can no longer be published. Deny it with a note to the host.';

/**
 * /meetup_request_event, inside discordCommandWrapper: the same row the
 * website's form makes, with the form's defaults for what the command does
 * not ask (19:00, 2 h, the standard description with a Host Tip, the
 * template's limits), tagged source 'discord'. A Community Host's request
 * is published at once, as on the website. Errors are thrown with the
 * website's fixed texts for the wrapper to show.
 */
export async function handleRequestCommand(
  deps: DiscordRequestDeps,
  interaction: CommandInteraction,
  input: { year: number; month: number; day: number; title: string },
): Promise<void> {
  const meetupMemberId = await deps.meetupIdForDiscord(interaction.user.id);
  if (meetupMemberId === undefined) {
    await interaction.editReply({ content: UNLINKED_NUDGE(deps.origin) });
    keepReplyVisible(interaction);
    return;
  }
  const resolution = await deps.resolve({ meetupMemberId });
  const tier = publishTier(resolution);
  if (tier === 'not-a-host') {
    throw new Error('Your account cannot request events.');
  }
  const pad = (n: number) => String(n).padStart(2, '0');
  const parsed = parseRequestForm(
    {
      title: input.title,
      day: `${input.year}-${pad(input.month)}-${pad(input.day)}`,
      time: DEFAULT_TIME,
      duration: DEFAULT_DURATION,
    },
    pacificDay(deps.now()),
  );
  if (parsed.ok === false) {
    const { errors } = parsed;
    throw new Error(errors.title ?? errors.day ?? 'The request is not valid.');
  }
  const form = parsed.value;
  const store = await deps.store();
  const already = async () =>
    store.findBySubmitToken(meetupMemberId, interaction.id);
  const sent = await already();
  if (sent !== undefined) {
    await interaction.editReply({ content: ALREADY_MADE(deps.origin, sent) });
    keepReplyVisible(interaction);
    return;
  }
  const regular = tier === 'regular';
  const capReached = () =>
    new Error(
      `You already have ${MAX_PENDING} requests waiting for approval. Wait for one to be reviewed before sending another.`,
    );
  if (regular && (await store.countPending(meetupMemberId)) >= MAX_PENDING) {
    throw capReached();
  }
  const made = await store.create(
    {
      meetupMemberId,
      discordUserId: interaction.user.id,
      hostName: Array.from(interaction.user.username || 'Host')
        .slice(0, 100)
        .join(''),
      tier,
      kind: 'fresh',
      sourceEventId: null,
      title: form.title,
      startLocal: `${form.day}T${form.time}`,
      submitToken: interaction.id,
      source: 'discord',
      ...freshSettings(tier, deps.tip(), form.duration),
    },
    // Counted again under the per-host lock: the check above can race.
    regular ? { maxPending: MAX_PENDING } : {},
  );
  if (made === 'full') {
    throw capReached();
  }
  const created = made;
  if (created === undefined) {
    // The same interaction landed twice at once; the other one made it.
    const raced = await already();
    if (raced === undefined) {
      throw new Error('The request could not be saved. Please try again.');
    }
    await interaction.editReply({ content: ALREADY_MADE(deps.origin, raced) });
    keepReplyVisible(interaction);
    return;
  }
  logger.info(`Request #${created.id} made from Discord`);

  let toPost: EventRequest = created;
  if (tier === 'promoted') {
    const outcome = await deps.publish(
      created.id,
      created.version,
      meetupMemberId,
    );
    if (outcome.code !== 'stale') {
      toPost = outcome.request;
    }
    if (outcome.code === 'published') {
      deps
        .alert(publishedAlert(created, outcome.request))
        .catch(() => undefined);
    }
  } else {
    deps.alert(newRequestAlert(deps.origin, created)).catch(() => undefined);
  }
  await postRequest(
    postDeps(deps),
    toPost,
    {
      send: async (payload) => {
        const message = await interaction.followUp(payload);
        return { id: message.id, channelId: message.channelId };
      },
    },
    // resolveHost read the count already unless the role decided.
    resolution.kind === 'host' ? resolution.hostedCount : undefined,
  );
}

/** Discord's own texts where the website's say "reload the queue". */
export const DISCORD_RESULT_MESSAGES = (
  origin: string,
): Partial<Record<DecisionCode, string>> => ({
  published: '✅ Approved and published on Meetup.',
  denied: '❌ Denied. The host sees your reason on their dashboard.',
  failed: `⚠️ Approved, but publishing failed. Retry it on the website: <${queueUrl(origin)}>`,
  stale: 'Someone just acted on this request. Nothing was changed.',
  'still-publishing':
    'Meetup is slow to answer. The request stays "publishing"; this post is updated when it finishes.',
  'deny-slow':
    'The database is slow, so the deny may still save. This post is updated if it does.',
  'deny-event-exists':
    'This request’s event is on Meetup, so it was not denied. Finish it with Retry ' +
    `on the website, or delete it on Meetup first: <${queueUrl(origin)}>`,
});

function resultText(origin: string, code: DecisionCode): string {
  return DISCORD_RESULT_MESSAGES(origin)[code] ?? DECISION_MESSAGES[code];
}

async function decideFromDiscord(
  deps: DiscordRequestDeps,
  interaction: ButtonInteraction | ModalSubmitInteraction,
  action: 'approve' | 'deny',
  reason?: string,
): Promise<void> {
  const id = requestIdFrom(interaction.customId);
  if (id === undefined) {
    throw new Error('This button does not belong to a request.');
  }
  const current = await (await deps.store()).get(id);
  if (current === undefined) {
    throw new Error('That request no longer exists.');
  }
  // As the website hides Approve for one: publishing would only fail.
  if (
    action === 'approve' &&
    current.status === 'pending' &&
    startHasPassed(current.startLocal, deps.now())
  ) {
    await interaction.followUp({ content: START_PASSED, ephemeral: true });
    return;
  }
  // The version read here is what the compare-and-set checks: a second
  // press after a decision (or the website deciding first) is stale.
  const outcome = await deps.decide({
    id,
    version: current.version,
    actor: interaction.user.id,
    action,
    ...(reason === undefined ? {} : { reason }),
  });
  await interaction.followUp({
    content: resultText(deps.origin, outcome.code),
    ephemeral: true,
  });
  if (outcome.code === 'stale') {
    // Someone else decided it (perhaps before the post was recorded): make
    // sure the post shows that decision. Idempotent and cheap; the leader
    // already has their answer, so a store blip here is only logged.
    try {
      const now = await (await deps.store()).get(id);
      if (now !== undefined) {
        deps.mirror(now).catch(() => undefined);
      }
    } catch (error: unknown) {
      logger.warn(
        `Could not re-read request #${id} after a stale press: ${error instanceof Error ? error.name : 'Error'}`,
      );
    }
  }
  // The service wrote the audit line; the wrapper's generic one is skipped.
  markActivityLogged(interaction);
}

/** The Approve button, inside discordCommandWrapper. */
export function handleApprovePress(
  deps: DiscordRequestDeps,
  interaction: ButtonInteraction,
): Promise<void> {
  return decideFromDiscord(deps, interaction, 'approve');
}

/**
 * The Deny button: the reason modal, shown at once (a modal must be the
 * interaction's first response). Permission is checked on submit.
 */
export async function showDenyModal(
  interaction: ButtonInteraction,
): Promise<void> {
  const id = requestIdFrom(interaction.customId);
  if (id === undefined) {
    throw new Error('This button does not belong to a request.');
  }
  await interaction.showModal(
    new ModalBuilder()
      .setTitle('Deny this request')
      .setCustomId(DENY_ID(id))
      .addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder()
            .setCustomId(DENY_REASON_FIELD)
            .setLabel('Reason (the host sees it)')
            .setStyle(TextInputStyle.Paragraph)
            .setRequired(true)
            .setMaxLength(DENY_REASON_MAX),
        ),
      ),
  );
}

/** The reason modal's submit, inside discordCommandWrapper. */
export function handleDenySubmit(
  deps: DiscordRequestDeps,
  interaction: ModalSubmitInteraction,
): Promise<void> {
  return decideFromDiscord(
    deps,
    interaction,
    'deny',
    interaction.fields.getTextInputValue(DENY_REASON_FIELD),
  );
}
