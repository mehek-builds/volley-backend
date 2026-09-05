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
import { managedPrepareRoutes } from './routes/managedPrepare';
import { submissionRunnerRoutes } from './routes/submissionRunner';
import { autopilotMatcherRoutes } from './routes/autopilotMatcher';
import { reconcileSubmissionConfirmationsRoutes } from './routes/reconcileSubmissionConfirmations';
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
import { readBoardFreshness } from './lib/boardFreshness';
import {
  DEFAULT_MONITOR_INTERVAL_MS,
  DEFAULT_THRESHOLD_MS,
  getIngestionStallMonitor,
  millisecondsFromEnv,
} from './lib/ingestionStallMonitor';
import { aggregateServiceHealthStatus } from './lib/serviceHealth';
import { createSubmissionCutoverHook, resolveSubmissionCutover } from './lib/submissionCutover';
import { objectStorageRoutes } from './routes/objectStorage';
import { submissionLedgerReadiness } from './lib/submissionAttemptLedger';
import { submissionAuthorityRevisionReadiness } from './lib/submissionAuthorityRevision';
import { encryptionRekeyRoutes } from './routes/encryptionRekey';
import { isAuthorityRevisionConflictError } from './db/authorityRevisionRetry';
import {
  createManagedRunAcceptanceGateHook,
  listPreBoundaryManagedRuns,
  stopAcceptingNewManagedRuns,
  triggerManagedRunShutdown,
} from './lib/managedRunLifecycle';
import { releaseOrphanedManagedRun } from './lib/managedRunRestartRelease';
import { runManagedRunBootSweep } from './lib/managedRunBootSweep';

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

type PublicError = { statusCode: number; message: string; retryAfterSeconds?: number };

