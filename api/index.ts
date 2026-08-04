import 'dotenv/config';
import type { IncomingMessage, ServerResponse } from 'http';
import { buildApp } from '../src/index';

// Vercel serverless entry. The Fastify app is built once per warm container and reused;
// each request is handed to Fastify's underlying HTTP server via `emit('request')`.
// vercel.json rewrites every path to this function, and req.url keeps the original path,
// so Fastify routes (/health, /resolve, /draft, ...) resolve normally.
type FastifyApp = Awaited<ReturnType<typeof buildApp>>;

let appPromise: Promise<FastifyApp> | null = null;
function getApp(): Promise<FastifyApp> {
  if (!appPromise) appPromise = buildApp();
  return appPromise;
}

/**
 * Hand the request to Fastify and RESOLVE ONLY WHEN THE RESPONSE IS DONE.
 *
 * `emit('request')` is synchronous and returns as soon as Fastify has ACCEPTED the request, not
 * when it has answered it. The handler used to return right there, so the promise Vercel awaits
 * settled while the response was still being written. The platform is entitled to freeze or tear
 * down the container once that promise resolves, and when it did the caller got Vercel's own
 * "A server error has occurred" page with a 500, while the app had already logged a 200.
 *
 * OBSERVED IN PRODUCTION 2026-08-04, on the deploy of d880d74:
 *
 *   GET /jobs/eb6f80b6-... -> platform 500, cache=MISS
 *   {"reqId":"req-8","res":{"statusCode":200},"responseTime":1479.09,"msg":"request completed"}
 *
 * One request in 1520 on that deployment, and the two records disagree because they are measuring
 * different things: Fastify finished, the invocation did not. That shape - app logs 200, client
 * gets 500 - is the signature of this bug and not of an application error, which is why nothing
 * showed up in the error groups.
 *
 * WHY THE SLOW ONES, and why this is rare rather than constant. `responseTime` 1479ms is a cold
 * pool opening its first connection. On a fast request the write completes within the same tick
 * the platform is still finishing its own bookkeeping, so the race is invisible. It opens as
 * response latency grows, which means it hits the requests a student is already waiting on.
 *
 * `close` AND `finish`, and `once` for both. `finish` fires when the last byte is handed to the
 * socket; `close` fires when the connection is done, including when a client aborts mid-response,
 * where `finish` never fires at all and this would otherwise hang until the 300s timeout. Whichever
 * lands first settles the promise and the other is a no-op, because a settled promise ignores
 * later calls. Listeners are attached BEFORE `emit` so a handler that answers synchronously cannot
 * finish before anything is listening.
 */
function respond(app: FastifyApp, req: IncomingMessage, res: ServerResponse): Promise<void> {
  return new Promise<void>((resolve) => {
    res.once('finish', resolve);
    res.once('close', resolve);
    app.server.emit('request', req, res);
  });
}

export default async function handler(req: IncomingMessage, res: ServerResponse) {
  const app = await getApp();
  await app.ready();
  await respond(app, req, res);
}
