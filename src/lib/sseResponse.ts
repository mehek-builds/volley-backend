import type { FastifyReply, FastifyRequest } from 'fastify';

export interface SseConnectionState {
  closed: boolean;
}

/**
 * Open a manually streamed SSE response without discarding headers installed by Fastify hooks.
 * This matters for CORS: reply.raw.writeHead with only stream headers bypasses Fastify's header
 * store, so the browser sees a successful 200 without Access-Control-Allow-Origin and reports it as
 * a network-level "Failed to fetch" error.
 */
export function openSseResponse(reply: FastifyReply): void {
  reply.headers({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  const headers = reply.getHeaders();
  reply.hijack();
  for (const [name, value] of Object.entries(headers)) {
    if (value !== undefined) reply.raw.setHeader(name, value);
  }
  reply.raw.writeHead(200);
}

/**
 * Track actual transport cancellation. IncomingMessage "close" also fires after an ordinary
 * request body completes, so treating it as a disconnect can suppress every frame of a valid POST.
 */
export function trackSseConnection(request: FastifyRequest, reply: FastifyReply): SseConnectionState {
  const state: SseConnectionState = { closed: false };
  request.raw.on('aborted', () => {
    state.closed = true;
  });
  reply.raw.on('close', () => {
    if (!reply.raw.writableEnded) state.closed = true;
  });
  return state;
}
