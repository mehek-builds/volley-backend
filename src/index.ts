import 'dotenv/config';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';

import { sql } from 'drizzle-orm';
import { db } from './db';
import Anthropic from '@anthropic-ai/sdk';
import type { FastifyBaseLogger } from 'fastify';
import { healthStatusCode, probeDatabase, probeModel, type ModelHealth } from './lib/healthProbe';
import { authRoutes } from './routes/auth';
import { profileRoutes } from './routes/profile';
import { resolveRoutes } from './routes/resolve';
import { draftRoutes } from './routes/draft';
import { trackRoutes } from './routes/track';
import { privacyRoutes } from './routes/privacy';
import { contactRoutes } from './routes/contact';
import { billingRoutes } from './routes/billing';
import { billingV2Routes } from './routes/billingV2';
import { experienceBankRoutes } from './routes/experienceBank';
import { applicationProfileRoutes } from './routes/applicationProfile';
import { applicationAnswerRoutes } from './routes/applicationAnswer';
import { resumeRoutes } from './routes/resume';
import { baseResumeRoutes } from './routes/baseResume';
import { accountRoutes } from './routes/account';
import { resumeRetentionRoutes } from './routes/resumeRetention';
import { adapterHealthRoutes } from './routes/adapterHealth';
import { billingCheckoutAvailable, stripeWebhookAvailable } from './lib/billingCatalog';
import { managedReceivingCanaryRoutes } from './routes/managedReceivingCanary';
import { targetingRoutes } from './routes/targeting';
import { jdMatchRoutes } from './routes/jdMatch';
import { harvestRoutes } from './routes/harvest';
import { onboardingRoutes } from './routes/onboarding';
import { notificationRoutes } from './routes/notifications';
import { sponsorshipRoutes } from './routes/sponsorship';
import { assertEncryptionKeyConfigured } from './lib/fieldCrypto';
import { metaRoutes } from './routes/meta';
import { applicationRoutes } from './routes/applications';
import { canonicalApplicationRoutes } from './routes/canonicalApplications';
import { applicationFromJobRoutes } from './routes/applicationFromJob';
import { submissionRunnerRoutes } from './routes/submissionRunner';
import { autopilotMatcherRoutes } from './routes/autopilotMatcher';
import { captchaStallRoutes } from './routes/captchaStalls';
import { jobExtractRoutes } from './routes/jobExtract';
import { postingQuestionsRoutes } from './routes/postingQuestions';
import { jobMonitorRoutes } from './routes/jobMonitor';
import { coverLetterRoutes } from './routes/coverLetter';
import { documentRoutes } from './routes/documents';
import { emailConnectionRoutes } from './routes/emailConnections';
import { applicationEmailRoutes } from './routes/applicationEmail';
import { API_VERSION, PRODUCT_NAME, PRODUCT_LINKS } from './lib/product';
import { createRateLimitHook, defaultRateLimitConfig, type RateLimitConfig } from './middleware/rateLimit';
import { sharedRankingConfigured } from './lib/rankingCache';
import { resolveBuild, resolveRevision } from './lib/buildInfo';
import { dashboardBootstrapRoutes } from './routes/dashboardBootstrap';
import { networkRoutes } from './routes/network';
import { recruiterVisibilityRoutes } from './routes/recruiterVisibility';
import { configuredAtsSubmissionChannels } from './lib/atsSubmissionChannels';
import { applicationEmailHealth } from './lib/applicationEmail';
import { applicationEmailRouteSelection } from './lib/applicationEmailRoute';
import { warmApplicationAliasDeliverability } from './lib/applicationEmailDeliverability';
import { aggregateServiceHealthStatus } from './lib/serviceHealth';
import { createSubmissionCutoverHook, resolveSubmissionCutover } from './lib/submissionCutover';
import { objectStorageRoutes } from './routes/objectStorage';
import { encryptionRekeyRoutes } from './routes/encryptionRekey';

