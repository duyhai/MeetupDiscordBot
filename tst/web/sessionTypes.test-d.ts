import { expectTypeOf, test } from 'vitest';

import { KeyValueCache } from '../../src/lib/cache/base.js';
import { HostSession } from '../../src/web/host/hostSession.js';
import {
  DASHBOARD_SESSION_OPTIONS,
  SessionStore,
} from '../../src/web/session.js';

declare const cache: KeyValueCache;

test('a non-staff session store must name its options', () => {
  expectTypeOf(new SessionStore(cache)).toEqualTypeOf<SessionStore>();
  // @ts-expect-error -- a host store cannot fall back to the staff options
  new SessionStore<HostSession>(cache);
  // @ts-expect-error -- nor take the staff options explicitly
  new SessionStore<HostSession>(cache, Date.now, DASHBOARD_SESSION_OPTIONS);
});
