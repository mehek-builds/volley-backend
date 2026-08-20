import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/index';
import { users } from '../db/schema';
import { requireAuth } from '../middleware/auth';
import { isCronAuthorized, isCronConfigured } from '../lib/cronAuth';
import { isUndefinedColumnError } from '../lib/applicationFacts';
import { PRODUCT_LINKS, PRODUCT_NAME } from '../lib/product';
import {
  NOTIFICATION_KINDS,
  notificationPreferenceUpdate,
  notificationPreferencesFrom,
  type NotificationKind,
} from '../lib/notificationPreferences';
import { readUnsubscribeToken, unsubscribeConfiguration, unsubscribeConfigured } from '../lib/notificationUnsubscribe';
import { sendNotification } from '../lib/notificationSend';
import { strongMatchEmail } from '../lib/notificationEmail';
import {
  breachesStrongFitSla,
  STRONG_FIT_SLA_HOURS,
  strongMatchDedupeKey,
  strongMatchForAccount,
  subscribedMatchAccounts,
  VERY_STRONG_FIT_SCORE,
} from '../lib/strongMatchNotification';
import { previewDigest, runDigestSweep } from '../lib/digestSweep';
import { forgetPushSubscription, pushConfiguration, pushPublicKey, rememberPushSubscription } from '../lib/webPush';

/* THE NOTIFICATION SURFACES: the two toggles, the way out, and the daily sweep.
 *
 * The way out is the one that had to be designed rather than assembled, and every choice in it is
 * about somebody who is NOT signed in. See lib/notificationUnsubscribe.ts for why that is the only
 * design worth having.
 */

/* The exact shape PushManager.subscribe().toJSON() produces, validated rather than trusted: these
   values are written straight into a table the sender reads, and a row with a malformed key is a
   device that fails on every send forever. */
const pushSubscriptionBodySchema = z.object({
  endpoint: z.string().url().max(2000),
  keys: z.object({
    p256dh: z.string().min(1).max(200),
    auth: z.string().min(1).max(200),
  }),
});

