# Message stack: one reply per interaction

**Date:** 2026-08-15
**Status:** Approved for planning

## Problem

A single bot workflow produces two or three separate Discord messages. Linking
a Meetup account is the worst case: the wrapper posts a progress reply, the
OAuth step edits it with a link button, `getBadges` edits it again and then
follows up with a badge summary, and `onboardUser` follows up once or twice
more.

The cause is structural. Every subsystem reaches for `interaction` on its own
and picks between `editReply` (revise the one reply) and `followUp` (make a new
message). `followUp` is the safe default, because editing a reply the user has
dismissed throws. Nobody owns the conversation as a whole, so the output
fragments.

Today there are 38 output call sites across 19 files.

## Solution

Each interaction gets a **stack manager**. The manager owns two message stacks
— one ephemeral, one public — and each stack renders into at most one Discord
message. Subsystems append to a stack instead of sending messages, so a
workflow's output accumulates in one place and is published as a single
message per surface.

The manager is constructed with a **flush lambda** supplied by whoever creates
it. The stack and manager never call Discord; they hand a rendered payload to
the lambda. Swapping Discord for another platform means writing another
adapter, not touching the core.

### Components

**`MessageStack`** — pure state, no I/O, no platform knowledge.

Entries live in a `Map` keyed by entry ID, which gives insertion order (so the
stack is ordered by creation time) and ID lookup in one structure, with no
separate index. IDs are a per-stack counter (`e1`, `e2`, …): unique within a
stack, and readable in test failures.

```
append(entry): EntryId    // returns the new entry's ID
update(id, entry): void   // replaces that entry's payload; unknown ID is a no-op
pop(): void               // drops the newest entry, whichever subsystem added
                          // it; a no-op on an empty stack
render(): RenderedMessage | undefined   // undefined when empty
```

An entry carries any combination of `content`, `embeds`, and `components`, and
a `status` (see *Status and colour* below). `render` joins the entries'
`content` with newlines into the message content, and concatenates their
`embeds` and `components` in stack order. An empty stack renders `undefined`,
which means "this surface has no message".

The stack is generic over embed and component types (defaulting to `unknown`)
and never inspects them — it only concatenates. Platform payload limits are
**not** applied here; they belong to the adapter.

### Status and colour

Output renders as an embed rather than plain text, so it reads as bot output
and can carry state in its colour. Each entry declares a status:

| Status      | Colour | Meaning                        |
| ----------- | ------ | ------------------------------ |
| `success`   | green  | finished, everything fine      |
| `error`     | red    | failed                         |
| `pending`   | yellow | in process                     |
| `attention` | orange | done, but a human should look  |

The stack's text is the **message content**; the embed is a compact status
banner carrying only the colour and a label (`In progress`, `Finished`,
`Needs attention`, `Error`). Discord renders content above embeds, so the
banner sits beneath the output as a footer — there is no way to place an embed
above text in the same message.

Keeping the text in the content rather than an embed description matters for
more than layout: **a user mention inside an embed renders as a link but does
not notify.** The public welcome message depends on pinging the new member, so
holding every line in the content keeps pings working everywhere with no
per-entry exception.

A surface renders one status banner, so the per-entry statuses reduce to a
single colour by severity: **red > orange > yellow > green**. Any failed entry
makes the message red; otherwise any entry needing attention makes it orange;
otherwise any still-running entry makes it yellow; otherwise green. A flow
therefore sits yellow while it runs and settles green, or lands red the moment
something fails.

Colours join the existing `EMBED_COLORS` in `constants.ts` — `success` and
`error` reuse the activity green and alert red already there, with yellow and
orange added — so the bot's log channels and its replies share one palette.

The banner's title is the status label; the action name the wrapper already
computes with `describeInteraction` (`/meetup_whois_discorduser`,
`button:sync_meetup_account_v2`) goes in the embed footer, labelling the
output without any caller passing it.

A surface whose entries carry no status renders no banner — the public
welcome message is plain text with nothing to report, and shouldn't grow a
decorative embed.

**`Surface`** — a stack bound to a flusher, plus flush policy.

Each surface owns its debounce timer and its age guard. `StackManager` holds
two named surfaces, `ephemeral` and `public`; callers see the surface's
`append` / `update` / `pop` and never handle flushing.

**`StackManager`** — created per interaction.

```
new StackManager({
  flushers: { ephemeral, public },   // platform adapters
  debounceMs,                        // caller-supplied
  maxAgeMs,                          // caller-supplied
})
```

It exposes `ephemeral`, `public`, `flushAll()`, and `dispose()`.

**Registry** — a `Map` from interaction ID to manager. `discordCommandWrapper`
creates the manager on entry and disposes it in a `finally`. Helpers reach it
with `replyStack(interaction)`; every helper in these flows already receives
the interaction, so no signature changes.

