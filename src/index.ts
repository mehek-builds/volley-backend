import 'dotenv/config';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';

import { authRoutes } from './routes/auth';
import { profileRoutes } from './routes/profile';
import { resolveRoutes } from './routes/resolve';
import { draftRoutes } from './routes/draft';
import { trackRoutes } from './routes/track';
import { privacyRoutes } from './routes/privacy';
import { billingRoutes } from './routes/billing';
import { experienceBankRoutes } from './routes/experienceBank';
import { applicationProfileRoutes } from './routes/applicationProfile';
import { resumeRoutes } from './routes/resume';

export async function buildApp() {
  const fastify = Fastify({
    logger: {
      level: process.env.LOG_LEVEL || 'info',
      transport:
        process.env.NODE_ENV !== 'production'
          ? { target: 'pino-pretty', options: { colorize: true } }
          : undefined,
    },
  });

  // CORS - allow all origins in dev
  await fastify.register(cors, {
    origin: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    credentials: true,
  });

  // Multipart support for resume uploads
  await fastify.register(multipart, {
    limits: {
      fileSize: 10 * 1024 * 1024, // 10 MB max
      files: 1,
    },
  });

  // Health check
  fastify.get('/health', async (_request, reply) => {
    return reply.status(200).send({ status: 'ok', ts: new Date().toISOString() });
  });

  // Stable share link for the Chrome Web Store listing. The 32-char extension ID
  // is assigned by Google and immutable; this redirect is the one URL to share.
  fastify.get('/install', async (_request, reply) => {
    return reply.redirect('https://chromewebstore.google.com/detail/bdbedbmkjpfioknfpmhookefabipjaad', 302);
  });

  // Routes
  await fastify.register(authRoutes);
  await fastify.register(profileRoutes);
  await fastify.register(resolveRoutes);
  await fastify.register(draftRoutes);
  await fastify.register(trackRoutes);
  await fastify.register(privacyRoutes);
  await fastify.register(billingRoutes);
  await fastify.register(experienceBankRoutes);
  await fastify.register(applicationProfileRoutes);
  await fastify.register(resumeRoutes);

  // Global error handler
  fastify.setErrorHandler((error, _request, reply) => {
    fastify.log.error(error);
    const statusCode = error.statusCode ?? 500;
    return reply.status(statusCode).send({
      error: error.message || 'Internal server error',
    });
  });

  // 404 handler
  fastify.setNotFoundHandler((_request, reply) => {
    return reply.status(404).send({ error: 'Route not found' });
  });

  return fastify;
}

async function start() {
  const port = parseInt(process.env.PORT || '3001', 10);
  const host = process.env.HOST || '0.0.0.0';

  const app = await buildApp();

  try {
    await app.listen({ port, host });
    app.log.info(`Student outreach backend running on http://${host}:${port}`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

// On Vercel (serverless) the app is invoked via api/index.ts, not a long-lived listener.
if (!process.env.VERCEL) {
  start();
}
