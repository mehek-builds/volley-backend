import 'dotenv/config';
import type { IncomingMessage, ServerResponse } from 'http';
import { buildApp } from '../src/index';
import { respondWhenFinished } from '../src/lib/serverlessRespond';

// Vercel serverless entry. The Fastify app is built once per warm container and reused;
// each request is handed to Fastify's underlying HTTP server via `emit('request')`.
// vercel.json rewrites every path to this function, and req.url keeps the original path,
// so Fastify routes (/health, /resolve, /draft, ...) resolve normally.
//
// KEEP THIS FILE GLUE ONLY. Vercel builds EVERY file under `api/` into its own serverless
// function, so a helper or a test placed here becomes a deployed, publicly routable endpoint.
// The response-completion logic and its tests live in src/lib/serverlessRespond.ts for exactly
// that reason; see the comment there.
type FastifyApp = Awaited<ReturnType<typeof buildApp>>;

let appPromise: Promise<FastifyApp> | null = null;
function getApp(): Promise<FastifyApp> {
  if (!appPromise) appPromise = buildApp();
  return appPromise;
}

export default async function handler(req: IncomingMessage, res: ServerResponse) {
  const app = await getApp();
  await app.ready();
  await respondWhenFinished(app.server, req, res);
}