**Discord adapter** — implements the flush lambdas and is the only component
that knows about Discord.

It receives a rendered payload (or `undefined`) and reconciles the platform
message with it: create on first content, edit on subsequent flushes, and
delete when the payload becomes `undefined`. A payload of `undefined` with no
message yet created does nothing — a surface that is never written to never
posts. It clamps to Discord's limits — 2000
characters of content, 10 embeds, 5 component rows — truncating with a marker
and logging when a payload exceeds them. It also owns dismissal recovery
(below). The ephemeral adapter replies or follows up ephemerally; the public
adapter sends to the channel.

### Flush policy

Mutations are synchronous and cheap. Each surface debounces its flush
(~400ms), so a burst of updates costs one API call and Discord's edit rate
limit stops being a concern. `discordCommandWrapper` forces a final
`flushAll()` before returning, so nothing is left unsent.

A flush failure is logged and swallowed. Output must never break the command
that produced it — the same rule `discordLogger` follows.

**Age guard.** The manager records its creation time. Past `maxAgeMs` (15
minutes for Discord, matching the interaction token lifetime) flushes are
skipped, logged once, and treated as success. The token is dead by then, so
every attempt would fail; a stale manager should go quiet rather than generate
noise.

### Dismissal recovery

Discord does not notify us when a user dismisses an ephemeral message, so it
is only detectable on the next write. An edit that rejects with `10008 Unknown
Message` means the message is gone. The adapter marks its handle dead and
re-sends the **whole rendered stack** as a fresh ephemeral followUp, which
becomes the live message and continues to receive updates.

If the interaction token itself has expired there is nothing to recreate into;
the adapter logs and gives up quietly.

This is a deliberate behaviour change. Today, dismissing the progress message
ends the visible output. Afterwards, a dismissal mid-flow makes a new message
appear carrying the history so far.

## Call-site migration

All **interaction-scoped** output moves to the stack:

- `followUp({ ephemeral: true })` → `replyStack(i).ephemeral.append(...)`
- public `followUp` (e.g. the welcome message in `onboardUser`) →
  `replyStack(i).public.append(...)`
- `editReply` that revises an earlier line → `update(id)` on the entry that
  line created

Out of scope: direct channel sends unrelated to an interaction (`channel.ts`,
parts of `messageMods.ts`) and the `discordLogger` channels. Those are not
fragmentation and keep their current behaviour.

**Wrapper changes.** `discordCommandWrapper` stops its reply-then-delete
dance. It seeds an "executing" entry with `pending` status, removes that entry
before returning, and on error appends an `error` entry instead of calling
`editReply`. The final message is exactly the flow's real output, in the colour
its outcome earned.

Two consequences of that, both intended. A command whose flow appends nothing
ends with an empty ephemeral stack and therefore no message, matching today's
behaviour of deleting the progress reply. And a command that finishes inside
the debounce window never flushes the "executing" entry at all — the user sees
one message containing the result, with no progress flicker.

## Testing

`MessageStack` is pure: append/update/pop, ordering, ID lookup, render
joining, and the empty-stack case are direct unit tests. Colour severity gets
its own table-driven test — each status alone, and the precedence pairs that
matter (a `pending` entry alongside an `error` renders red, `attention` beats
`pending`). One test asserts entry text lands in the message content and never
in an embed description, since that is what keeps mentions pinging; another
asserts a statusless surface renders no banner.

Surface and manager behaviour uses a fake flusher — no Discord mocking, which
is the payoff of the injected lambda:

- a burst of mutations produces exactly one flush (fake timers)
- `flushAll` emits any pending state
- a flusher that rejects does not propagate
- flushes stop once past `maxAgeMs`
- a stack emptied by `pop` flushes `undefined`

The Discord adapter is tested against a fake message handle: create-then-edit,
`10008` triggers a recreate carrying the full stack, expired token gives up
quietly, over-limit payloads are clamped.

Converted flows assert message counts. The V1 link flow ending at one
ephemeral message instead of three is the regression test for the original
complaint.

## Decisions taken

- **In-memory only.** Persistence and encryption were considered and dropped;
  they were standing in for a concern about the registry leaking.
- **Plain `Map`, `finally` cleanup.** A `WeakMap` keyed on the interaction
  object would make leaks structurally impossible, but the leak paths (an
  await that never settles, creation outside the wrapper) were judged not
  worth the loss of enumerability.
- **Two stacks, not one with a flag.** At most one ephemeral and one public
  message; either may be absent.
- **Convert everything in one PR** rather than migrating flow by flow.
- **One status embed per surface**, coloured by the most severe entry status,
  rather than one embed per entry — stacking an embed per step would reproduce
  the visual clutter this change exists to remove.
- **Text in the message content, status in the embed.** Putting the body in an
  embed description would have looked tidier but silently broken every ping,
  and Discord cannot render an embed above content anyway.