export interface BuildAppOptions {
  rateLimit?: RateLimitConfig;
  now?: () => number;
  /**
   * The /health model probe's call, injected for the same reason probeDatabase injects its query.
   *
   * Without this the test suite makes a REAL, BILLED call to Anthropic: src/index.ts imports
   * dotenv/config, so a repo .env supplies ANTHROPIC_API_KEY, and src/index.test.ts hits /health a
   * dozen times. Measured at 419ms of live network per run. It happens to be free today only
   * because the balance this whole change is about is empty. Tests pass a stub.
   */
  modelPing?: () => Promise<unknown>;
}

function trustProxySetting(): false | number {
  const configuredHops = Number.parseInt(process.env.TRUST_PROXY_HOPS ?? '', 10);
  if (Number.isFinite(configuredHops) && configuredHops > 0) return configuredHops;
  return process.env.VERCEL ? 1 : false;
}

type PublicError = { statusCode: number; message: string };

export function toPublicError(error: unknown): PublicError {
  if (typeof error !== 'object' || error === null) {
    return { statusCode: 500, message: 'Internal server error' };
  }

  const candidate = error as { statusCode?: unknown; message?: unknown };
  const statusCode =
    typeof candidate.statusCode === 'number' && candidate.statusCode >= 400 && candidate.statusCode < 500
      ? candidate.statusCode
      : 500;

  return {
    statusCode,
    message:
      statusCode < 500 && typeof candidate.message === 'string' && candidate.message.trim()
        ? candidate.message
        : 'Internal server error',
  };
}

