# Monthly Reports Automation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Automate the manual steps of the monthly No Show report and Hall of Fame post: cancelled-title filtering, ready-to-post formatting, new-host detection, 12-month no-show classification with doubled suspension penalties, and suspension record keeping.

**Architecture:** Pure computation lives in `src/lib/helpers/` (unit-tested with plain objects, following `eventStats.ts`). Persistence follows the existing `PostgresMemberRepository` singleton pattern. Discord commands stay thin: fetch via `GqlMeetupClient`, call helpers, reply via the existing wrappers.

**Tech Stack:** TypeScript ESM, discordx/discord.js 14, graphql-request via `GqlMeetupClient`, dayjs with the project's `tz()` util, pg, vitest.

**Spec:** `docs/superpowers/specs/2026-09-24-monthly-reports-automation-design.md`

## Global Constraints

- Suspension policy: 30 days × 2^(prior suspension count); act-by date = next RSVP'd event minus 3 days.
- Classification: 1 no-show in trailing 12 months → warning; 2+ → suspension candidate.
- Cancelled events: skip titles matching `/cancell?ed/i` and any `status` of `CANCELLED`, `CANCELLED_PERM`, `AUTOSCHED_CANCELLED`.
- `[Open House]` events stay excluded from host stats (existing behavior).
- Every occurrence of a recurring event counts; only the *display* collapses by title.
- Melissa executes warnings/suspensions — the bot only reports and records.
- Unit tests: `yarn test <path>`. Lint: `yarn lint`. All files ESM with `.js` import suffixes.

---

### Task 1: Hall of Fame pure helpers — cancelled filtering and host stats

**Files:**
- Create: `src/lib/helpers/hallOfFame.ts`
- Test: `tst/lib/helpers/hallOfFame.test.ts`

**Interfaces:**
- Consumes: `Event`, `BaseUserInfo` from `src/lib/client/meetup/types.js`.
- Produces: `isCancelledEvent(event: Pick<Event, 'title' | 'status'>): boolean`; `interface HostStats { host: BaseUserInfo; events: Event[] }`; `collectHostStats(events: Event[]): { hostStats: HostStats[]; totalEvents: number }` (hostStats sorted by event count descending; cancelled and `[Open House]` events excluded; per-event hosts deduped by member id).

- [ ] **Step 1: Write the failing tests**

```typescript
// tst/lib/helpers/hallOfFame.test.ts
import { describe, expect, it } from 'vitest';

import { Event } from '../../../src/lib/client/meetup/types.js';
import {
  collectHostStats,
  isCancelledEvent,
} from '../../../src/lib/helpers/hallOfFame.js';

let nextId = 0;
export function makeEvent(overrides: Partial<Event> = {}): Event {
  nextId += 1;
  return {
    id: `e${nextId}`,
    title: `Event ${nextId}`,
    dateTime: '2026-09-05T18:00:00Z',
    eventUrl: `https://meetup.com/e${nextId}`,
    eventHosts: [],
    maxTickets: 10,
    status: 'PAST',
    ...overrides,
  };
}

export function host(id: string, name = `Host ${id}`) {
  return { member: { id, name, gender: 'NONE', memberUrl: `https://meetup.com/members/${id}` } };
}

describe('isCancelledEvent', () => {
  it('matches cancelled titles in either spelling, any case', () => {
    expect(isCancelledEvent(makeEvent({ title: 'CANCELED: Hike' }))).toBe(true);
    expect(isCancelledEvent(makeEvent({ title: 'Trivia (cancelled)' }))).toBe(true);
    expect(isCancelledEvent(makeEvent({ title: 'Trivia Night' }))).toBe(false);
  });

  it('matches cancelled statuses', () => {
    expect(isCancelledEvent(makeEvent({ status: 'CANCELLED' }))).toBe(true);
    expect(isCancelledEvent(makeEvent({ status: 'CANCELLED_PERM' }))).toBe(true);
    expect(isCancelledEvent(makeEvent({ status: 'AUTOSCHED_CANCELLED' }))).toBe(true);
    expect(isCancelledEvent(makeEvent({ status: 'PAST' }))).toBe(false);
  });

  it('does not match titles merely containing "cancel"', () => {
    expect(isCancelledEvent(makeEvent({ title: 'How to cancel plans' }))).toBe(false);
  });
});