export function toPublicError(error: unknown): PublicError {
  if (typeof error !== 'object' || error === null) {
    return { statusCode: 500, message: 'Internal server error' };
  }

  const candidate = error as { code?: unknown; statusCode?: unknown; message?: unknown };
  /* THE CAUSE CHAIN, NOT THE TOP-LEVEL `code`, and the difference is the whole of this branch.
   *
   * The submission-authority revision guard raises SQLSTATE 40001 from a BEFORE trigger on every
   * table it covers, generated_resumes included, whenever another actor on the same account holds
   * the per-user advisory lock - a dashboard poll's authority projection read, a history load, or a
   * managed run. drizzle-orm 0.45 does not rethrow that pg error: it wraps it in a
   * DrizzleQueryError whose own `code` is undefined, whose `cause` is the pg error, and whose
   * `message` is `Failed query: <the whole statement>\nparams: <every bound value>`. So this
   * branch, and the authored sentence and Retry-After it exists to send, had stopped firing for
   * every write that reaches Postgres through drizzle - which is all of them.
   *
   * Measured live 2026-09-04 on packet 73768339: PUT /applications/:id/review/answers answered 500
   * carrying that raw UPDATE and its parameters while a managed run held the lock, and the same
   * save answered 200 once the run finished. isAuthorityRevisionConflictError walks the chain, so
   * the wrapper and the bare pg error are read the same way. */
  if (isAuthorityRevisionConflictError(candidate)) {
    return {
      statusCode: 503,
      message: 'This account changed at the same time. Try the request again.',
      retryAfterSeconds: 1,
    };
  }
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
    // Railway production ingress uses an explicitly configured proxy-hop count. Local and
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

  /* THE OTHER HALF OF GRACEFUL SHUTDOWN, and it belongs beside submission cutover for the identical
   * reason: a browser client has to be able to read a typed 503 here, so this also runs before
   * multipart parsing, rate limiting, authentication and every route. Unlike cutover this is
   * unconditional - the check itself is a boolean read and two string comparisons, cheap enough
   * that skipping the registration when nothing is shutting down would save nothing worth the extra
   * branch - and it only ever refuses the two routes that START a brand-new managed run
   * (POST /applications/managed-prepare and POST /applications/:id/submit-request); see
   * lib/managedRunLifecycle.ts for why those two and not the rest of the submission surface.
   * start(), below, is what flips the flag this hook reads, on SIGTERM/SIGINT. */
  fastify.addHook('onRequest', createManagedRunAcceptanceGateHook());

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

    /* Submission code depends on two separately applied authority schemas. A healthy database is
     * not proof that either schema exists, so publish their bounded catalog checks independently.
     * Keeping the reasons coarse makes this safe on a public endpoint while still preventing a
     * release from opening the submission fence against an incomplete migration. */
    const [attemptLedger, authorityRevision] = database.status === 'ok'
      ? await Promise.all([
        submissionLedgerReadiness(),
        submissionAuthorityRevisionReadiness(),
      ])
      : [
        { ready: false, reason: 'unreadable' as const },
        { ready: false, reason: 'unreadable' as const },
      ];
    const submissionAuthorityReady = attemptLedger.ready && authorityRevision.ready;

    return reply.status(submissionAuthorityReady ? healthStatusCode(database) : 503).send({
      /* 'degraded', not 'error': the service is up and answering, and is correctly reporting that a
         dependency it cannot work without is unavailable. Every identity field below is still
         present on a 503, because DEPLOY.md reads `revision` from this response to confirm what
         shipped, and that has to keep working during an incident. */
      status: submissionAuthorityReady
        ? aggregateServiceHealthStatus({ database: database.status, applicationEmail, model })
        : 'degraded',
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
      submission_authority: {
        ready: submissionAuthorityReady,
        attempt_ledger: attemptLedger,
        revision: authorityRevision,
      },
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

  /* GLOBAL ERROR HANDLER, AND IT HAS TO BE INSTALLED BEFORE THE ROUTES IT COVERS.
   *
   * Fastify hands each encapsulated plugin the error handler that exists AT THE MOMENT THE PLUGIN IS
   * CREATED, and every `await fastify.register(...)` below finishes creating its context before the
   * next line runs. Installed after that block - where this lived until now - it covered the two
   * bare `fastify.get` routes declared on the root instance and NOTHING ELSE: every application,
   * submission, resume and auth route fell through to Fastify's built-in handler instead.
   *
   * WHAT THAT COST, measured live 2026-09-04 on packet 73768339. Fastify's default serializes the
   * thrown error verbatim - `{"statusCode":500,"error":"Internal Server Error","message":"Failed
   * query: update \"generated_resumes\" set \"spec\" = jsonb_set(...) where (... and
   * \"generated_resumes\".\"spec\" = $4::jsonb ...) returning \"id\""}` - so a routine write
   * conflict shipped the whole statement, its bound-parameter shape and the row's stored spec
   * predicate to the browser, and the dashboard rendered the `error` key as the literal words
   * "Internal Server Error". toPublicError's authored sentences, its Retry-After and its refusal to
   * echo server internals were all unreachable from the routes that actually serve applicants.
   *
   * Pinned in src/index.test.ts, on the source rather than through an injected request, because the
   * ordering is the whole mechanism and nothing injected can see it: a plugin a test registers after
   * buildApp() returns inherits this handler under EITHER ordering, which is exactly why the defect
   * survived a suite that exercises these routes constantly.
   *
   * THE SERVER LOG, NOT JUST THE CLIENT RESPONSE. toPublicError intentionally throws away a bare
   * Error's own message for the CLIENT - "Internal server error" is the whole point, so a stack
   * trace or a raw SQL statement never reaches a browser - which makes the server-side log line the
   * ONLY place that message ever exists. MEASURED LIVE 2026-09-04, account
   * mehekmandal05@gmail.com: GET /applications/:id/submission 500'd on detectPortal's throw for a
   * regional Teamtailor tenant (see normalizedPacketAuditQuestions in routes/submissionRunner.ts),
   * and finding the cause meant reproducing it from scratch rather than reading it off, because
   * `fastify.log.error(error)` logged against the ROOT logger with the request parameter unused
   * (`_request`) - pino's own err-object fast path DOES capture the message and stack, so that part
   * was never missing, but nothing tied the line to a ROUTE or a single REQUEST. A root-logger error
   * line is indistinguishable from every other request's in flight at the same moment, on a
   * serverless platform running many at once, which made this exact 500 as hard to find in the logs
   * as it was easy to reproduce once someone did. request.log is Fastify's per-request child logger
   * (see requestPathForCardGate in middleware/auth.ts for the same routeOptions-over-raw-url
   * reasoning applied to a different route set): it stamps every line with reqId for free, and
   * routeOptions.url is the registered TEMPLATE ('/applications/:id/submission', never the literal
   * application id), which is what keeps this free of PII without a denylist to maintain. */
  fastify.setErrorHandler((error, request, reply) => {
    request.log.error(
      { err: error, route: request.routeOptions?.url ?? request.url ?? '/', method: request.method },
      error instanceof Error ? error.message : 'Unhandled error',
    );
    const publicError = toPublicError(error);
    if (publicError.retryAfterSeconds !== undefined) {
      reply.header('Retry-After', String(publicError.retryAfterSeconds));
    }
    return reply.status(publicError.statusCode).send({ error: publicError.message });
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
  await fastify.register(managedPrepareRoutes);
  await fastify.register(applicationRoutes);
  await fastify.register(submissionRunnerRoutes);
  await fastify.register(autopilotMatcherRoutes);
  await fastify.register(reconcileSubmissionConfirmationsRoutes);
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

  // 404 handler
  fastify.setNotFoundHandler((_request, reply) => {
    return reply.status(404).send({ error: 'Route not found' });
  });

  return fastify;
}

/**
 * How long the SIGTERM/SIGINT handler spends writing honest terminal states for this process's own
 * in-flight managed runs before calling process.exit() regardless of whether every write finished.
 *
 * NEITHER railway.json NOR the Dockerfile configures an explicit termination grace period, so this
 * assumes Railway's own documented default of roughly ten seconds between SIGTERM and the SIGKILL
 * that follows it. Eight leaves a margin for this function's own teardown - the race resolving, the
 * log line, process.exit itself - to still land inside that window rather than racing SIGKILL for
 * it. Getting this wrong in the too-long direction is the worse failure: a handler SIGKILLed
 * mid-write leaves exactly the stranded row this feature exists to prevent, recoverable only by
 * managedRunBootSweep.ts on the next boot rather than by this handler at all.
 */
const MANAGED_RUN_SHUTDOWN_DEADLINE_MS = 8_000;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

/**
 * Release every pre-boundary managed run this process still owns, bounded so it cannot outlive
 * Railway's own SIGKILL. Exported for its own targeted test; production reaches it only through the
 * signal handlers installed below.
 *
 * ORDER MATTERS. Accepting new work is stopped, and the shared stratus abort signal fired, BEFORE
 * anything is read from the registry - a run that started registering in the window between "we
 * decided to shut down" and "we finished releasing what we already had" would be exactly as
 * stranded as the ones this exists to rescue, and an aborted fetch lets that run's own promise
 * start unwinding concurrently with the release writes below rather than after them.
 *
 * THE WRITES RUN IN PARALLEL (Promise.allSettled over every registered run at once, not a loop
 * awaiting one at a time), raced against the deadline above rather than chained after it, so a
 * slow or contended release for one packet can never crowd out the others' chance to finish inside
 * the grace window. Anything the race leaves unsettled when the deadline wins is abandoned exactly
 * as if this handler had never run for it: still 'preparing'/'filling'/'submitting', still carrying
 * this process's own now-stale run_owner, and now the boot sweep's problem on the next start.
 */
export async function releaseManagedRunsBeforeExit(
  log: Pick<FastifyBaseLogger, 'info' | 'warn' | 'error'>,
  options: {
    /** Injected for the same reason BuildAppOptions.modelPing is: so the targeted test in
     * index.test.ts can prove the deadline race actually bounds a release that never resolves,
     * without opening a real database transaction. Production never passes this. */
    release?: typeof releaseOrphanedManagedRun;
    deadlineMs?: number;
  } = {},
): Promise<void> {
  const release = options.release ?? releaseOrphanedManagedRun;
  const deadlineMs = options.deadlineMs ?? MANAGED_RUN_SHUTDOWN_DEADLINE_MS;
  stopAcceptingNewManagedRuns();
  triggerManagedRunShutdown();
  const runs = listPreBoundaryManagedRuns();
  if (runs.length === 0) return;
  log.info({ count: runs.length }, 'Releasing in-flight managed runs before shutdown');
  const releases = Promise.allSettled(runs.map((run) => release({
    packetId: run.packetId,
    userId: run.userId,
    log,
  }).catch((err) => {
    log.error({ err, applicationId: run.packetId }, 'Failed to release a managed run during shutdown');
  })));
  await Promise.race([releases, delay(deadlineMs)]);
}

let shuttingDown = false;

/**
 * Installed only here, in start() - the Railway long-lived-process path - and never in buildApp(),
 * for the same reason the ingestion stall monitor a few lines below is started only here: the
 * serverless entrypoint (api/index.ts) and the test suite both call buildApp() directly and must
 * never register a process-level signal handler as a side effect of building an app. A second
 * SIGTERM (or a SIGINT arriving mid-shutdown) is a no-op, not a second race against the same
 * deadline.
 */
function installManagedRunShutdownHandlers(app: Awaited<ReturnType<typeof buildApp>>): void {
  const handle = (signal: NodeJS.Signals) => {
    if (shuttingDown) return;
    shuttingDown = true;
    app.log.info({ signal }, 'Received shutdown signal; releasing in-flight managed runs before exit');
    void releaseManagedRunsBeforeExit(app.log)
      .catch((err) => app.log.error(err, 'Error releasing managed runs during shutdown'))
      .finally(() => process.exit(0));
  };
  process.on('SIGTERM', () => handle('SIGTERM'));
  process.on('SIGINT', () => handle('SIGINT'));
}

async function start() {
  const port = parseInt(process.env.PORT || '3001', 10);
  const host = process.env.HOST || '0.0.0.0';

  const app = await buildApp();
  installManagedRunShutdownHandlers(app);

  try {
    /* THE OTHER HALF OF THIS FEATURE, and it runs BEFORE serving on purpose: a request landing the
     * instant this instance comes up must never read a row this sweep would have fixed a moment
     * later. Best-effort, exactly like the warm-cache and stall-monitor calls below - a database
     * that is not yet reachable delays nothing here, and the rows it would have fixed simply fall
     * back to the pre-existing three-hour stall bound (stalledFillRunRelease.ts). See
     * managedRunBootSweep.ts for why a foreign run_owner found here is safe to treat as urgently as
     * this process's own SIGTERM handler treats one of its own runs. */
    await runManagedRunBootSweep(app.log).catch((err) => {
      app.log.error(err, 'Boot-time managed run orphan sweep failed; continuing to start');
    });

    await app.listen({ port, host });
    /* Warm the alias deliverability answer once at boot so the first submission of the process
     * does not pay for the DNS and Resend lookups. Never awaited and never fatal: a warm that
     * fails simply leaves the cache empty and the first real caller measures it instead. */
    warmApplicationAliasDeliverability();

    /* IS THE BOARD STILL BEING FED? Sampled here, on a real interval, because GitHub's is not one.
     * ingestion-stall-alert.yml declared every 30 minutes and was delivered roughly every 3.5
     * hours; from 2026-08-27 every cron in the repository degraded to the same five-to-eight runs
     * a day whatever it declared, so the workflow can no longer be the thing that notices - only
     * the thing that reports. Started here rather than in buildApp so tests and the serverless
     * entrypoint never spawn a timer, and deliberately NOT in the job-monitor worker, which is the
     * component that wedged on 2026-09-01 and would have taken its own alarm down with it. */
    const stallMonitor = getIngestionStallMonitor({
      read: readBoardFreshness,
      intervalMs: millisecondsFromEnv(process.env.INGESTION_STALL_CHECK_INTERVAL_MS, DEFAULT_MONITOR_INTERVAL_MS),
      thresholdMs: millisecondsFromEnv(process.env.INGESTION_STALL_THRESHOLD_MS, DEFAULT_THRESHOLD_MS),
    });
    stallMonitor.start();
    /* Sample once at boot so a process that has just restarted answers from evidence rather than
     * from an empty record for its first interval. Never awaited and never fatal. */
    void stallMonitor.check();

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
