import nock from 'nock';
import { afterEach, describe, expect, it } from 'vitest';

import { fetchChangeThumbs } from '../../../src/lib/helpers/identityThumbs.js';

afterEach(() => nock.cleanAll());

describe('fetchChangeThumbs', () => {
  it('fetches both sides of an avatar change at 64px', async () => {
    const scope = nock('https://cdn.discordapp.com')
      .get('/avatars/u1/aaa.webp')
      .query({ size: '64' })
      .reply(200, Buffer.from([1, 2]))
      .get('/avatars/u1/bbb.webp')
      .query({ size: '64' })
      .reply(200, Buffer.from([3, 4]));

    const thumbs = await fetchChangeThumbs(
      [
        {
          discordUserId: 'u1',
          field: 'user_avatar',
          oldValue: 'aaa',
          newValue: 'bbb',
        },
      ],
      'g1',
    );

    const entry = thumbs.get('u1:user_avatar');
    expect(entry?.oldThumb?.equals(Buffer.from([1, 2]))).toBe(true);
    expect(entry?.newThumb?.equals(Buffer.from([3, 4]))).toBe(true);
    expect(scope.isDone()).toBe(true);
  });

  it('records null rather than throwing when the CDN 404s', async () => {
    nock('https://cdn.discordapp.com')
      .get('/avatars/u1/gone.webp')
      .query({ size: '64' })
      .reply(404);

    const thumbs = await fetchChangeThumbs(
      [
        {
          discordUserId: 'u1',
          field: 'user_avatar',
          oldValue: 'gone',
          newValue: null,
        },
      ],
      'g1',
    );

    // Evidence that the change happened matters more than the picture.
    expect(thumbs.get('u1:user_avatar')?.oldThumb).toBeNull();
  });

  it('does not fetch anything for non-avatar fields', async () => {
    const thumbs = await fetchChangeThumbs(
      [
        {
          discordUserId: 'u1',
          field: 'nickname',
          oldValue: 'A',
          newValue: 'B',
        },
      ],
      'g1',
    );

    // A nickname has no image; hitting the CDN for one wastes a request.
    expect(thumbs.size).toBe(0);
  });
});
