import type { IncomingMessage, ServerResponse } from 'http';
import type { EventEmitter } from 'events';

/**
 * Hand a request to a Node HTTP server and RESOLVE ONLY WHEN THE RESPONSE IS DONE.
 *
 * `emit('request')` is synchronous and returns as soon as the server has ACCEPTED the request, not
 * when it has answered it. api/index.ts used to return right there, so the promise Vercel awaits
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
 *
 * WHY THIS LIVES IN src/ AND NOT NEXT TO ITS CALLER. Vercel builds EVERY file under `api/` into its
 * own serverless function. A first draft of this change put the logic and its test in `api/`, and
 * `vercel build` then emitted `.vercel/output/functions/api/index.test.func` - the test file
 * shipped to production as a publicly routable endpoint that would execute the test runner on
 * invocation. Anything in `api/` that is not a request handler is a deployed endpoint by accident,
 * so `api/index.ts` stays four lines of glue and everything testable lives here.
 *
 * THE RESIDUAL, stated rather than hidden: a route that never answers and whose client never
 * disconnects now holds the invocation open to vercel.json's 300s maxDuration instead of returning
 * immediately with a broken response. That is the correct trade - the old behaviour was not
 * "fails fast", it was "returns a 500 for a response that was about to succeed" - but it does mean
 * a hung route is billed for the full duration. There is no such route today; if one appears, the
 * fix is a timeout here, not a return to fire-and-forget.
 */
export function respondWhenFinished(
  server: EventEmitter,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    res.once('finish', resolve);
    res.once('close', resolve);
    // `emit` returns false when nothing is listening, and with nothing listening neither `finish`
    // nor `close` will ever fire, so the promise would stay pending until vercel.json's 300s
    // maxDuration - billing five minutes per request to answer nobody. Fastify always registers a
    // handler once `ready()` resolves, so this should be unreachable; it is here because the cost
    // of being wrong is a silent five-minute hang rather than an error anyone would see.
    if (!server.emit('request', req, res)) {
      reject(new Error('serverless handler: the Fastify server has no request listener'));
    }
  });
}