function isUndefinedTableError(error: unknown): boolean {
  // Bounded, and walks the cause chain because drizzle wraps every failed statement.
  let current: unknown = error;
  for (let depth = 0; current && depth < 5; depth += 1) {
    if ((current as { code?: unknown }).code === '42P01') return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

const preferencesBodySchema = z.object({
  strong_match: z.boolean().optional(),
  employer_reply: z.boolean().optional(),
  activity_digest: z.boolean().optional(),
}).refine(
  (value) => NOTIFICATION_KINDS.some((kind) => value[kind] !== undefined),
  { message: 'At least one notification preference is required' },
);

/**
 * How many accounts one cron run will consider.
 *
 * A BUDGET, NOT A POPULATION LIMIT, and the response says which one it hit. The function has 300
 * seconds (vercel.json) and each account costs a small handful of queries plus one scoring pass
 * over at most RANKING_POOL postings, so this is far inside the budget at today's size. It exists
 * so that growth turns into a REPORTED shortfall in the run summary rather than into a timeout
 * that kills the run half way and sends a random half of the subscribers their mail.
 */
export const MATCH_SWEEP_ACCOUNT_LIMIT = 500;

export type MatchSweepSummary = {
  considered: number;
  matched: number;
  sent: number;
  suppressed: Record<string, number>;
  failed: number;
  truncated: boolean;
  /** How many of this run's sends were themselves the SLA breach: a very-strong fit
   *  (score >= very_strong_fit_score) that had already sat past sla_hours before this sweep
   *  finally reached it. Echoed on every run, not only on a breach, for the same reason
   *  surfaced_postings is on jobMonitor's payload: a promise erodes before it snaps. */
  sla_breaches: number;
  sla_hours: number;
  very_strong_fit_score: number;
};

/**
 * One account, start to finish, so a failure is scoped to the student it belongs to.
 *
 * ONE STUDENT'S BAD DATA MUST NOT COST EVERY OTHER STUDENT THEIR ALERT. A corrupt resume spec, a
 * posting whose text breaks the scorer, a row that vanished mid-run: any of them throwing out of
 * the sweep loop would end the run, and because the run is daily the rest of the subscribers would
 * simply not be told about anything that day, with nothing on screen to say so. So each account is
 * wrapped, its failure is counted, and the sweep carries on.
 */
/**
 * `slaBreach` is computed from the CANDIDATE, not from whether the send succeeded - and that is
 * the whole fix for the gap a review caught in this barrier's first version. A very-strong fit that
 * `strongMatchForAccount` correctly identifies as this account's best available posting, but that
 * `sendNotification` then suppresses (most concretely: the daily cap already spent on a weaker
 * match sent earlier the same UTC day), used to vanish with zero signal - `breachesStrongFitSla`
 * was only ever called inside the `outcome.sent` branch, so a starved very-strong fit aged out of
 * MATCH_LOOKBACK_HOURS silently, `sla_breaches` stayed 0, and the route answered 200 throughout.
 * The promise was never "we will always send a late very-strong fit", it was "we will not stay
 * quiet about missing it" - so the breach is now measured against the candidate the moment it is
 * chosen, whether or not the send that follows is the thing that fails.
 */
async function sweepAccount(
  account: { id: string; email: string },
  now: Date,
): Promise<
  | { kind: 'sent'; slaBreach: boolean }
  | { kind: 'no_match' }
  | { kind: 'suppressed'; reason: string; slaBreach: boolean }
> {
  const match = await strongMatchForAccount(account.id, now);
  if (!match) return { kind: 'no_match' };
  const outcome = await sendNotification({
    userId: account.id,
    kind: 'strong_match',
    dedupeKey: strongMatchDedupeKey(account.id, match.id),
    monitoredJobId: match.id,
    build: (unsubscribeUrl) => strongMatchEmail({
      to: account.email,
      unsubscribeUrl,
      now,
      job: match,
      score: match.score,
    }),
  }, { now: () => now });
  const slaBreach = breachesStrongFitSla(match, now);
  if (outcome.sent) return { kind: 'sent', slaBreach };
  return { kind: 'suppressed', reason: outcome.reason, slaBreach };
}

export async function runStrongMatchSweep(now: Date, log?: FastifyRequest['log']): Promise<MatchSweepSummary> {
  const accounts = await subscribedMatchAccounts(MATCH_SWEEP_ACCOUNT_LIMIT + 1);
  const truncated = accounts.length > MATCH_SWEEP_ACCOUNT_LIMIT;
  const considered = accounts.slice(0, MATCH_SWEEP_ACCOUNT_LIMIT);
  const summary: MatchSweepSummary = {
    considered: considered.length,
    matched: 0,
    sent: 0,
    suppressed: {},
    failed: 0,
    truncated,
    sla_breaches: 0,
    sla_hours: STRONG_FIT_SLA_HOURS,
    very_strong_fit_score: VERY_STRONG_FIT_SCORE,
  };

  for (const account of considered) {
    try {
      const result = await sweepAccount(account, now);
      if (result.kind === 'no_match') continue;
      summary.matched += 1;
      if (result.slaBreach) {
        summary.sla_breaches += 1;
        log?.error(
          { userId: account.id, sla_hours: STRONG_FIT_SLA_HOURS, outcome: result.kind },
          'a very-strong-fit match was not emailed within the SLA window',
        );
      }
      if (result.kind === 'sent') {
        summary.sent += 1;
      } else {
        summary.suppressed[result.reason] = (summary.suppressed[result.reason] ?? 0) + 1;
      }
    } catch (error) {
      summary.failed += 1;
      log?.error({ userId: account.id, err: error }, 'strong match notification failed for one account');
    }
  }
  /* A truncated sweep is a real operational fact and it is silent from every other surface, so it
     is logged as a warning as well as reported. The students beyond the limit are not told they
     were skipped, and nothing else would notice. */
  if (truncated) {
    log?.warn({ limit: MATCH_SWEEP_ACCOUNT_LIMIT }, 'strong match sweep hit its account budget and did not consider every subscriber');
  }
  return summary;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const KIND_LABEL: Record<NotificationKind, string> = {
  strong_match: 'alerts when a strong match opens',
  employer_reply: 'alerts when an employer replies',
  activity_digest: 'the daily summary of what Litos did',
};

function page(title: string, bodyHtml: string): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="robots" content="noindex" />
    <title>${escapeHtml(title)} | ${PRODUCT_NAME}</title>
    <style>
      body { margin:0; padding:48px 16px; background:#f7f7f5; color:#12120f; font:16px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif; }
      main { max-width:520px; margin:0 auto; background:#fff; border:1px solid #e8e6e1; border-radius:20px; padding:32px; }
      h1 { margin:0 0 12px; font-size:22px; }
      p { margin:0 0 16px; color:#6b6a64; }
      button { display:inline-block; padding:12px 20px; border:0; border-radius:999px; background:#6b84e8; color:#fff; font:inherit; cursor:pointer; }
      button.secondary { background:#f7f7f5; color:#12120f; border:1px solid #e8e6e1; }
      a { color:#4f68c9; }
      form { display:inline; }
    </style>
  </head>
  <body><main>${bodyHtml}</main></body>
</html>`;
}

function replyHtml(reply: FastifyReply, status: number, html: string) {
  return reply.status(status).type('text/html; charset=utf-8').send(html);
}

/**
 * Turn off one kind, or every kind, for one account.
 *
 * IDEMPOTENT AND SILENT ABOUT WHETHER IT CHANGED ANYTHING. Somebody clicking an unsubscribe link
 * twice, or a mail client prefetching it and the reader then clicking it, must both end at "you
 * are unsubscribed" rather than at "that was already done", which reads like a failure.
 */
async function applyUnsubscribe(userId: string, scope: 'kind' | 'all', kind: NotificationKind): Promise<void> {
  const changes = scope === 'all'
    ? Object.fromEntries(NOTIFICATION_KINDS.map((each) => [each, false]))
    : { [kind]: false };
  await db.update(users)
    .set(notificationPreferenceUpdate(changes, new Date()))
    .where(eq(users.id, userId));
}

export async function notificationRoutes(fastify: FastifyInstance) {
  /* RFC 8058 one-click unsubscribe posts a form-encoded body, and Fastify answers 415 to a content
     type it has no parser for, before any handler runs. Registered inside this plugin so it is
     scoped to these routes and no other route in the API starts accepting form posts.
     The body is deliberately discarded: the token lives in the query string, which is what the
     link in the email carries, so a malformed or absent body cannot stop an unsubscribe. */
  fastify.addContentTypeParser(
    'application/x-www-form-urlencoded',
    { parseAs: 'string' },
    (_request, body, done) => done(null, typeof body === 'string' ? body : ''),
  );

  /**
   * GET /notifications/preferences
   *
   * Tolerant of a database the deploy arrived ahead of, for the same reason /onboarding/state is:
   * screen 08 reads this, and a 500 here is a blank screen in the middle of the setup flow. Absent
   * columns read as "nothing is on", which is what every account holds until it turns something on.
   */
  fastify.get('/notifications/preferences', { preHandler: requireAuth }, async (request: FastifyRequest, reply: FastifyReply) => {
    const userId = request.jwtPayload!.userId;
    let row: Record<string, unknown> | undefined;
    try {
      [row] = await db
        .select({
          notify_strong_match_enabled: users.notify_strong_match_enabled,
          notify_strong_match_granted_at: users.notify_strong_match_granted_at,
          notify_employer_reply_enabled: users.notify_employer_reply_enabled,
          notify_employer_reply_granted_at: users.notify_employer_reply_granted_at,
          notify_activity_digest_enabled: users.notify_activity_digest_enabled,
          notify_activity_digest_granted_at: users.notify_activity_digest_granted_at,
          email_verified: users.email_verified,
        })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1) as Record<string, unknown>[];
    } catch (error) {
      if (!isUndefinedColumnError(error)) throw error;
      /* The preferences fail open to "nothing is on", which is what an un-migrated database
         effectively holds. `deliverable` must NOT be manufactured the same way: reporting false
         because the read failed tells a student with a perfectly good verified address that Litos
         cannot mail her until she verifies it, which is both untrue and unfixable by her. So the
         one column that has always existed is read on its own. */
      row = (await db
        .select({ email_verified: users.email_verified })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1))[0] as Record<string, unknown> | undefined;
    }
    return reply.status(200).send({
      ...notificationPreferencesFrom(row as never),
      /* Both facts the client needs to explain a toggle that will not do anything yet, rather than
         letting a student switch something on and hear nothing forever. An unverified address
         cannot be mailed (see subscribedMatchAccounts) and a deployment with no signing secret
         cannot mint an unsubscribe link, which the send path treats as fatal. */
      deliverable: row?.email_verified === true,
      unsubscribe_configured: unsubscribeConfigured(),
    });
  });

  /** PUT /notifications/preferences - screen 08 and the settings page both write here. */
  fastify.put('/notifications/preferences', { preHandler: requireAuth }, async (request: FastifyRequest, reply: FastifyReply) => {
    const parsed = preferencesBodySchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: 'Invalid notification preferences' });
    const userId = request.jwtPayload!.userId;
    try {
      await db.update(users)
        .set(notificationPreferenceUpdate(parsed.data, new Date()))
        .where(eq(users.id, userId));
    } catch (error) {
      /* A WRITE CANNOT FAIL OPEN. The read above degrades to "nothing is on" because that answer is
         true of an un-migrated database; a write has no such honest fallback, and reporting success
         for a permission that was never stored would leave a student believing she had subscribed. */
      if (!isUndefinedColumnError(error)) throw error;
      return reply.status(503).send({ error: 'Notification preferences are not available yet' });
    }
    const [row] = await db
      .select({
        notify_strong_match_enabled: users.notify_strong_match_enabled,
        notify_strong_match_granted_at: users.notify_strong_match_granted_at,
        notify_employer_reply_enabled: users.notify_employer_reply_enabled,
        notify_employer_reply_granted_at: users.notify_employer_reply_granted_at,
        notify_activity_digest_enabled: users.notify_activity_digest_enabled,
        notify_activity_digest_granted_at: users.notify_activity_digest_granted_at,
        email_verified: users.email_verified,
      })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    return reply.status(200).send({
      ...notificationPreferencesFrom(row),
      deliverable: row?.email_verified === true,
      unsubscribe_configured: unsubscribeConfigured(),
    });
  });

  /**
   * GET /notifications/unsubscribe?token=...
   *
   * DOES NOT UNSUBSCRIBE. It draws a page with two buttons that do.
   *
   * That is not ceremony, it is the difference between a link that works and one that fires on its
   * own: corporate mail scanners and link-preview bots follow every URL in an incoming message
   * before a human sees it, and a GET that mutates would silently unsubscribe people who never
   * clicked anything. The machine-readable path for clients that want no page at all is the POST
   * below, advertised through List-Unsubscribe-Post, which is exactly the affordance RFC 8058
   * exists to provide.
   */
  fastify.get('/notifications/unsubscribe', async (request: FastifyRequest, reply: FastifyReply) => {
    const token = (request.query as { token?: unknown } | undefined)?.token;
    const claim = typeof token === 'string' ? readUnsubscribeToken(token) : null;
    if (!claim) {
      return replyHtml(reply, 400, page('Link not recognised', [
        `<h1>That link is not one we recognise</h1>`,
        `<p>It may have been cut short by a mail client. You can turn any ${PRODUCT_NAME} alert off from your settings.</p>`,
        `<p><a href="${escapeHtml(new URL('/dashboard/settings#automation', PRODUCT_LINKS.website).toString())}">Open settings</a></p>`,
      ].join('')));
    }
    const safeToken = escapeHtml(token as string);
    return replyHtml(reply, 200, page('Stop these emails', [
      `<h1>Stop these emails?</h1>`,
      `<p>This will turn off ${escapeHtml(KIND_LABEL[claim.kind])}. Nothing else changes, and you do not need to sign in.</p>`,
      `<form method="post" action="/notifications/unsubscribe?token=${safeToken}">`,
      `<input type="hidden" name="scope" value="kind" />`,
      `<button type="submit">Turn these off</button>`,
      `</form> `,
      `<form method="post" action="/notifications/unsubscribe?token=${safeToken}">`,
      `<input type="hidden" name="scope" value="all" />`,
      `<button type="submit" class="secondary">Turn off every ${PRODUCT_NAME} alert</button>`,
      `</form>`,
    ].join('')));
  });

  /**
   * POST /notifications/unsubscribe?token=...
   *
   * The acting half, and the one a mail client's own Unsubscribe button reaches directly.
   *
   * NO AUTHENTICATION, BY DESIGN. The token authorises exactly one act and that act can only ever
   * reduce what Litos sends. It can never turn an alert on, read anything, or identify anybody: see
   * lib/notificationUnsubscribe.ts. A signed-in-only unsubscribe is the thing this whole path
   * exists to avoid being.
   *
   * `scope` comes from the form the page above draws. A bare one-click POST sends no scope and
   * unsubscribes the kind in the token, which is the stream that actually mailed the recipient.
   */
  fastify.post('/notifications/unsubscribe', async (request: FastifyRequest, reply: FastifyReply) => {
    const token = (request.query as { token?: unknown } | undefined)?.token;
    const claim = typeof token === 'string' ? readUnsubscribeToken(token) : null;
    if (!claim) {
      return replyHtml(reply, 400, page('Link not recognised', [
        `<h1>That link is not one we recognise</h1>`,
        `<p>You can turn any ${PRODUCT_NAME} alert off from your settings.</p>`,
      ].join('')));
    }
    const raw = typeof request.body === 'string' ? request.body : '';
    const scope = new URLSearchParams(raw).get('scope') === 'all' ? 'all' : 'kind';
    try {
      await applyUnsubscribe(claim.userId, scope, claim.kind);
    } catch (error) {
      if (!isUndefinedColumnError(error)) throw error;
      /* Nothing is subscribed on a database without the columns, so there is nothing to turn off
         and the honest answer to the reader is still "you will not get these". */
    }
    const what = scope === 'all' ? `every ${PRODUCT_NAME} alert` : KIND_LABEL[claim.kind];
    return replyHtml(reply, 200, page('Unsubscribed', [
      `<h1>Done</h1>`,
      `<p>You will not get ${escapeHtml(what)} from ${PRODUCT_NAME}.</p>`,
      `<p>Application email that employers send to your ${PRODUCT_NAME} address is unaffected: that is your own mail being routed, not an alert.</p>`,
      `<p><a href="${escapeHtml(new URL('/dashboard/settings#automation', PRODUCT_LINKS.website).toString())}">Change what you hear about</a></p>`,
    ].join('')));
  });

  /**
   * The daily sweep. GET and POST both, matching every other /internal endpoint: Vercel Cron issues
   * a GET, and an operator running it by hand reaches for POST.
   */
  const handleSweep = async (request: FastifyRequest, reply: FastifyReply) => {
    if (!isCronConfigured() || !isCronAuthorized(request)) {
      return reply.status(401).send({ error: 'Unauthorized' });
    }
    /* Refused rather than run, and BOTH halves are checked. Every send would fail on the same
       missing link, and a run that reports 200 with nothing sent looks identical to a quiet day.
       An earlier version tested only the signing secret, which let a deployment with no
       PUBLIC_API_BASE - the default state, since nothing else in this codebase requires it - do
       the whole sweep and report success while mailing nobody. */
    const configuration = unsubscribeConfiguration();
    if (!configuration.ok) {
      return reply.status(503).send({
        error: configuration.missing === 'signing_secret'
          ? 'No signing secret is configured for notification unsubscribe links'
          : 'PUBLIC_API_BASE is not set, so notification unsubscribe links have nowhere to point',
        missing: configuration.missing,
      });
    }
    const summary = await runStrongMatchSweep(new Date(), request.log);
    /* THE HARD BARRIER. A cron that always answers 200 is a cron nobody reads - see
       MINIMUM_SURFACED_JOBS in jobMonitor.ts, the same pattern applied here. The fix for a breach
       is a sweep that runs often enough to catch very-strong fits sooner (see
       .github/workflows/strong-match-notifications.yml, the sub-daily cadence Vercel's Hobby-tier cron
       cannot run on its own), never a wider STRONG_FIT_SLA_HOURS. */
    if (summary.sla_breaches > 0) {
      request.log.error(
        {
          sla_breaches: summary.sla_breaches,
          sla_hours: summary.sla_hours,
          very_strong_fit_score: summary.very_strong_fit_score,
        },
        'Strong-match SLA breached',
      );
      return reply.status(500).send({
        ...summary,
        error: `${summary.sla_breaches} very-strong-fit match(es) (score >= ${summary.very_strong_fit_score}) `
          + `reached a student more than ${summary.sla_hours} hours after Litos found them. Check that the `
          + 'sub-daily sweep cadence is actually firing (GitHub Actions, not vercel.json - Vercel Hobby '
          + 'rejects sub-daily crons at deploy time) before assuming this run is the anomaly. '
          + 'Do not raise sla_hours to clear this.',
      });
    }
    return reply.status(200).send(summary);
  };
  fastify.get('/internal/strong-match-notifications', handleSweep);
  fastify.post('/internal/strong-match-notifications', handleSweep);

  /* GET /notifications/push/key
   *
   * The VAPID public key the browser needs before it can mint a subscription. Public by definition:
   * it is handed to every page that asks and is useless without the private half. Served rather
   * than baked into the website bundle so rotating the pair does not need a website deploy, and so
   * a deployment with no keys answers `configured: false` instead of the client failing obscurely
   * inside PushManager.subscribe with an invalid application key. */
  fastify.get('/notifications/push/key', async (_request: FastifyRequest, reply: FastifyReply) => {
    const configuration = pushConfiguration();
    return reply.status(200).send({
      configured: configuration.ok,
      public_key: pushPublicKey(),
      ...(configuration.ok ? {} : { missing: configuration.missing }),
    });
  });

  /* POST /notifications/push/subscribe
   *
   * One device saying it is willing to be interrupted. Authenticated, because the row is what binds
   * a browser to an account and an unauthenticated writer could point somebody else's laptop at
   * their own notifications. */
  fastify.post('/notifications/push/subscribe', { preHandler: requireAuth }, async (request: FastifyRequest, reply: FastifyReply) => {
    const parsed = pushSubscriptionBodySchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: 'Invalid push subscription' });
    try {
      await rememberPushSubscription({
        userId: request.jwtPayload!.userId,
        endpoint: parsed.data.endpoint,
        p256dh: parsed.data.keys.p256dh,
        auth: parsed.data.keys.auth,
        userAgent: typeof request.headers['user-agent'] === 'string' ? request.headers['user-agent'] : null,
      });
    } catch (error) {
      if (!isUndefinedTableError(error)) throw error;
      return reply.status(503).send({ error: 'Push notifications are not available yet' });
    }
    return reply.status(200).send({ ok: true });
  });

  /* POST /notifications/push/unsubscribe - one device withdrawing, scoped to its owner. */
  fastify.post('/notifications/push/unsubscribe', { preHandler: requireAuth }, async (request: FastifyRequest, reply: FastifyReply) => {
    const endpoint = (request.body as { endpoint?: unknown } | undefined)?.endpoint;
    if (typeof endpoint !== 'string' || !endpoint) return reply.status(400).send({ error: 'Invalid push subscription' });
    try {
      return reply.status(200).send({ ok: true, removed: await forgetPushSubscription(request.jwtPayload!.userId, endpoint) });
    } catch (error) {
      if (!isUndefinedTableError(error)) throw error;
      return reply.status(200).send({ ok: true, removed: false });
    }
  });

  /* GET /notifications/digest/preview - what today's digest WOULD say, sending nothing.
   *
   * Authenticated and scoped to the caller's own account. It exists because a digest that goes
   * quiet is indistinguishable from a digest that is broken, and this is the only way to tell the
   * two apart without waiting for tomorrow's cron. */
  fastify.get('/notifications/digest/preview', { preHandler: requireAuth }, async (request: FastifyRequest, reply: FastifyReply) => {
    return reply.status(200).send(await previewDigest(request.jwtPayload!.userId, new Date()));
  });

  /* The digest cron. Separate from the match sweep because they are different channels with
     different preconditions: this one needs VAPID keys and a live device, that one needs a verified
     address and an unsubscribe origin, and a deployment can easily have one and not the other. */
  const handleDigest = async (request: FastifyRequest, reply: FastifyReply) => {
    if (!isCronConfigured() || !isCronAuthorized(request)) {
      return reply.status(401).send({ error: 'Unauthorized' });
    }
    const configuration = pushConfiguration();
    if (!configuration.ok) {
      return reply.status(503).send({
        error: configuration.missing === 'vapid_keys'
          ? 'VAPID keys are not configured, so no push notification can be signed'
          : 'VAPID_SUBJECT is not set to a mailto: or https: URL',
        missing: configuration.missing,
      });
    }
    return reply.status(200).send(await runDigestSweep(new Date(), MATCH_SWEEP_ACCOUNT_LIMIT, request.log));
  };
  fastify.get('/internal/activity-digest', handleDigest);
  fastify.post('/internal/activity-digest', handleDigest);
}
