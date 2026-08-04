import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { respondWhenFinished } from './serverlessRespond';

/**
 * The serverless handler must not resolve before the response is finished.
 *
 * WHAT THIS IS TESTING AND WHAT IT IS NOT. It does not boot Fastify or connect to Postgres: that
 * would need a database and would still not reproduce the bug, which is a race between the platform
 * freezing a container and a socket write. What it pins is the one property the fix is made of -
 * the promise the platform awaits settles on the RESPONSE, not on `emit` returning - by driving the
 * REAL function with a fake server and a fake response.
 *
 * An earlier draft hand-copied the function into the test and checked the shipped one with a
 * source-text regex. That tests a copy, so the two could drift and both stay green. Importing it is
 * possible at all because the function lives in src/ rather than in api/, where Vercel would have
 * built it into its own deployed endpoint.
 *
 * The bug it stands for was observed in production on 2026-08-04 (deploy of d880d74): one request
 * in 1520 returned Vercel's "A server error has occurred" 500 while the app logged
 * `{"res":{"statusCode":200},"responseTime":1479.09}` for the same reqId. Nothing reached the error
 * groups, because from the application's side nothing went wrong.
 */

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

/** A ServerResponse only insofar as respondWhenFinished uses it: `once('finish'|'close')`. */
function fakeResponse(): ServerResponse & EventEmitter {
  return new EventEmitter() as unknown as ServerResponse & EventEmitter;
}

describe('the serverless handler waits for the response', () => {
  test('emit returning is NOT enough to settle it', async () => {
    const server = new EventEmitter();
    const res = fakeResponse();
    // A handler that accepts the request and answers later, which is every route that touches the
    // database. `emit` returns synchronously here, exactly as it does in production.
    server.on('request', () => setTimeout(() => res.emit('finish'), 20));

    const done = respondWhenFinished(server, {} as IncomingMessage, res);
    assert.equal(await isSettled(done), false, 'settling here is the bug: the response is still open');
    await done;
    assert.equal(await isSettled(done), true);
  });

  test('a client that aborts mid-response settles it too, rather than hanging to the 300s timeout', async () => {
    const server = new EventEmitter();
    const res = fakeResponse();
    // `finish` never fires on an aborted response. Listening for `close` as well is what keeps this
    // from pinning the invocation open until vercel.json's maxDuration.
    server.on('request', () => setTimeout(() => res.emit('close'), 10));
    await respondWhenFinished(server, {} as IncomingMessage, res);
  });

  test('finish then close settles once and does not throw on the second event', async () => {
    const server = new EventEmitter();
    const res = fakeResponse();
    server.on('request', () => {
      res.emit('finish');
      res.emit('close');
    });
    await respondWhenFinished(server, {} as IncomingMessage, res);
  });

  test('a route that answers synchronously is not missed', async () => {
    // Listeners are attached before `emit` for this case: a synchronous `finish` would otherwise
    // fire into an empty emitter and the promise would never settle.
    const server = new EventEmitter();
    const res = fakeResponse();
    server.on('request', () => res.emit('finish'));
    await respondWhenFinished(server, {} as IncomingMessage, res);
  });

  test('the request is handed to the server exactly once, with the objects it was given', async () => {
    const server = new EventEmitter();
    const res = fakeResponse();
    const req = {} as IncomingMessage;
    const seen: Array<[unknown, unknown]> = [];
    server.on('request', (r, s) => {
      seen.push([r, s]);
      res.emit('finish');
    });
    await respondWhenFinished(server, req, res);
    assert.equal(seen.length, 1);
    assert.equal(seen[0][0], req, 'Fastify must receive the platform req, not a copy');
    assert.equal(seen[0][1], res);
  });

  test('a server with no request listener rejects instead of hanging for 300s', async () => {
    // `emit` returns false with nothing listening, and neither 'finish' nor 'close' would ever
    // fire, so without the guard this promise stays pending to vercel.json's maxDuration.
    const server = new EventEmitter();
    await assert.rejects(
      respondWhenFinished(server, {} as IncomingMessage, fakeResponse()),
      /no request listener/,
    );
  });

  test('api/index.ts routes through this function rather than emitting directly', () => {
    // The entrypoint cannot be imported here - it builds the whole app and opens a pool - and it is
    // four lines of glue, so this pins the one line that matters: the fix is not bypassed.
    const src = readFileSync(join(__dirname, '..', '..', 'api', 'index.ts'), 'utf8');
    assert.match(src, /await respondWhenFinished\(app\.server, req, res\)/);
    assert.doesNotMatch(src, /app\.server\.emit\(/, 'emitting directly is the bug this replaced');
  });
});