describe('collectHostStats', () => {
  it('groups events by host, sorted by count descending', () => {
    const events = [
      makeEvent({ eventHosts: [host('a')] }),
      makeEvent({ eventHosts: [host('b')] }),
      makeEvent({ eventHosts: [host('b')] }),
    ];
    const { hostStats, totalEvents } = collectHostStats(events);
    expect(totalEvents).toBe(3);
    expect(hostStats.map((s) => s.host.id)).toEqual(['b', 'a']);
    expect(hostStats[0].events).toHaveLength(2);
  });

  it('excludes cancelled and [Open House] events from stats and totals', () => {
    const events = [
      makeEvent({ eventHosts: [host('a')] }),
      makeEvent({ title: 'Canceled: Hike', eventHosts: [host('a')] }),
      makeEvent({ title: '[Open House] Social', eventHosts: [host('a')] }),
    ];
    const { hostStats, totalEvents } = collectHostStats(events);
    expect(totalEvents).toBe(1);
    expect(hostStats[0].events).toHaveLength(1);
  });

  it('counts a co-hosted event once in the total but once per host', () => {
    const events = [makeEvent({ eventHosts: [host('a'), host('b')] })];
    const { hostStats, totalEvents } = collectHostStats(events);
    expect(totalEvents).toBe(1);
    expect(hostStats).toHaveLength(2);
  });

  it('dedupes a host listed twice on one event', () => {
    const events = [makeEvent({ eventHosts: [host('a'), host('a')] })];
    const { hostStats } = collectHostStats(events);
    expect(hostStats[0].events).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn test tst/lib/helpers/hallOfFame.test.ts`
Expected: FAIL — cannot find module `src/lib/helpers/hallOfFame.js`.

- [ ] **Step 3: Write the implementation**

```typescript
// src/lib/helpers/hallOfFame.ts
/**
 * Pure logic behind the monthly Hall of Fame post. Kept separate from the
 * Discord command so the counting and formatting that moderators quote
 * publicly is unit-testable.
 */
import { BaseUserInfo, Event, EventStatus } from '../client/meetup/types.js';

const CANCELLED_TITLE = /cancell?ed/i;
const CANCELLED_STATUSES: EventStatus[] = [
  'CANCELLED',
  'CANCELLED_PERM',
  'AUTOSCHED_CANCELLED',
];

/**
 * Hosts sometimes rename an event "cancelled" instead of cancelling it on
 * the platform, so the title check matters even though the group-events
 * query never requests cancelled statuses.
 */
export function isCancelledEvent(
  event: Pick<Event, 'title' | 'status'>,
): boolean {
  return (
    CANCELLED_TITLE.test(event.title) ||
    CANCELLED_STATUSES.includes(event.status)
  );
}

export interface HostStats {
  host: BaseUserInfo;
  events: Event[];
}

/**
 * Groups countable events (not cancelled, not [Open House]) by host,
 * deduping hosts within a single event. totalEvents counts each event once
 * regardless of how many hosts it has.
 */
export function collectHostStats(events: Event[]): {
  hostStats: HostStats[];
  totalEvents: number;
} {
  const countable = events.filter(
    (event) => !isCancelledEvent(event) && !event.title.includes('[Open House]'),
  );
  const byHost = new Map<string, HostStats>();
  for (const event of countable) {
    const seen = new Set<string>();
    for (const { member } of event.eventHosts) {
      if (seen.has(member.id)) {
        continue;
      }
      seen.add(member.id);
      const stats = byHost.get(member.id) ?? { host: member, events: [] };
      stats.events.push(event);
      byHost.set(member.id, stats);
    }
  }
  const hostStats = Array.from(byHost.values()).sort(
    (a, b) => b.events.length - a.events.length,
  );
  return { hostStats, totalEvents: countable.length };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `yarn test tst/lib/helpers/hallOfFame.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/helpers/hallOfFame.ts tst/lib/helpers/hallOfFame.test.ts
git commit -m "Add cancelled filtering and host stat collection for Hall of Fame"
```

---

### Task 2: Hall of Fame ready-to-post formatting

**Files:**
- Modify: `src/lib/helpers/hallOfFame.ts`
- Test: `tst/lib/helpers/hallOfFame.test.ts`

**Interfaces:**
- Consumes: `HostStats` from Task 1; `tz` from `src/util/timezone.js`; `dayjs`.
- Produces: `formatHallOfFamePost(input: { periodLabel: string; hostStats: HostStats[]; totalEvents: number; newHostIds: Set<string> }): string` — ranked hosts, recurring titles collapsed as `Title ×N (dates)`, 🆕 flag, a "New hosts" section listing each new host's co-hosts, and totals computed from the same data.

- [ ] **Step 1: Write the failing tests**

Append to `tst/lib/helpers/hallOfFame.test.ts`:

```typescript
import { formatHallOfFamePost } from '../../../src/lib/helpers/hallOfFame.js';

describe('formatHallOfFamePost', () => {
  const events = [
    makeEvent({ title: 'Trivia Night', dateTime: '2026-09-03T18:00:00Z', eventHosts: [host('a', 'Alice')] }),
    makeEvent({ title: 'Trivia Night', dateTime: '2026-09-10T18:00:00Z', eventHosts: [host('a', 'Alice')] }),
    makeEvent({ title: 'Hike', dateTime: '2026-09-06T09:00:00Z', eventHosts: [host('a', 'Alice'), host('b', 'Bob')] }),
  ];

  function post(newHostIds = new Set<string>()) {
    const { hostStats, totalEvents } = collectHostStats(events);
    return formatHallOfFamePost({
      periodLabel: 'September 2026',
      hostStats,
      totalEvents,
      newHostIds,
    });
  }

  it('collapses recurring titles with a count while still counting every occurrence', () => {
    const result = post();
    expect(result).toContain('Trivia Night ×2');
    expect(result).not.toMatch(/Trivia Night ×2[\s\S]*Trivia Night/);
    expect(result).toContain('#1: Alice — 3 events');
  });

  it('does not add ×1 to one-off events', () => {
    expect(post()).toContain('Hike (');
    expect(post()).not.toContain('Hike ×1');
  });

  it('flags new hosts and lists their co-hosts', () => {
    const result = post(new Set(['b']));
    expect(result).toContain('🆕');
    expect(result).toContain('New hosts: Bob (co-hosts: Alice)');
  });

  it('omits the new host section when there are none', () => {
    expect(post()).not.toContain('New hosts');
  });

  it('quotes totals computed from the data', () => {
    expect(post()).toContain('Hosts: 2');
    expect(post()).toContain('Events: 3');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn test tst/lib/helpers/hallOfFame.test.ts`
Expected: FAIL — `formatHallOfFamePost` is not exported.

- [ ] **Step 3: Write the implementation**

Append to `src/lib/helpers/hallOfFame.ts`:

```typescript
import dayjs from 'dayjs';

import { tz } from '../../util/timezone.js';
```

(merge these imports with the existing import block at the top of the file), then:

```typescript
function collapseByTitle(events: Event[]): string[] {
  const byTitle = new Map<string, Event[]>();
  for (const event of events) {
    const group = byTitle.get(event.title) ?? [];
    group.push(event);
    byTitle.set(event.title, group);
  }
  return Array.from(byTitle.entries()).map(([title, group]) => {
    const dates = group
      .map((event) => tz(dayjs(event.dateTime)).format('MMM D'))
      .join(', ');
    const suffix = group.length > 1 ? ` ×${group.length}` : '';
    return `${title}${suffix} (${dates})`;
  });
}

/** Co-hosts of a member across their events this period, deduped. */
function coHostsOf(hostId: string, events: Event[]): BaseUserInfo[] {
  const coHosts = new Map<string, BaseUserInfo>();
  for (const event of events) {
    for (const { member } of event.eventHosts) {
      if (member.id !== hostId) {
        coHosts.set(member.id, member);
      }
    }
  }
  return Array.from(coHosts.values());
}

export function formatHallOfFamePost(input: {
  periodLabel: string;
  hostStats: HostStats[];
  totalEvents: number;
  newHostIds: Set<string>;
}): string {
  const { periodLabel, hostStats, totalEvents, newHostIds } = input;
  const rankings = hostStats
    .map((stats, index) => {
      const flag = newHostIds.has(stats.host.id) ? ' 🆕' : '';
      const header = `**#${index + 1}: ${stats.host.name} — ${
        stats.events.length
      } event${stats.events.length === 1 ? '' : 's'}**${flag}`;
      const body = collapseByTitle(stats.events)
        .map((line) => `    ${line}`)
        .join('\n');
      return `${header}\n${body}`;
    })
    .join('\n');

  const newHosts = hostStats.filter((stats) => newHostIds.has(stats.host.id));
  const newHostSection =
    newHosts.length === 0
      ? ''
      : `\n\nNew hosts: ${newHosts
          .map((stats) => {
            const coHosts = coHostsOf(stats.host.id, stats.events);
            const coHostStr =
              coHosts.length === 0
                ? 'no co-hosts'
                : `co-hosts: ${coHosts.map((m) => m.name).join(', ')}`;
            return `${stats.host.name} (${coHostStr})`;
          })
          .join('; ')}`;

  return `**Hall of Fame — ${periodLabel}**

${rankings}${newHostSection}

**Hosts: ${hostStats.length} · Events: ${totalEvents}**`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `yarn test tst/lib/helpers/hallOfFame.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/helpers/hallOfFame.ts tst/lib/helpers/hallOfFame.test.ts
git commit -m "Add ready-to-post Hall of Fame formatting with recurring-title collapse"
```

---

### Task 3: Wire Hall of Fame into `meetup_get_host_event_stats` with new-host detection

**Files:**
- Modify: `src/commands/meetup/getEventStats.ts` (the `meetupGetHostEventStatsHandler` method and module top)
- No new unit test (thin fetch/wiring layer; logic was tested in Tasks 1–2). Manual verification step included.

**Interfaces:**
- Consumes: `collectHostStats`, `formatHallOfFamePost`, `isCancelledEvent` from `src/lib/helpers/hallOfFame.js`; `meetupClient.getGroupEvents(paginationInput, filter)` which returns `{ groupByUrlname: { events: { totalCount, edges, pageInfo } } }`.
- Produces: `findNewHostIds(meetupClient: GqlMeetupClient, hostIds: string[], beforeIso: string): Promise<Set<string>>` (module-level function in `getEventStats.ts`, exported for reuse awareness but used only here).

- [ ] **Step 1: Add `findNewHostIds` and rework the handler body**

Add near the top of `src/commands/meetup/getEventStats.ts` (after `getEventsYearMonth`):

```typescript
/**
 * A host is "new" when the group has no PAST event of theirs before the
 * report window. One first:1 totalCount query per host, run in parallel.
 * Live-schema introspection (2026-09-25) confirmed GroupEventFilter accepts
 * hostId + beforeDateTime + status; see the design spec for the fallback if
 * the resolver ignores the combination.
 */
export async function findNewHostIds(
  meetupClient: GqlMeetupClient,
  hostIds: string[],
  beforeIso: string,
): Promise<Set<string>> {
  const checks = await Promise.all(
    hostIds.map(async (hostId) => {
      const result = await meetupClient.getGroupEvents(
        { first: 1 },
        { hostId, beforeDateTime: beforeIso, status: ['PAST'] },
      );
      return { hostId, priorCount: result.groupByUrlname.events.totalCount };
    }),
  );
  return new Set(
    checks.filter((check) => check.priorCount === 0).map((c) => c.hostId),
  );
}
```

Then replace the body of `meetupGetHostEventStatsHandler` inside the `withMeetupClient` callback (keep the option parsing and wrappers as they are). The per-event RSVP fetch and the old manual grouping (`total`, `hostEvents`, `hosts` maps, `formattedResult`) are replaced by the helpers; the detailed per-host attachment keeps its current shape but is now built from `collectHostStats` output:

```typescript
logger.info('Fetching data');
await interaction.editReply({ content: 'Sit tight! Fetching data.' });

const pastEvents = await getEventsYearMonth(meetupClient, year, month);
const countableEvents = pastEvents.filter(
  (event) => !isCancelledEvent(event),
);

// Attendance counts for the detailed attachment (unchanged data, but only
// for countable events).
const rsvpCounts = new Map<string, number>();
await Promise.all(
  countableEvents
    .filter((event) => !event.title.includes('[Open House]'))
    .map(async (event) => {
      const rsvps = await getPaginatedData(async (paginationInput) => {
        const result = await meetupClient.getEventRsvps(
          event.id,
          paginationInput,
          { rsvpStatus: ['ATTENDED', 'YES'] },
        );
        return result.event.rsvps;
      });
      rsvpCounts.set(event.id, rsvps.length);
    }),
);

const { hostStats, totalEvents } = collectHostStats(pastEvents);

const monthStart = tz(dayjs())
  .set('year', year)
  .set('month', month === 0 ? 0 : month - 1)
  .startOf(month === 0 ? 'year' : 'month');
const newHostIds = await findNewHostIds(
  meetupClient,
  hostStats.map((stats) => stats.host.id),
  monthStart.toISOString(),
);

const detailedResult = hostStats
  .map((stats, index) => {
    const { host, events } = stats;
    const header = `**#${index + 1}: ${events.length} ${
      shouldIncludeLinks ? linkStr(host.name, host.memberUrl) : host.name
    } ID: ${host.id}**${newHostIds.has(host.id) ? ' 🆕' : ''}\n`;
    const body = events
      .map((event) => {
        const titleStr = `${event.title} (${rsvpCounts.get(event.id) ?? 0}/${
          event.maxTickets
        })`;
        return `    ${
          shouldIncludeLinks ? linkStr(titleStr, event.eventUrl) : titleStr
        } ${shouldShowDates ? tz(dayjs(event.dateTime)).format('LLL') : ''}`;
      })
      .join('\n');
    return header + body;
  })
  .join('\n');

const periodLabel = `${year}${
  month > 0
    ? ` ${dayjs()
        .month(month - 1)
        .format('MMMM')}`
    : ''
}`;
const header = `**Hosting stats for ${periodLabel}**`;
const readyToPost = formatHallOfFamePost({
  periodLabel,
  hostStats,
  totalEvents,
  newHostIds,
});
const result = `
${header}

${detailedResult}

**Total: ${totalEvents}**

----- READY TO POST -----

${readyToPost}`;
await withDiscordFileAttachment(
  `${header}.txt`,
  result,
  async (attachmentArgs) => {
    await interaction.followUp({
      ...attachmentArgs,
      content: 'Check the results in the attachment!',
      ephemeral: true,
    });
  },
);
```

Add the new imports at the top of the file:

```typescript
import {
  collectHostStats,
  formatHallOfFamePost,
  isCancelledEvent,
} from '../../lib/helpers/hallOfFame.js';
```

Note: `BaseUserInfo` may become unused in this file after the rewrite of this handler — remove it from the import only if the no-show handler (untouched here) no longer uses it either (it does use it; keep it).

- [ ] **Step 2: Typecheck, lint, and run the full unit suite**

Run: `yarn lint && yarn test`
Expected: no lint errors, all tests pass.

- [ ] **Step 3: Manual live verification of the hostId filter (checkpoint)**

This cannot run in CI. Ask the human partner (or use dev credentials via `yarn dev` and the existing `/meetup_test_gql` command) to run:

```graphql
query {
  groupByUrlname(urlname: "<group urlname>") {
    events(first: 1, filter: { hostId: "<known long-time host id>", beforeDateTime: "2026-01-01T00:00:00Z", status: [PAST] }) {
      totalCount
    }
  }
}
```

Expected: `totalCount` > 0 for a long-time host, and 0 when queried with a member id who has never hosted. **If the filter combination is not honored** (e.g. totalCount ignores hostId), implement the spec's fallback instead: replace `findNewHostIds` internals with one paginated `getGroupEvents` scan over `{ beforeDateTime: beforeIso, status: ['PAST'] }` via `getPaginatedData`, collecting every non-cancelled event's `eventHosts` member ids into a `Set`, and return `hostIds.filter(id => !set.has(id))` as the new set.

- [ ] **Step 4: Commit**

```bash
git add src/commands/meetup/getEventStats.ts
git commit -m "Produce ready-to-post Hall of Fame with cancelled filtering and new-host flags"
```

---

### Task 4: No Show pure helpers — tally, classification, penalty, act-by, report format

**Files:**
- Create: `src/lib/helpers/noShowReport.ts`
- Test: `tst/lib/helpers/noShowReport.test.ts`

**Interfaces:**
- Consumes: `BaseUserInfo`, `Event` from `src/lib/client/meetup/types.js`; `dayjs`, `tz`.
- Produces:
  - `tallyNoShows(resultsPerEvent: { event: Event; rsvps: { member: BaseUserInfo }[] }[]): Map<string, { member: BaseUserInfo; events: Event[] }>`
  - `classifyNoShowCount(count: number): 'warning' | 'suspension'` (count >= 1)
  - `recommendedSuspensionDays(priorSuspensions: number): number` — `30 * 2 ** priorSuspensions`
  - `actByDate(nextEventIso: string, now: dayjs.Dayjs): { actBy: dayjs.Dayjs; actNow: boolean }` — next event minus 3 days; `actNow` when that is not after `now`
  - `interface NoShowCase { member: BaseUserInfo; monthEvents: Event[]; twelveMonthCount: number; classification: 'warning' | 'suspension'; priorSuspensions?: number; recommendedDays?: number; nextRsvpEvent?: Event; actBy?: string; actNow?: boolean }`
  - `formatNoShowReport(periodLabel: string, cases: NoShowCase[]): string`

- [ ] **Step 1: Write the failing tests**

```typescript
// tst/lib/helpers/noShowReport.test.ts
import dayjs from 'dayjs';
import { describe, expect, it } from 'vitest';

import { BaseUserInfo, Event } from '../../../src/lib/client/meetup/types.js';
import {
  NoShowCase,
  actByDate,
  classifyNoShowCount,
  formatNoShowReport,
  recommendedSuspensionDays,
  tallyNoShows,
} from '../../../src/lib/helpers/noShowReport.js';

function member(id: string, name = `Member ${id}`): BaseUserInfo {
  return { id, name, gender: 'NONE', memberUrl: `https://meetup.com/members/${id}` };
}

let nextId = 0;
function event(title = 'Event', dateTime = '2026-09-05T18:00:00Z'): Event {
  nextId += 1;
  return {
    id: `e${nextId}`,
    title,
    dateTime,
    eventUrl: `https://meetup.com/e${nextId}`,
    eventHosts: [],
    maxTickets: 10,
    status: 'PAST',
  };
}

describe('classifyNoShowCount', () => {
  it('warns at exactly one and suspends at two or more', () => {
    expect(classifyNoShowCount(1)).toBe('warning');
    expect(classifyNoShowCount(2)).toBe('suspension');
    expect(classifyNoShowCount(5)).toBe('suspension');
  });
});

describe('recommendedSuspensionDays', () => {
  it('starts at 30 and doubles per prior suspension', () => {
    expect(recommendedSuspensionDays(0)).toBe(30);
    expect(recommendedSuspensionDays(1)).toBe(60);
    expect(recommendedSuspensionDays(3)).toBe(240);
  });
});

describe('actByDate', () => {
  it('is three days before the next event', () => {
    const { actBy, actNow } = actByDate(
      '2026-10-10T18:00:00Z',
      dayjs('2026-10-01T00:00:00Z'),
    );
    expect(actBy.isSame(dayjs('2026-10-07T18:00:00Z'))).toBe(true);
    expect(actNow).toBe(false);
  });

  it('flags act-now when the window has already opened', () => {
    const { actNow } = actByDate(
      '2026-10-03T18:00:00Z',
      dayjs('2026-10-02T00:00:00Z'),
    );
    expect(actNow).toBe(true);
  });
});

describe('tallyNoShows', () => {
  it('accumulates events per member across events', () => {
    const alice = member('a');
    const bob = member('b');
    const e1 = event();
    const e2 = event();
    const tally = tallyNoShows([
      { event: e1, rsvps: [{ member: alice }, { member: bob }] },
      { event: e2, rsvps: [{ member: alice }] },
    ]);
    expect(tally.get('a')?.events).toHaveLength(2);
    expect(tally.get('b')?.events).toHaveLength(1);
  });
});

describe('formatNoShowReport', () => {
  const warning: NoShowCase = {
    member: member('a', 'Alice'),
    monthEvents: [event('Trivia')],
    twelveMonthCount: 1,
    classification: 'warning',
  };
  const suspension: NoShowCase = {
    member: member('b', 'Bob'),
    monthEvents: [event('Hike')],
    twelveMonthCount: 3,
    classification: 'suspension',
    priorSuspensions: 1,
    recommendedDays: 60,
    nextRsvpEvent: event('Picnic', '2026-10-10T18:00:00Z'),
    actBy: 'Oct 7',
    actNow: false,
  };

  it('groups warnings and suspension candidates separately', () => {
    const report = formatNoShowReport('2026 September', [warning, suspension]);
    expect(report).toMatch(/Warnings[\s\S]*Alice/);
    expect(report).toMatch(/Suspension candidates[\s\S]*Bob/);
  });

  it('shows the penalty math and act-by date for candidates', () => {
    const report = formatNoShowReport('2026 September', [suspension]);
    expect(report).toContain('prior suspensions: 1');
    expect(report).toContain('recommended: 60 days');
    expect(report).toContain('act by Oct 7');
  });

  it('says ACT NOW when the window has opened', () => {
    const report = formatNoShowReport('2026 September', [
      { ...suspension, actNow: true },
    ]);
    expect(report).toContain('ACT NOW');
  });

  it('notes when a candidate has no upcoming RSVPs', () => {
    const report = formatNoShowReport('2026 September', [
      { ...suspension, nextRsvpEvent: undefined, actBy: undefined, actNow: undefined },
    ]);
    expect(report).toContain('no upcoming RSVPs');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn test tst/lib/helpers/noShowReport.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```typescript
// src/lib/helpers/noShowReport.ts
/**
 * Pure logic behind the monthly No Show report. The policy encoded here
 * (warn at 1, suspend at 2+, 30 days doubling per prior suspension, act 3
 * days before the member's next event) is the group's moderation policy —
 * see docs/superpowers/specs/2026-09-24-monthly-reports-automation-design.md.
 */
import dayjs from 'dayjs';

import { BaseUserInfo, Event } from '../client/meetup/types.js';
import { linkStr } from '../../util/discord.js';
import { tz } from '../../util/timezone.js';

export function classifyNoShowCount(count: number): 'warning' | 'suspension' {
  return count >= 2 ? 'suspension' : 'warning';
}

export function recommendedSuspensionDays(priorSuspensions: number): number {
  return 30 * 2 ** priorSuspensions;
}

/** The suspension should land at least 3 days before the next event. */
export function actByDate(
  nextEventIso: string,
  now: dayjs.Dayjs,
): { actBy: dayjs.Dayjs; actNow: boolean } {
  const actBy = dayjs(nextEventIso).subtract(3, 'day');
  return { actBy, actNow: !actBy.isAfter(now) };
}

export function tallyNoShows(
  resultsPerEvent: { event: Event; rsvps: { member: BaseUserInfo }[] }[],
): Map<string, { member: BaseUserInfo; events: Event[] }> {
  const tally = new Map<string, { member: BaseUserInfo; events: Event[] }>();
  for (const { event, rsvps } of resultsPerEvent) {
    for (const { member } of rsvps) {
      const entry = tally.get(member.id) ?? { member, events: [] };
      entry.events.push(event);
      tally.set(member.id, entry);
    }
  }
  return tally;
}

export interface NoShowCase {
  member: BaseUserInfo;
  monthEvents: Event[];
  twelveMonthCount: number;
  classification: 'warning' | 'suspension';
  priorSuspensions?: number;
  recommendedDays?: number;
  nextRsvpEvent?: Event;
  actBy?: string;
  actNow?: boolean;
}

function formatEventLine(event: Event): string {
  return `    ${linkStr(event.title, event.eventUrl)} ${tz(
    dayjs(event.dateTime),
  ).format('LLL')}`;
}

function formatCase(noShowCase: NoShowCase): string {
  const { member, monthEvents, twelveMonthCount } = noShowCase;
  const header = `**${linkStr(member.name, member.memberUrl)} ID: ${
    member.id
  }** — ${twelveMonthCount} no-show${
    twelveMonthCount === 1 ? '' : 's'
  } in the last 12 months`;
  const lines = [header];
  if (noShowCase.classification === 'suspension') {
    lines.push(
      `    prior suspensions: ${noShowCase.priorSuspensions} → recommended: ${noShowCase.recommendedDays} days`,
    );
    if (noShowCase.nextRsvpEvent) {
      const timing = noShowCase.actNow
        ? `**ACT NOW** (event is within 3 days)`
        : `act by ${noShowCase.actBy}`;
      lines.push(
        `    next RSVP: ${linkStr(
          noShowCase.nextRsvpEvent.title,
          noShowCase.nextRsvpEvent.eventUrl,
        )} ${tz(dayjs(noShowCase.nextRsvpEvent.dateTime)).format(
          'LLL',
        )} → ${timing}`,
      );
    } else {
      lines.push('    no upcoming RSVPs — suspend at any time');
    }
  }
  lines.push(...monthEvents.map(formatEventLine));
  return lines.join('\n');
}

export function formatNoShowReport(
  periodLabel: string,
  cases: NoShowCase[],
): string {
  const warnings = cases.filter((c) => c.classification === 'warning');
  const suspensions = cases.filter((c) => c.classification === 'suspension');
  const sections = [`**No Show report for ${periodLabel}**`];
  sections.push(
    `__Warnings (1 no-show in 12 months): ${warnings.length}__`,
    ...(warnings.length ? [warnings.map(formatCase).join('\n')] : []),
  );
  sections.push(
    `__Suspension candidates (2+ no-shows in 12 months): ${suspensions.length}__`,
    ...(suspensions.length ? [suspensions.map(formatCase).join('\n')] : []),
  );
  return sections.join('\n\n');
}
```

Note: `linkStr` lives in `src/util/discord.ts` and is a pure string function — importing it here does not pull Discord runtime state into unit tests (`discord.ts` imports are type/constant only at module load).

- [ ] **Step 4: Run test to verify it passes**

Run: `yarn test tst/lib/helpers/noShowReport.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/helpers/noShowReport.ts tst/lib/helpers/noShowReport.test.ts
git commit -m "Add no-show classification, penalty, and report formatting helpers"
```

---

### Task 5: Suspension repository (types, Postgres, integration test)

**Files:**
- Modify: `src/lib/repositories/types.ts` (append)
- Create: `src/lib/repositories/postgresSuspensionRepository.ts`
- Test: `tst/integration/postgresSuspensionRepository.test.ts`

**Interfaces:**
- Consumes: `pg`, existing repository conventions.
- Produces (appended to `src/lib/repositories/types.ts`):

```typescript
export interface SuspensionRecord {
  id: number;
  memberId: string;
  memberName: string | null;
  suspendedAt: Date;
  durationDays: number;
  notes: string | null;
  createdAt: Date;
}

export type SuspensionInsert = Omit<SuspensionRecord, 'id' | 'createdAt'>;

export interface SuspensionRepository {
  insert(record: SuspensionInsert): Promise<SuspensionRecord>;
  insertMany(records: SuspensionInsert[]): Promise<SuspensionRecord[]>;
  countSuspensionsBefore(memberId: string, before: Date): Promise<number>;
  listByMemberId(memberId: string): Promise<SuspensionRecord[]>;
}
```

- [ ] **Step 1: Append the interfaces above to `src/lib/repositories/types.ts`**

- [ ] **Step 2: Write the failing integration test**

```typescript
// tst/integration/postgresSuspensionRepository.test.ts
// Mirrors tst/integration/postgresMemberRepository.test.ts conventions —
// read that file first and copy its setup/teardown (docker Postgres via
// DATABASE_URL, table truncation between tests) exactly.
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import { PostgresSuspensionRepository } from '../../src/lib/repositories/postgresSuspensionRepository.js';

describe('PostgresSuspensionRepository', () => {
  let repo: PostgresSuspensionRepository;

  beforeAll(async () => {
    repo = await PostgresSuspensionRepository.instance();
  });

  afterEach(async () => {
    await repo.deleteAllForTest();
  });

  const record = {
    memberId: 'm1',
    memberName: 'Alice',
    suspendedAt: new Date('2026-09-01T00:00:00Z'),
    durationDays: 30,
    notes: null,
  };

  it('inserts and counts by member', async () => {
    await repo.insert(record);
    await repo.insert({ ...record, durationDays: 60 });
    expect((await repo.listByMemberId('m1')).length).toBe(2);
    expect((await repo.listByMemberId('other')).length).toBe(0);
  });

  it('lists records for a member, newest first', async () => {
    await repo.insert(record);
    await repo.insert({
      ...record,
      suspendedAt: new Date('2026-10-01T00:00:00Z'),
      durationDays: 60,
    });
    const rows = await repo.listByMemberId('m1');
    expect(rows).toHaveLength(2);
    expect(rows[0].durationDays).toBe(60);
  });

  it('insertMany inserts all rows atomically', async () => {
    const rows = await repo.insertMany([
      record,
      { ...record, memberId: 'm2', memberName: 'Bob' },
    ]);
    expect(rows).toHaveLength(2);
    expect((await repo.listByMemberId('m2')).length).toBe(1);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `yarn docker:up` then `DATABASE_URL=postgres://postgres:postgres@localhost:5432/meetup_bot REDISCLOUD_URL=redis://localhost:6379 yarn test:integration tst/integration/postgresSuspensionRepository.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Write the implementation**

```typescript
// src/lib/repositories/postgresSuspensionRepository.ts
import pg from 'pg';
import { Logger } from 'tslog';

import {
  SuspensionInsert,
  SuspensionRecord,
  SuspensionRepository,
} from './types.js';

const logger = new Logger({ name: 'PostgresSuspensionRepository' });

const CREATE_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS suspension_records (
  id            SERIAL PRIMARY KEY,
  member_id     TEXT NOT NULL,
  member_name   TEXT,
  suspended_at  TIMESTAMPTZ NOT NULL,
  duration_days INTEGER NOT NULL,
  notes         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS suspension_records_member_id_idx
  ON suspension_records (member_id);
`;

interface SuspensionRow {
  id: number;
  member_id: string;
  member_name: string | null;
  suspended_at: Date;
  duration_days: number;
  notes: string | null;
  created_at: Date;
}

function toRecord(row: SuspensionRow): SuspensionRecord {
  return {
    id: row.id,
    memberId: row.member_id,
    memberName: row.member_name,
    suspendedAt: row.suspended_at,
    durationDays: row.duration_days,
    notes: row.notes,
    createdAt: row.created_at,
  };
}

/**
 * Postgres-backed suspension history. Same lifecycle conventions as
 * PostgresMemberRepository: singleton, lazy schema ensure, Heroku TLS.
 */
export class PostgresSuspensionRepository implements SuspensionRepository {
  private pool: pg.Pool;

  private schemaEnsured: Promise<void> | undefined;

  private static singleton: PostgresSuspensionRepository;

  private constructor() {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error(
        'PostgresSuspensionRepository requires DATABASE_URL to be set',
      );
    }
    const isLocal =
      connectionString.includes('localhost') ||
      connectionString.includes('127.0.0.1');
    this.pool = new pg.Pool({
      connectionString,
      max: 5,
      ssl: isLocal ? undefined : { rejectUnauthorized: false },
      allowExitOnIdle: true,
    });
    this.pool.on('error', (error) => {
      logger.error(`Postgres pool error: ${String(error)}`);
    });
  }

  public static async instance(): Promise<PostgresSuspensionRepository> {
    if (this.singleton === undefined) {
      this.singleton = new PostgresSuspensionRepository();
    }
    const repo = this.singleton;
    if (repo.schemaEnsured === undefined) {
      repo.schemaEnsured = (async () => {
        await repo.pool.query(CREATE_TABLE_SQL);
      })();
    }
    try {
      await repo.schemaEnsured;
    } catch (error) {
      repo.schemaEnsured = undefined; // retry on next call
      throw error;
    }
    return repo;
  }

  async insert(record: SuspensionInsert): Promise<SuspensionRecord> {
    const result = await this.pool.query<SuspensionRow>(
      `INSERT INTO suspension_records
         (member_id, member_name, suspended_at, duration_days, notes)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [
        record.memberId,
        record.memberName,
        record.suspendedAt,
        record.durationDays,
        record.notes,
      ],
    );
    return toRecord(result.rows[0]);
  }

  async insertMany(records: SuspensionInsert[]): Promise<SuspensionRecord[]> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const inserted: SuspensionRecord[] = [];
      for (const record of records) {
        // eslint-disable-next-line no-await-in-loop
        const result = await client.query<SuspensionRow>(
          `INSERT INTO suspension_records
             (member_id, member_name, suspended_at, duration_days, notes)
           VALUES ($1, $2, $3, $4, $5)
           RETURNING *`,
          [
            record.memberId,
            record.memberName,
            record.suspendedAt,
            record.durationDays,
            record.notes,
          ],
        );
        inserted.push(toRecord(result.rows[0]));
      }
      await client.query('COMMIT');
      return inserted;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async countSuspensionsBefore(
    memberId: string,
    before: Date,
  ): Promise<number> {
    const result = await this.pool.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM suspension_records
       WHERE member_id = $1 AND suspended_at < $2`,
      [memberId, before],
    );
    return Number(result.rows[0].count);
  }

  async listByMemberId(memberId: string): Promise<SuspensionRecord[]> {
    const result = await this.pool.query<SuspensionRow>(
      `SELECT * FROM suspension_records
       WHERE member_id = $1
       ORDER BY suspended_at DESC`,
      [memberId],
    );
    return result.rows.map(toRecord);
  }

  /** Test-only cleanup, mirroring the member repository's test hooks. */
  async deleteAllForTest(): Promise<void> {
    await this.pool.query('DELETE FROM suspension_records');
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `DATABASE_URL=postgres://postgres:postgres@localhost:5432/meetup_bot REDISCLOUD_URL=redis://localhost:6379 yarn test:integration tst/integration/postgresSuspensionRepository.test.ts`
Expected: PASS. Also confirm the existing suite still passes: `yarn test`.

- [ ] **Step 6: Commit**

```bash
git add src/lib/repositories/types.ts src/lib/repositories/postgresSuspensionRepository.ts tst/integration/postgresSuspensionRepository.test.ts
git commit -m "Add Postgres suspension_records repository"
```

---

### Task 6: Suspension CSV parser

**Files:**
- Create: `src/lib/helpers/suspensionCsv.ts`
- Test: `tst/lib/helpers/suspensionCsv.test.ts`

**Interfaces:**
- Consumes: `SuspensionInsert` from `src/lib/repositories/types.js`.
- Produces: `parseSuspensionCsv(text: string): SuspensionInsert[]` — expects header `member_id,duration_days,suspended_at,notes`; throws `Error` naming the first bad row. Dates parsed as `YYYY-MM-DD`.

- [ ] **Step 1: Write the failing tests**

```typescript
// tst/lib/helpers/suspensionCsv.test.ts
import { describe, expect, it } from 'vitest';

import { parseSuspensionCsv } from '../../../src/lib/helpers/suspensionCsv.js';

const HEADER = 'member_id,duration_days,suspended_at,notes';

describe('parseSuspensionCsv', () => {
  it('parses rows into inserts', () => {
    const rows = parseSuspensionCsv(
      `${HEADER}\n123,30,2026-01-15,\n456,60,2026-02-01,was warned twice`,
    );
    expect(rows).toEqual([
      {
        memberId: '123',
        memberName: null,
        durationDays: 30,
        suspendedAt: new Date('2026-01-15T00:00:00Z'),
        notes: null,
      },
      {
        memberId: '456',
        memberName: null,
        durationDays: 60,
        suspendedAt: new Date('2026-02-01T00:00:00Z'),
        notes: 'was warned twice',
      },
    ]);
  });

  it('skips blank lines and trims whitespace', () => {
    const rows = parseSuspensionCsv(`${HEADER}\n 123 , 30 ,2026-01-15,\n\n`);
    expect(rows).toHaveLength(1);
    expect(rows[0].memberId).toBe('123');
  });

  it('rejects a wrong header', () => {
    expect(() => parseSuspensionCsv('id,days\n1,30')).toThrow(/header/i);
  });

  it('rejects a bad duration with the row number', () => {
    expect(() =>
      parseSuspensionCsv(`${HEADER}\n123,thirty,2026-01-15,`),
    ).toThrow(/row 2/i);
  });

  it('rejects a bad date with the row number', () => {
    expect(() =>
      parseSuspensionCsv(`${HEADER}\n123,30,Jan 15,`),
    ).toThrow(/row 2/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn test tst/lib/helpers/suspensionCsv.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```typescript
// src/lib/helpers/suspensionCsv.ts
/**
 * Parser for the /meetup_record_suspension CSV attachment. The same format
 * serves the one-time spreadsheet backfill and ongoing exception entries,
 * so errors must name the offending row — moderators fix the sheet, not us.
 */
import { SuspensionInsert } from '../repositories/types.js';

const EXPECTED_HEADER = 'member_id,duration_days,suspended_at,notes';
const DATE_FORMAT = /^\d{4}-\d{2}-\d{2}$/;

export function parseSuspensionCsv(text: string): SuspensionInsert[] {
  const lines = text.split(/\r?\n/);
  const header = (lines[0] ?? '').replaceAll(' ', '').toLowerCase();
  if (header !== EXPECTED_HEADER) {
    throw new Error(
      `Unexpected CSV header. Expected exactly: ${EXPECTED_HEADER}`,
    );
  }
  return lines
    .map((line, index) => ({ line: line.trim(), rowNumber: index + 1 }))
    .slice(1)
    .filter(({ line }) => line.length > 0)
    .map(({ line, rowNumber }) => {
      // notes may contain commas: split only the first three fields.
      const [memberId, durationStr, dateStr, ...notesParts] = line
        .split(',')
        .map((part) => part.trim());
      const notes = notesParts.join(',').trim();
      const durationDays = Number(durationStr);
      if (!memberId || !Number.isInteger(durationDays) || durationDays <= 0) {
        throw new Error(
          `Row ${rowNumber}: invalid member_id or duration_days in "${line}"`,
        );
      }
      if (!DATE_FORMAT.test(dateStr)) {
        throw new Error(
          `Row ${rowNumber}: suspended_at must be YYYY-MM-DD in "${line}"`,
        );
      }
      return {
        memberId,
        memberName: null,
        durationDays,
        suspendedAt: new Date(`${dateStr}T00:00:00Z`),
        notes: notes.length > 0 ? notes : null,
      };
    });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `yarn test tst/lib/helpers/suspensionCsv.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/helpers/suspensionCsv.ts tst/lib/helpers/suspensionCsv.test.ts
git commit -m "Add suspension CSV parser for recording and backfill"
```

---

### Task 7: `/meetup_record_suspension` command

**Files:**
- Create: `src/commands/meetup/recordSuspension.ts`
- Modify: `src/commands/index.ts` (register `MeetupRecordSuspensionCommands`)

**Interfaces:**
- Consumes: `PostgresSuspensionRepository.instance()`, `recommendedSuspensionDays` (Task 4), `parseSuspensionCsv` (Task 6), `discordCommandWrapper`, `keepReplyVisible`, `requireModOrOrganizer` from `src/util/discord.js`.
- Produces: slash command `meetup_record_suspension` with options `members` (string, optional: comma-separated Meetup member IDs), `date` (string, optional `YYYY-MM-DD`, default today), `csv` (attachment, optional). Exactly one of `members` / `csv` must be provided.

- [ ] **Step 1: Write the command**

> **Amendment (2026-09-26):** bulk mode (`members`/`date` options,
> `recordBulk`) was removed; the command takes only the `csv` attachment
> (required). Rows are recorded as written, including IDs that aren't current
> group members (flagged), and durations that don't match 30 × 2^(prior) are
> flagged, not rejected. See `src/lib/helpers/recordSuspensions.ts`.

```typescript
// src/commands/meetup/recordSuspension.ts
import dayjs from 'dayjs';
import {
  ApplicationCommandOptionType,
  Attachment,
  CommandInteraction,
} from 'discord.js';
import { Discord, Slash, SlashOption } from 'discordx';
import { Logger } from 'tslog';

import { recommendedSuspensionDays } from '../../lib/helpers/noShowReport.js';
import { parseSuspensionCsv } from '../../lib/helpers/suspensionCsv.js';
import { PostgresSuspensionRepository } from '../../lib/repositories/postgresSuspensionRepository.js';
import {
  discordCommandWrapper,
  keepReplyVisible,
  requireModOrOrganizer,
} from '../../util/discord.js';

const logger = new Logger({ name: 'MeetupRecordSuspensionCommands' });

const DATE_FORMAT = /^\d{4}-\d{2}-\d{2}$/;

@Discord()
export class MeetupRecordSuspensionCommands {
  @Slash({
    name: 'meetup_record_suspension',
    description:
      'Record no-show suspensions. Pass member IDs (auto duration) OR a CSV. Output is private.',
  })
  async recordSuspensionHandler(
    @SlashOption({
      name: 'members',
      description:
        'Comma-separated Meetup member IDs. Duration auto-computed: 30 days × 2^(prior suspensions).',
      type: ApplicationCommandOptionType.String,
      required: false,
    })
    members: string | undefined,
    @SlashOption({
      name: 'date',
      description: 'Suspension date as YYYY-MM-DD. Default: today.',
      type: ApplicationCommandOptionType.String,
      required: false,
    })
    date: string | undefined,
    @SlashOption({
      name: 'csv',
      description:
        'CSV with header member_id,duration_days,suspended_at,notes — for exceptions and backfill.',
      type: ApplicationCommandOptionType.Attachment,
      required: false,
    })
    csv: Attachment | undefined,
    interaction: CommandInteraction,
  ) {
    await discordCommandWrapper(interaction, async () => {
      await requireModOrOrganizer(
        interaction,
        'Only moderators and organizers can record suspensions.',
      );
      if ((members === undefined) === (csv === undefined)) {
        throw new Error('Provide exactly one of `members` or `csv`.');
      }
      if (date !== undefined && !DATE_FORMAT.test(date)) {
        throw new Error('`date` must be YYYY-MM-DD.');
      }
      const repo = await PostgresSuspensionRepository.instance();

      let summaryLines: string[];
      if (csv !== undefined) {
        const response = await fetch(csv.url);
        if (!response.ok) {
          throw new Error(`Could not download attachment: ${response.status}`);
        }
        const rows = parseSuspensionCsv(await response.text());
        if (rows.length === 0) {
          throw new Error('The CSV contained no data rows.');
        }
        const inserted = await repo.insertMany(rows);
        summaryLines = inserted.map(
          (row) =>
            `- ${row.memberId}: ${row.durationDays} days from ${dayjs(
              row.suspendedAt,
            ).format('YYYY-MM-DD')}${row.notes ? ` (${row.notes})` : ''}`,
        );
      } else {
        const memberIds = members
          .split(',')
          .map((id) => id.trim())
          .filter((id) => id.length > 0);
        if (memberIds.length === 0) {
          throw new Error('`members` contained no member IDs.');
        }
        const suspendedAt = new Date(
          `${date ?? dayjs().format('YYYY-MM-DD')}T00:00:00Z`,
        );
        summaryLines = [];
        // Sequential on purpose: each member's duration depends on their
        // prior count, and a moderator may list the same member twice.
        for (const memberId of memberIds) {
          // eslint-disable-next-line no-await-in-loop
          const priorCount = await repo.countSuspensionsBefore(memberId, suspendedAt);
          const durationDays = recommendedSuspensionDays(priorCount);
          // eslint-disable-next-line no-await-in-loop
          await repo.insert({
            memberId,
            memberName: null,
            suspendedAt,
            durationDays,
            notes: null,
          });
          summaryLines.push(
            `- ${memberId}: prior suspensions ${priorCount} → **${durationDays} days**`,
          );
        }
      }

      logger.info(
        `Recorded ${summaryLines.length} suspension(s) via ${
          csv ? 'csv' : 'members'
        } mode`,
      );
      keepReplyVisible(interaction);
      await interaction.editReply({
        content: `Recorded ${summaryLines.length} suspension(s):\n${summaryLines.join(
          '\n',
        )}`,
      });
    });
  }
}
```

- [ ] **Step 2: Register the command**

In `src/commands/index.ts`, add the import and array entry (alphabetical-ish with the existing entries):

```typescript
import { MeetupRecordSuspensionCommands } from './meetup/recordSuspension.js';
```

and add `MeetupRecordSuspensionCommands,` to the `Commands` array.

- [ ] **Step 3: Lint and run the unit suite**

Run: `yarn lint && yarn test`
Expected: clean. (The command itself is exercised manually in Task 9; its logic lives in already-tested helpers and the repository.)

- [ ] **Step 4: Commit**

```bash
git add src/commands/meetup/recordSuspension.ts src/commands/index.ts
git commit -m "Add /meetup_record_suspension with bulk-ID and CSV modes"
```

---

### Task 8: `/meetup_run_noshow_report` command

> **Amended 2026-09-27 — read the spec's Policy section before implementing.**
> The snippets below predate two confirmed rules: the 12-month window is measured
> back from *today*, not from the report month, and only no-shows after the member's
> most recent suspension count. Without the reset, the no-shows behind a suspension
> stay in the window and suspend the member again, doubled, for the same no-shows.
> Prior suspensions use `countSuspensionsBefore(memberId, date)`.
>
> **Amended 2026-09-28 — as built.** The trailing-12-month event scan and the
> 90-day upcoming-event scan below were replaced with per-member RSVP queries
> (`GqlMeetupClient.getMemberRsvpEvents`), after a live check showed they return
> other members' NO_SHOW and upcoming YES RSVPs. The counting rules live in the
> pure `countableNoShows` / `buildNoShowCases` helpers; the prior count and last
> suspension day come from `listByMemberId`. The suggested CSV quotes every field
> and leaves `suspended_at` blank. See the spec's Phase 3 section.

**Files:**
- Create: `src/commands/meetup/noShowReport.ts`
- Modify: `src/commands/meetup/getEventStats.ts` — export `getEventsYearMonth` (add `export` keyword; no behavior change)
- Modify: `src/commands/index.ts` (register `MeetupNoShowReportCommands`)

**Interfaces:**
- Consumes: `getEventsYearMonth` (exported from `getEventStats.ts`), `getPaginatedData`, `meetupClient.getGroupEvents` / `getEventRsvps`, helpers from Task 4, `PostgresSuspensionRepository`, `withDiscordFileAttachment`, `requireModOrOrganizer`, `tz`, `dayjs`.
- Produces: slash command `meetup_run_noshow_report` with required `year` and `month` (1–12; whole-year mode is intentionally not offered — the policy window is monthly).

- [ ] **Step 1: Export `getEventsYearMonth`**

In `src/commands/meetup/getEventStats.ts` change `async function getEventsYearMonth(` to `export async function getEventsYearMonth(`.

- [ ] **Step 2: Write the command**

```typescript
// src/commands/meetup/noShowReport.ts
import dayjs from 'dayjs';
import { ApplicationCommandOptionType, CommandInteraction } from 'discord.js';
import { Discord, Slash, SlashOption } from 'discordx';
import { Logger } from 'tslog';

import { GqlMeetupClient } from '../../lib/client/meetup/gqlClient.js';
import { getPaginatedData } from '../../lib/client/meetup/paginationHelper.js';
import { Event } from '../../lib/client/meetup/types.js';
import {
  NoShowCase,
  actByDate,
  classifyNoShowCount,
  formatNoShowReport,
  recommendedSuspensionDays,
  tallyNoShows,
} from '../../lib/helpers/noShowReport.js';
import { PostgresSuspensionRepository } from '../../lib/repositories/postgresSuspensionRepository.js';
import {
  discordCommandWrapper,
  requireModOrOrganizer,
  withDiscordFileAttachment,
} from '../../util/discord.js';
import { withMeetupClient } from '../../util/meetup.js';
import { tz } from '../../util/timezone.js';
import { getEventsYearMonth } from './getEventStats.js';

const logger = new Logger({ name: 'MeetupNoShowReportCommands' });

/** NO_SHOW rsvps per event, fetched in parallel (existing pattern). */
async function getNoShowsPerEvent(meetupClient: GqlMeetupClient, events: Event[]) {
  return Promise.all(
    events.map(async (event) => {
      const rsvps = await getPaginatedData(async (paginationInput) => {
        const result = await meetupClient.getEventRsvps(
          event.id,
          paginationInput,
          { rsvpStatus: ['NO_SHOW'] },
        );
        return result.event.rsvps;
      });
      return { event, rsvps };
    }),
  );
}

@Discord()
export class MeetupNoShowReportCommands {
  @Slash({
    name: 'meetup_run_noshow_report',
    description:
      'Monthly no-show report: 12-month counts, warning/suspension recs, act-by dates. Output is private.',
  })
  async runNoShowReportHandler(
    @SlashOption({
      name: 'year',
      description: 'The report year',
      type: ApplicationCommandOptionType.Number,
      required: true,
    })
    year: number,
    @SlashOption({
      name: 'month',
      description: 'The report month (1-12)',
      type: ApplicationCommandOptionType.Number,
      minValue: 1,
      maxValue: 12,
      required: true,
    })
    month: number,
    interaction: CommandInteraction,
  ) {
    await discordCommandWrapper(interaction, async () => {
      await requireModOrOrganizer(
        interaction,
        'Only moderators and organizers can run the no-show report.',
      );
      await withMeetupClient(interaction, async (meetupClient) => {
        logger.info(`Running no-show report for ${year}-${month}`);
        await interaction.editReply({
          content: 'Sit tight! Crunching 12 months of attendance.',
        });

        // 1. This month's no-shows.
        const monthEvents = await getEventsYearMonth(meetupClient, year, month);
        const monthTally = tallyNoShows(
          await getNoShowsPerEvent(meetupClient, monthEvents),
        );
        if (monthTally.size === 0) {
          await interaction.followUp({
            content: `No no-shows recorded for ${year}-${month}. 🎉`,
            ephemeral: true,
          });
          return;
        }

        // 2. Trailing 12-month tally (window ends at the report month's end).
        const monthEnd = tz(dayjs())
          .set('year', year)
          .set('month', month - 1)
          .endOf('month');
        const windowStart = monthEnd.subtract(12, 'month');
        const windowEvents = await getPaginatedData(
          async (paginationInput) => {
            const result = await meetupClient.getGroupEvents(paginationInput, {
              status: ['PAST'],
              afterDateTime: windowStart.toISOString(),
              beforeDateTime: monthEnd.toISOString(),
            });
            return result.groupByUrlname.events;
          },
        );
        const windowTally = tallyNoShows(
          await getNoShowsPerEvent(meetupClient, windowEvents),
        );

        // 3. Upcoming YES rsvps, fetched once, mapped member -> next event.
        const upcomingEvents = await getPaginatedData(
          async (paginationInput) => {
            const result = await meetupClient.getGroupEvents(paginationInput, {
              status: ['ACTIVE', 'AUTOSCHED'],
              afterDateTime: dayjs().toISOString(),
            });
            return result.groupByUrlname.events;
          },
        );
        const sortedUpcoming = [...upcomingEvents].sort((a, b) =>
          a.dateTime.localeCompare(b.dateTime),
        );
        const nextEventByMember = new Map<string, Event>();
        const upcomingRsvps = await Promise.all(
          sortedUpcoming.map(async (event) => {
            const rsvps = await getPaginatedData(async (paginationInput) => {
              const result = await meetupClient.getEventRsvps(
                event.id,
                paginationInput,
                { rsvpStatus: ['YES'] },
              );
              return result.event.rsvps;
            });
            return { event, rsvps };
          }),
        );
        for (const { event, rsvps } of upcomingRsvps) {
          for (const { member } of rsvps) {
            if (!nextEventByMember.has(member.id)) {
              nextEventByMember.set(member.id, event);
            }
          }
        }

        // 4. Build cases.
        const repo = await PostgresSuspensionRepository.instance();
        const now = dayjs();
        const cases: NoShowCase[] = [];
        for (const [memberId, monthEntry] of monthTally) {
          const twelveMonthCount =
            windowTally.get(memberId)?.events.length ??
            monthEntry.events.length;
          const classification = classifyNoShowCount(twelveMonthCount);
          const noShowCase: NoShowCase = {
            member: monthEntry.member,
            monthEvents: monthEntry.events,
            twelveMonthCount,
            classification,
          };
          if (classification === 'suspension') {
            // eslint-disable-next-line no-await-in-loop
            const priorSuspensions = await repo.countSuspensionsBefore(memberId, today);
            noShowCase.priorSuspensions = priorSuspensions;
            noShowCase.recommendedDays =
              recommendedSuspensionDays(priorSuspensions);
            const nextEvent = nextEventByMember.get(memberId);
            if (nextEvent) {
              const { actBy, actNow } = actByDate(nextEvent.dateTime, now);
              noShowCase.nextRsvpEvent = nextEvent;
              noShowCase.actBy = tz(actBy).format('LLL');
              noShowCase.actNow = actNow;
            }
          }
          cases.push(noShowCase);
        }

        const periodLabel = `${year} ${dayjs()
          .month(month - 1)
          .format('MMMM')}`;
        const report = formatNoShowReport(periodLabel, cases);
        await withDiscordFileAttachment(
          `No Show report ${year}-${month}.txt`,
          report,
          async (attachmentArgs) => {
            await interaction.followUp({
              ...attachmentArgs,
              content:
                'Report ready — hand this to Melissa. She sends warnings and applies suspensions; record outcomes with /meetup_record_suspension.',
              ephemeral: true,
            });
          },
        );
      });
    });
  }
}
```

- [ ] **Step 3: Register the command**

In `src/commands/index.ts`:

```typescript
import { MeetupNoShowReportCommands } from './meetup/noShowReport.js';
```

and add `MeetupNoShowReportCommands,` to the `Commands` array.

- [ ] **Step 4: Lint and run the unit suite**

Run: `yarn lint && yarn test`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add src/commands/meetup/noShowReport.ts src/commands/meetup/getEventStats.ts src/commands/index.ts
git commit -m "Add /meetup_run_noshow_report with 12-month classification and penalties"
```

---

### Task 9: Final verification and runbook

**Files:**
- Modify: `README.md` — only if it documents commands (check first; follow its existing style if adding).

- [ ] **Step 1: Full check**

Run: `yarn lint && yarn test && yarn test:integration:docker`
Expected: all pass.

> `yarn test:integration:docker` uses the same Docker Postgres and Redis as `yarn dev`, and the suspension tests clear `suspension_records`. Run it before step 2's manual testing, or re-create any test records you still need afterwards.

- [ ] **Step 2: Manual validation checklist (requires dev credentials — coordinate with the human partner)**

1. `yarn dev`, then in the test server run `/meetup_get_host_event_stats` for last month. Compare the READY TO POST block against the moderator's last hand-built Hall of Fame: totals match their corrected numbers, renamed-cancelled events absent, recurring events collapsed, new hosts flagged.
2. Run `/meetup_run_noshow_report` for last month. Compare classifications against the moderator's last report.
3. **Test recording against a dev database only** (`yarn dev` with the Docker stack), never production. Records are voided, never deleted, so a production test row stays in the audit trail even after `/meetup_void_suspension`. Upload a one-row CSV for a test ID with 30 days and verify it records with no duration flag; upload a second row for the same ID with a later date and 30 days and verify it's flagged "60 expected". Re-upload the first file and verify it's reported as already on file.
   Once this branch's schema has run against the dev database, don't switch that database back to a branch from before voiding existed: the older code expects the old full unique index and fails to insert (and, once a voided row and its replacement coexist, fails to recreate that index). To go back, run `DROP TABLE suspension_records;` against the dev database; the bot recreates it on next use. (`yarn docker:down` keeps the data volume, so it doesn't reset anything.) Production is unaffected: part 3 was never deployed before this change.
4. **Correcting a record.** `/meetup_list_suspensions` prints each record's `#ID`. Run `/meetup_void_suspension id:<ID> reason:<why>`: the reply echoes the member, date, and duration, and the staff moderation channel gets an entry. Verify the record is gone from the list and no longer counts toward the member's next penalty, then re-upload the corrected row (the same date is allowed once the old one is void). A re-uploaded row whose duration differs from what's on file is skipped as already on file, and the summary names the record: "void #ID and re-import to correct". A row that repeats an earlier row of the same file (same member and date) is skipped too, and the summary names that row and the record it created instead.
   **Voided the wrong record by mistake?** There's no un-void. Re-record it: upload a one-row CSV with the voided record's member, date, and duration, which the reply to `/meetup_void_suspension` echoes. The same date is allowed because the voided row no longer counts. The voided row stays in the table as the audit trail of the mistake.
   **Where it's logged:** `/meetup_run_noshow_report`, `/meetup_record_suspension`, `/meetup_list_suspensions`, and `/meetup_void_suspension` log to the staff moderation channel (`MODERATION_LOG_CHANNEL_ID`), not the general bot activity log: void reasons, member IDs, and names stay with staff. Failures still go to the bot alerts channel. Verify one entry per run lands there.
5. **Backfill production before recording any live suspension.** Until the sheet's history is imported, every repeat offender's suggested duration assumes no prior suspensions. Export the real suspension sheet as CSV with header `member_id,member_name,duration_days,suspended_at,notes` (or the legacy header without `member_name`) and upload it via the `csv` option. Review the summary: "not a current member" rows are recorded (departed members' history is kept) but check none is a typo; "duration to check" rows are expected wherever past practice didn't follow the doubling rule.

- [ ] **Step 3: Commit any doc updates and hand off**

Use the superpowers:finishing-a-development-branch skill to merge/PR.

---

## Self-Review Notes

- Spec coverage: Phase 1 → Tasks 1–3; Phase 2 → Task 3 (`findNewHostIds`) with the spec's fallback embedded in Task 3 Step 3; Phase 3 → Tasks 4–8; error handling → wrapper + explicit validation in Tasks 7–8; testing section → each task's test steps plus Task 9.
- The spec's "act now" edge case is covered by `actByDate` + `formatNoShowReport` tests (Task 4).
- Type consistency verified: `SuspensionInsert` (Tasks 5–7), `NoShowCase` (Tasks 4, 8), `HostStats` (Tasks 1–3) match across tasks.
