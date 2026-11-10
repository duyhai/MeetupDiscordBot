import { describe, expect, it, vi } from 'vitest';

import { countHostedEvents } from '../../../src/lib/helpers/countHostedEvents.js';

type Node = { id: string; title: string; status: string; dateTime: string };

/** A two-page listing of `nodes`, as getGroupEvents answers. */
function reader(nodes: Node[]) {
  const getGroupEvents = vi.fn(
    (pagination: { after?: string }, _filter: unknown) => {
      const page =
        pagination.after === 'p1' ? nodes.slice(1) : nodes.slice(0, 1);
      return Promise.resolve({
        groupByUrlname: {
          id: 'g',
          events: {
            pageInfo: {
              hasNextPage: pagination.after !== 'p1' && nodes.length > 1,
              endCursor: 'p1',
            },
            totalCount: nodes.length,
            edges: page.map((node) => ({ node })),
          },
        },
      });
    },
  );
  return { getGroupEvents, client: { getGroupEvents } as never };
}

const node = (id: string, title: string, status = 'PAST'): Node => ({
  id,
  title,
  status,
  dateTime: '2026-01-01T19:00:00-08:00',
});

describe('countHostedEvents', () => {
  it('lists the member’s PAST events across pages and counts only what counts', async () => {
    const { client, getGroupEvents } = reader([
      node('1', 'Hike'),
      node('2', '[Open House] Pickleball'),
      node('3', 'Trivia', 'CANCELLED'),
      node('4', 'Cancelled: Boba'),
      node('5', 'Board games'),
    ]);
    await expect(countHostedEvents(client, '4242')).resolves.toBe(2);
    expect(getGroupEvents).toHaveBeenCalledTimes(2);
    expect(getGroupEvents).toHaveBeenCalledWith(expect.anything(), {
      status: ['PAST'],
      hostId: '4242',
    });
  });

  it('passes `before` on as beforeDateTime', async () => {
    const { client, getGroupEvents } = reader([node('1', 'Hike')]);
    await expect(
      countHostedEvents(client, '4242', {
        before: new Date('2026-09-01T07:00:00Z'),
      }),
    ).resolves.toBe(1);
    expect(getGroupEvents).toHaveBeenCalledWith(expect.anything(), {
      status: ['PAST'],
      hostId: '4242',
      beforeDateTime: '2026-09-01T07:00:00.000Z',
    });
  });

  it('nothing hosted is zero', async () => {
    const { client } = reader([]);
    await expect(countHostedEvents(client, '4242')).resolves.toBe(0);
  });
});
