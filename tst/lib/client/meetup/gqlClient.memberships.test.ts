import nock from 'nock';
import { afterEach, describe, expect, it } from 'vitest';

import Configuration from '../../../../src/configuration.js';
import { GqlMeetupClient } from '../../../../src/lib/client/meetup/gqlClient.js';

const ENDPOINT = new URL(Configuration.meetup.endpoint);

afterEach(() => {
  nock.cleanAll();
});

type Edge = {
  metadata: { status: string; joinTime: string } | null;
  node: { id: string };
};

/** Answers each request with the edges for the ids it asked for. */
function meetupAnswers(edgesFor: (memberIds: number[]) => Edge[] | 'absent'): {
  requests: number[][];
} {
  const requests: number[][] = [];
  nock(ENDPOINT.origin)
    .post(ENDPOINT.pathname)
    .times(10)
    .reply(200, (_uri, body: { variables: { memberIds: number[] } }) => {
      requests.push(body.variables.memberIds);
      const edges = edgesFor(body.variables.memberIds);
      return edges === 'absent'
        ? { data: { groupByUrlname: null } }
        : { data: { groupByUrlname: { id: 'g', memberships: { edges } } } };
    });
  return { requests };
}

describe('GqlMeetupClient.getGroupMembershipsByIds', () => {
  it('pages 100 ids at a time and keys the answers by member id', async () => {
    const ids = Array.from({ length: 150 }, (_, i) => String(1000 + i));
    const { requests } = meetupAnswers((memberIds) =>
      memberIds.map((id) => ({
        metadata: { status: 'ACTIVE', joinTime: '2020-01-01T00:00:00Z' },
        node: { id: String(id) },
      })),
    );
    const got = await new GqlMeetupClient('t').getGroupMembershipsByIds(ids);
    expect(requests.map((r) => r.length)).toEqual([100, 50]);
    expect(got.size).toBe(150);
    expect(got.get('1149')).toEqual({
      status: 'ACTIVE',
      joinTime: '2020-01-01T00:00:00Z',
    });
  });

  it('a member not in the group is absent; an edge without metadata is skipped', async () => {
    meetupAnswers(() => [
      {
        metadata: { status: 'LEADER', joinTime: '2013-03-13T01:46:31-07:00' },
        node: { id: '1' },
      },
      { metadata: null, node: { id: '2' } },
    ]);
    const got = await new GqlMeetupClient('t').getGroupMembershipsByIds([
      '1',
      '2',
      '3',
    ]);
    expect([...got.keys()]).toEqual(['1']);
    expect(got.get('1')?.status).toBe('LEADER');
  });

  it('no memberships in the answer is a failure, not an empty group', async () => {
    meetupAnswers(() => 'absent');
    await expect(
      new GqlMeetupClient('t').getGroupMembershipsByIds(['1']),
    ).rejects.toThrow('no memberships');
  });

  it('nothing to ask: no request', async () => {
    const { requests } = meetupAnswers(() => []);
    const got = await new GqlMeetupClient('t').getGroupMembershipsByIds([]);
    expect(got.size).toBe(0);
    expect(requests).toEqual([]);
  });
});
