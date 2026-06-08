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

export default async function handler(req: IncomingMessage, res: ServerResponse) {
  const app = await getApp();
  await app.ready();
  app.server.emit('request', req, res);
}
