import type express from 'express';
import http from 'http';
import request from 'supertest';

/**
 * The only file under tst/ that imports supertest. `request(app)` binds the
 * dual-stack wildcard on an ephemeral port; a local process already holding
 * that port on 127.0.0.1 (seen: a Go TLS listener) then answers some of the
 * requests ("HTTP request to an HTTPS server"). Binding 127.0.0.1 explicitly
 * means the OS never hands out a port someone else holds there.
 */

/** What request(server) returns: each .get()/.post() is a fresh request with no cookie jar. */
export type LoopbackClient = ReturnType<typeof request>;
export type LoopbackResponse = request.Response;
export const LOOPBACK_HOST = '127.0.0.1';

const servers = new Set<http.Server>();

/** Listens on an ephemeral 127.0.0.1 port; closed by closeServers(). */
export async function listen(
  app: express.Express | http.RequestListener,
): Promise<http.Server> {
  const server = http.createServer(app);
  servers.add(server);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, LOOPBACK_HOST, () => resolve());
  });
  return server;
}

/** A supertest client for an already listening server. */
export function clientFor(server: http.Server): LoopbackClient {
  return request(server);
}

/** Serves `app` on one loopback server and returns a client for it. */
export async function serve(
  app: express.Express | http.RequestListener,
): Promise<LoopbackClient> {
  return clientFor(await listen(app));
}

/** For afterEach/afterAll: closes every server listen()/serve() opened. */
export async function closeServers(): Promise<void> {
  const open = [...servers];
  servers.clear();
  await Promise.all(
    open.map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    ),
  );
}