export async function buildApp(options: BuildAppOptions = {}) {
  // Refuse to run at all without ENCRYPTION_KEY (R-021). Every encrypted application_profile
  // column is unreadable without it, and the old failure mode was not an error but silence: the
  // decrypt threw, a catch downstream read that as "legacy plaintext", and the raw ciphertext went
  // out to the extension and into a real job application. A dead server is a far better outcome
  // than a server that quietly types base64 at employers, so this fails before any route exists.
  //
  // This belongs in buildApp() rather than start(): prod is Vercel serverless via api/index.ts,
  // where start() never runs, so a gate there would protect only local dev.
  assertEncryptionKeyConfigured();

  const fastify = Fastify({
    // Public logo tenant tokens share the poller's validated 128-character path-segment bound.
    routerOptions: { maxParamLength: 128 },
    // Vercel is the only public ingress, so one proxy hop is trusted there. Local and
    // self-hosted processes do not trust spoofable forwarding headers unless configured.
    trustProxy: trustProxySetting(),
    logger: {
      level: process.env.LOG_LEVEL || 'info',
      transport:
        process.env.NODE_ENV !== 'production'
          ? { target: 'pino-pretty', options: { colorize: true } }
          : undefined,
    },
  });

  const submissionCutover = resolveSubmissionCutover(process.env.SUBMISSION_CUTOVER_MODE);
  // CORS: only known browser origins, instead of reflecting whatever origin calls. The
  // danger being closed is arbitrary WEBSITES reading API responses cross-origin; every
  // authed call carries an Authorization header, so it is preflighted and an unlisted
  // origin never reaches the route. chrome-extension:// origins are allowed as a class:
  // the extension's API calls come from its background service worker (no host_permissions,
  // so they ARE CORS-enforced), the store build and unpacked dev builds have different IDs,
  // and a foreign extension gains nothing - it cannot read our token from another
  // extension's storage, and without a token every route 401s. localhost covers local dev;
  // CORS_EXTRA_ORIGINS covers future domains without a redeploy.
  const extraOrigins = (process.env.CORS_EXTRA_ORIGINS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const allowedOrigins = new Set([
    'https://trylitos.com',
    'https://www.trylitos.com',
    'https://role-quick-website.vercel.app',
    // rolequick.com and www.rolequick.com were removed 2026-07-28: the domain
    // stopped resolving after the rename, so allowing it granted nothing and
    // only suggested a live surface that no longer exists.
    ...extraOrigins,
  ]);
  const isAllowedOrigin = (origin: string | undefined): boolean => {
    // No Origin header = non-browser caller (curl, server-to-server, health checks);
    // CORS doesn't apply and auth still does.
    if (!origin) return true;
    if (allowedOrigins.has(origin)) return true;
    if (origin.startsWith('chrome-extension://')) return true;
    if (/^https?:\/\/localhost(:\d+)?$/.test(origin)) return true;
    return false;
  };

  // The allowlist above is per-request rather than global because exactly one route has to be
  // reachable from origins we will never be able to enumerate: GET /resume/download is fetched
  // by the content script from whatever ATS page the student happens to be on (greenhouse.io,
  // myworkdayjobs.com, ...). It carries no Authorization header and no cookie - its capability
  // token is the credential - so opening it to any origin grants a caller nothing they did not
  // already have by holding the token. Every other route keeps the strict allowlist, and
  // `credentials` stays off here so a browser can never attach ambient auth to it.
  await fastify.register(cors, {
    delegator: (req, cb) => {
      if (req.url?.split('?')[0] === '/resume/download') {
        return cb(null, { origin: true, credentials: false, methods: ['GET', 'OPTIONS'] });
      }
      cb(null, {
        origin: (origin, originCb) => originCb(null, isAllowedOrigin(origin)),
        methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
        allowedHeaders: ['Content-Type', 'Authorization', 'X-Litos-Client', 'X-Litos-Version', 'Idempotency-Key'],
        credentials: true,
      });
    },
  });

  // This root hook follows only CORS, so browser clients can read its 503 response. It still runs
  // before multipart parsing, rate limiting, authentication, database work, provider calls, or
  // capability-token creation. Off mode installs no hook and leaves the request pipeline unchanged.
  if (submissionCutover.mode !== 'off') {
    fastify.addHook('onRequest', createSubmissionCutoverHook(submissionCutover));
  }

  // Multipart support for resume uploads
  await fastify.register(multipart, {
    limits: {
      fileSize: 10 * 1024 * 1024, // 10 MB max
      files: 1,
    },
  });

  // Front-door protection runs before route handlers and database work. Expensive product
  // operations keep their separate database-backed per-user limits in quota.ts.
  fastify.addHook('onRequest', createRateLimitHook(options.rateLimit ?? defaultRateLimitConfig(), options.now));

  /* The smallest call the API will accept: one cheap model, one token in, one token out, and no
     system prompt. It exists to learn whether we will be served AT ALL, so it asks for the least
     answer that still proves it. Haiku deliberately, and deliberately not the model any real
     feature uses: this is a reachability and billing check, not a capability check. */
  const modelPing = options.modelPing ?? (async () => {
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1,
      messages: [{ role: 'user', content: 'ok' }],
    });
  });

  /* ONE VERDICT PER WARM INSTANCE PER TTL, AND ONE CALL IN FLIGHT AT A TIME.
   *
   * Both halves matter, and for different reasons. The TTL bounds the steady cost of a monitor
   * polling on a schedule. The in-flight promise bounds the BURST cost: /health is public and sits
   * in UNMETERED_PATHS (middleware/rateLimit.ts), so it is the one endpoint anybody can hit as
   * fast as they like, and without this every concurrent request on a cold instance would start
   * its own paid call. Sharing the promise makes a burst cost exactly one.
   *
   * Five minutes rather than one: an exhausted balance does not repair itself, the failure lasts
   * until somebody tops it up, and the shorter TTL was buying freshness nobody needed at five
   * times the price. */
  const MODEL_HEALTH_TTL_MS = 300_000;
  let modelHealthCache: { at: number; value: ModelHealth } | null = null;
  let modelHealthInFlight: Promise<ModelHealth> | null = null;
  const cachedModelHealth = async (log: FastifyBaseLogger): Promise<ModelHealth> => {
    const now = Date.now();
    if (modelHealthCache && now - modelHealthCache.at < MODEL_HEALTH_TTL_MS) {
      return modelHealthCache.value;
    }
    if (modelHealthInFlight) return modelHealthInFlight;
    modelHealthInFlight = probeModel(modelPing, {
      configured: Boolean(options.modelPing) || Boolean(process.env.ANTHROPIC_API_KEY?.trim()),
    }).then((value) => {
      if (value.status === 'unavailable') {
        // Same split as the database probe: the category goes in the response, the provider's own
        // message goes to the log, because /health is public and that message names our account.
        log.error({ reason: value.reason, ms: value.ms }, 'health: model unavailable');
      }
      modelHealthCache = { at: Date.now(), value };
      return value;
    }).finally(() => {
      modelHealthInFlight = null;
    });
    return modelHealthInFlight;
  };

  // Health check
  fastify.get('/health', async (request, reply) => {
    /* THE DATABASE, because a health check that cannot fail is not a health check.
     *
     * On 2026-08-04 Neon refused every connection ("exceeded the data transfer quota") and the
     * public board was down for ~75 minutes. This endpoint answered 200 throughout, because it read
     * environment variables and a clock and touched nothing else. Any monitor pointed here saw a
     * healthy service; the first real signal was a CI job failing on an unrelated pull request.
     *
     * `select 1` is deliberate: the incident being detected was a TRANSFER exhaustion, so a probe
     * that moved real bytes would spend the resource it exists to watch. It never throws and always
     * times out, so a degraded database cannot take this endpoint down with it. */
    const database = await probeDatabase(() => db.execute(sql`select 1`));
    if (database.status !== 'ok') {
      // The category is what the response carries; the driver's message can name hosts and roles,
      // so the detail goes to the log and the endpoint stays safe to expose.
      request.log.error({ reason: database.reason, ms: database.ms }, 'health: database unreachable');
    }

    /* The fallback shape is 'degraded', never a config echo that reads as healthy.
     *
     * It used to answer with three environment-variable booleans, which on a probe failure printed
     * exactly the same reassuring output as a working inbox. If we cannot measure the inbox we do
     * not know it works, and /health has to say the thing we actually know. */
    const applicationEmailUnavailable = (reason: string) => {
      const route = applicationEmailRouteSelection();
      return {
        status: 'degraded' as const,
        reason,
        route_mode: route.mode,
        route_mode_explicit: route.explicit,
        invalid_route_mode_present: route.invalid_mode_present,
        ignored_legacy_domain_present: route.ignored_legacy_domain_present,
        ignored_legacy_mailbox_present: route.ignored_legacy_mailbox_present,
        deliverable: false,
        domain: route.domain,
        mx_hosts: [],
        mx_provider: 'unknown' as const,
        mx_provider_agrees: false,
        resend_domain_status: null,
        resend_receiving_status: null,
        inbound_route_configured: false,
        last_inbound_message_at: null,
        last_inbound_message_age_seconds: null,
        enabled_aliases: null,
        domain_configured: Boolean(route.route_label),
        inbound_webhook_configured: Boolean((process.env.RESEND_WEBHOOK_SECRET || process.env.LITOS_INBOUND_EMAIL_WEBHOOK_SECRET || process.env.LITOS_APPLICATION_EMAIL_WEBHOOK_SECRET)?.trim()),
        forwarding_configured: Boolean(process.env.RESEND_API_KEY?.trim() && process.env.RESEND_FROM?.trim()),
        checked_at: new Date().toISOString(),
      };
    };
    const applicationEmail = database.status === 'ok'
      ? await applicationEmailHealth().catch((error) => {
        request.log.error({ err: error }, 'health: application email status unavailable');
        return applicationEmailUnavailable('check_unavailable');
      })
      : applicationEmailUnavailable('database_unavailable');

    /* THE MODEL, cached, because this probe costs money and the database probe does not.
     *
     * A monitor polling every 30s would otherwise buy a model call every 30s forever. The verdict
     * is cached per warm instance for MODEL_HEALTH_TTL_MS, which bounds the spend to roughly one
     * call per instance per TTL and keeps /health fast. The staleness that buys is acceptable here:
     * an exhausted balance does not repair itself within a minute, and the failure this exists to
     * catch lasts until somebody tops it up.
     *
     * The failing case is free anyway. A refusal is returned before any tokens are billed, so the
     * state a monitor will be repeating during an incident costs nothing to observe. */
    const model = await cachedModelHealth(request.log);

    return reply.status(healthStatusCode(database)).send({
      /* 'degraded', not 'error': the service is up and answering, and is correctly reporting that a
         dependency it cannot work without is unavailable. Every identity field below is still
         present on a 503, because DEPLOY.md reads `revision` from this response to confirm what
         shipped, and that has to keep working during an incident. */
      status: aggregateServiceHealthStatus({ database: database.status, applicationEmail, model }),
      database: database.status,
      model: model.status,
      ...(model.status === 'unavailable' ? { model_reason: model.reason } : {}),
      model_ms: model.ms,
      /* WHETHER STRIPE CAN ACTUALLY REACH US, because for 68 days it could not and
         nothing said so.
         STRIPE_WEBHOOK_SECRET stopped being a valid whsec_ value at some point and
         /billing/stripe-webhook answered 503 to every event Stripe sent. Checkout
         still worked, the marketing site still sold, and the only visible symptom
         was a number nobody was watching: 58 accounts, 7 started checkouts, 0
         subscriptions ever recorded. A student could hand over a card and the
         product would never learn of it.
         Two booleans, never the values, so this stays safe to expose publicly. They
         are deliberately separate: checkout configured while the webhook is not is
         exactly the state that sells without being able to deliver, and collapsing
         them into one flag would hide the shape of that failure. */
      billing: {
        checkout_configured: billingCheckoutAvailable(),
        webhook_configured: stripeWebhookAvailable(),
      },
      ...(database.status === 'ok' ? {} : { database_reason: database.reason }),
      database_ms: database.ms,
      service: 'litos-api',
      product: PRODUCT_NAME,
      api_version: API_VERSION,
      // WHICH COMMIT IS SERVING, and WHICH MECHANISM ANSWERED. The comment that used to sit here
      // said the cause of a null `revision` was "NOT established"; it is now established and the
      // measurement lives with the resolver in lib/buildInfo.ts. Short version: the `VERCEL_GIT_*`
      // variables come from the GitHub integration's metadata, so a `vercel --prod` deploy from a
      // laptop leaves them unset and needs `GIT_SHA` passed in, which scripts/deploy-prod.sh does.
      //
      // `revision_source` is the field that makes a null actionable rather than merely
      // disappointing: 'none' means a bare `vercel --prod` and points you at `build`.
      ...resolveRevision(),
      // The deployment identity, which is available even when no SHA was supplied at all. A SHA is
      // comparable to `git rev-parse origin/main` without leaving the terminal and this is not, so
      // read the SHA first; this is what still identifies the deployment when there is no SHA.
      build: resolveBuild(),
      /* WHICH RANKING-CACHE TIERS ARE ACTUALLY RUNNING.
       *
       * 'shared' means L1 plus the Upstash L2; 'local' means L1 only, a process Map with a 60
       * second TTL that dies with the instance.
       *
       * This exists because the difference is INVISIBLE FROM OUTSIDE and expensive. L2 is enabled
       * purely by two environment variables, and with them unset rankingCache.ts is a deliberate
       * no-op: correct, silent, and re-reading the whole ranking pool out of Neon on every cold
       * start. That read is what exhausted Neon's monthly transfer allowance on 2026-08-04 and
       * suspended the database, so "did the env vars actually take effect" is a question worth
       * being able to answer with one curl rather than by inference.
       *
       * It is also the question you have to re-ask after every deploy, because env var changes on
       * Vercel do not reach a running deployment until it is rebuilt. A config change that looks
       * applied in the dashboard and is not live in the function is exactly the gap this closes.
       *
       * NAMES ONLY, NEVER VALUES. sharedRankingConfigured() returns a boolean; the URL and token
       * never appear here. A health endpoint is unauthenticated, and the point is to publish
       * whether a capability is on, not what its credentials are.
       */
      ranking_cache: sharedRankingConfigured() ? 'shared' : 'local',
      /* WHICH ATS SUBMIT CONFIG IS LIVE.
       *
       * Public capability state, never secrets. A Vercel env var can exist by name while the
       * running deployment still sees a blank value, and ATS submission is gated on the exact
       * literal string `true`. This lets the runbook distinguish "not deployed", "enabled but no
       * allowlisted channels", and "channels resolved with referenced secrets".
       */
      ats_api_submission: {
        enabled: process.env.LITOS_ATS_API_SUBMISSION_ENABLED === 'true',
        channel_config_present: Boolean(process.env.LITOS_EMPLOYER_API_SUBMISSION_CHANNELS_JSON?.trim()),
        configured_channels: configuredAtsSubmissionChannels().length,
      },
      application_email: applicationEmail,
      // Effective state only. An invalid nonempty environment value fails closed to freeze, while
      // the value itself stays out of this unauthenticated response.
      submission_cutover: submissionCutover,
      ts: new Date().toISOString(),
    });
  });

  // Stable share link for the Chrome Web Store listing. The 32-char extension ID
  // is assigned by Google and immutable; this redirect is the one URL to share.
  fastify.get('/install', async (_request, reply) => {
    return reply.redirect(PRODUCT_LINKS.install, 302);
  });

  // Routes
  await fastify.register(captchaStallRoutes);
  await fastify.register(authRoutes);
  await fastify.register(metaRoutes);
  await fastify.register(profileRoutes);
  await fastify.register(resolveRoutes);
  await fastify.register(draftRoutes);
  await fastify.register(trackRoutes);
  await fastify.register(privacyRoutes);
  await fastify.register(contactRoutes);
  await fastify.register(billingRoutes);
  await fastify.register(billingV2Routes);
  await fastify.register(networkRoutes);
  await fastify.register(recruiterVisibilityRoutes);
  await fastify.register(experienceBankRoutes);
  await fastify.register(applicationProfileRoutes);
  await fastify.register(targetingRoutes);
  await fastify.register(jdMatchRoutes);
  await fastify.register(harvestRoutes);
  await fastify.register(onboardingRoutes);
  await fastify.register(notificationRoutes);
  await fastify.register(sponsorshipRoutes);
  await fastify.register(applicationAnswerRoutes);
  await fastify.register(canonicalApplicationRoutes);
  await fastify.register(applicationFromJobRoutes);
  await fastify.register(applicationRoutes);
  await fastify.register(submissionRunnerRoutes);
  await fastify.register(autopilotMatcherRoutes);
  await fastify.register(jobExtractRoutes);
  await fastify.register(postingQuestionsRoutes);
  await fastify.register(jobMonitorRoutes);
  await fastify.register(coverLetterRoutes);
  await fastify.register(documentRoutes);
  await fastify.register(emailConnectionRoutes);
  await fastify.register(applicationEmailRoutes);
  await fastify.register(resumeRoutes);
  await fastify.register(objectStorageRoutes);
  await fastify.register(encryptionRekeyRoutes);
  await fastify.register(baseResumeRoutes);
  await fastify.register(accountRoutes);
  await fastify.register(resumeRetentionRoutes);
  await fastify.register(adapterHealthRoutes);
  await fastify.register(managedReceivingCanaryRoutes);
  await fastify.register(dashboardBootstrapRoutes);

  // Global error handler
  fastify.setErrorHandler((error, _request, reply) => {
    fastify.log.error(error);
    const publicError = toPublicError(error);
    return reply.status(publicError.statusCode).send({ error: publicError.message });
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
    /* Warm the alias deliverability answer once at boot so the first submission of the process
     * does not pay for the DNS and Resend lookups. Never awaited and never fatal: a warm that
     * fails simply leaves the cache empty and the first real caller measures it instead. */
    warmApplicationAliasDeliverability();
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
