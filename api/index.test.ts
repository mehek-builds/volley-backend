import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';

/**
 * The serverless handler must not resolve before the response is finished.
 *
 * WHAT THIS IS TESTING AND WHAT IT IS NOT. It does not boot Fastify, connect to Postgres, or call
 * the real default export: that would need a database and would still not reproduce the bug, which
 * is a race between the platform freezing a container and a socket write. What it pins is the one
 * property the fix is made of - the promise the platform awaits settles on the RESPONSE, not on
 * `emit` returning - by driving the same shape with a fake server and a fake response.
 *
 * The bug it stands for was observed in production on 2026-08-04 (deploy of d880d74): one request
 * in 1520 returned Vercel's "A server error has occurred" 500 while the app logged
 * `{"res":{"statusCode":200},"responseTime":1479.09}` for the same reqId. Nothing reached the error
 * groups, because from the application's side nothing went wrong.
 */

/** The `respond` shape from api/index.ts, kept in one place so the assertions below name it once. */
function respond(
  server: EventEmitter,
  req: IncomingMessage,
  res: ServerResponse & EventEmitter,
): Promise<void> {
  return new Promise<void>((resolve) => {
    res.once('finish', resolve);
    res.once('close', resolve);
    server.emit('request', req, res);
  });
}

/**
 * Has this promise settled yet?
 *
 * Deliberately NOT `Promise.race` against an already-resolved marker: both arms are queued as
 * microtasks and which one the race adopts depends on subscription order, so that version reported
 * a settled promise as pending. Setting a flag and then yielding a full macrotask tick is decided
 * by the event loop rather than by microtask ordering. `setImmediate` also does not let the 20ms
 * timer below fire, so a genuinely pending promise still reads as pending.
 */
async function isSettled(p: Promise<unknown>): Promise<boolean> {
  let settled = false;
  const seen = () => {
    settled = true;
  };
  p.then(seen, seen);
  await new Promise((resolve) => setImmediate(resolve));
  return settled;
}

describe('the serverless handler waits for the response', () => {
  test('emit returning is NOT enough to settle it', async () => {
    const server = new EventEmitter();
    const res = new EventEmitter() as ServerResponse & EventEmitter;
    // A handler that accepts the request and answers later, which is every route that touches the
    // database. `emit` returns synchronously here, exactly as it does in production.
    server.on('request', () => setTimeout(() => res.emit('finish'), 20));

    const done = respond(server, {} as IncomingMessage, res);
    assert.equal(await isSettled(done), false, 'settling here is the bug: the response is still open');
    await done;
    assert.equal(await isSettled(done), true);
  });

  test('a client that aborts mid-response settles it too, rather than hanging to the 300s timeout', async () => {
    const server = new EventEmitter();
    const res = new EventEmitter() as ServerResponse & EventEmitter;
    // `finish` never fires on an aborted response. Listening for `close` as well is what keeps this
    // from pinning the invocation open until vercel.json's maxDuration.
    server.on('request', () => setTimeout(() => res.emit('close'), 10));
    await respond(server, {} as IncomingMessage, res);
  });

  test('finish then close settles once and does not throw on the second event', async () => {
    const server = new EventEmitter();
    const res = new EventEmitter() as ServerResponse & EventEmitter;
    server.on('request', () => {
      res.emit('finish');
      res.emit('close');
    });
    await respond(server, {} as IncomingMessage, res);
  });

  test('a route that answers synchronously is not missed', async () => {
    // Listeners are attached before `emit` for this case: a synchronous `finish` would otherwise
    // fire into an empty emitter and the promise would never settle.
    const server = new EventEmitter();
    const res = new EventEmitter() as ServerResponse & EventEmitter;
    server.on('request', () => res.emit('finish'));
    await respond(server, {} as IncomingMessage, res);
  });

  test('the shipped handler uses this shape', () => {
    // Cheap guard against the fix being reverted or refactored away while these tests keep passing
    // against their own local copy of `respond`.
    const src = require('node:fs').readFileSync(require('node:path').join(__dirname, 'index.ts'), 'utf8');
    assert.match(src, /res\.once\('finish'/, 'the handler must await the response');
    assert.match(src, /res\.once\('close'/, 'and must not hang when the client aborts');
    assert.match(src, /await respond\(/, 'and must actually await it');
  });
});
