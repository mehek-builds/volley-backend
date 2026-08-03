import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import cors from '@fastify/cors';
import Fastify from 'fastify';
import { openSseResponse, trackSseConnection } from './sseResponse';

test('a raw SSE response preserves CORS headers installed by Fastify', async () => {
  const app = Fastify();
  await app.register(cors, { origin: true, credentials: true });
  app.post('/stream', async (_request, reply) => {
    openSseResponse(reply);
    reply.raw.end('data: {"event":"done"}\n\n');
  });

  try {
    const response = await app.inject({
      method: 'POST',
      url: '/stream',
      headers: { origin: 'https://trylitos.com' },
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers['access-control-allow-origin'], 'https://trylitos.com');
    assert.equal(response.headers['access-control-allow-credentials'], 'true');
    assert.equal(response.headers['content-type'], 'text/event-stream');
    assert.match(response.payload, /"event":"done"/);
  } finally {
    await app.close();
  }
});

test('normal request completion is not mistaken for an SSE disconnect', () => {
  const requestRaw = new EventEmitter();
  const replyRaw = Object.assign(new EventEmitter(), { writableEnded: false });
  const state = trackSseConnection(
    { raw: requestRaw } as unknown as Parameters<typeof trackSseConnection>[0],
    { raw: replyRaw } as unknown as Parameters<typeof trackSseConnection>[1],
  );

  requestRaw.emit('close');
  assert.equal(state.closed, false);

  requestRaw.emit('aborted');
  assert.equal(state.closed, true);
});

test('a response transport closing before end marks the stream disconnected', () => {
  const requestRaw = new EventEmitter();
  const replyRaw = Object.assign(new EventEmitter(), { writableEnded: false });
  const state = trackSseConnection(
    { raw: requestRaw } as unknown as Parameters<typeof trackSseConnection>[0],
    { raw: replyRaw } as unknown as Parameters<typeof trackSseConnection>[1],
  );

  replyRaw.emit('close');
  assert.equal(state.closed, true);
});

test('a normal response close after end is not marked as cancellation', () => {
  const requestRaw = new EventEmitter();
  const replyRaw = Object.assign(new EventEmitter(), { writableEnded: true });
  const state = trackSseConnection(
    { raw: requestRaw } as unknown as Parameters<typeof trackSseConnection>[0],
    { raw: replyRaw } as unknown as Parameters<typeof trackSseConnection>[1],
  );

  replyRaw.emit('close');
  assert.equal(state.closed, false);
});
