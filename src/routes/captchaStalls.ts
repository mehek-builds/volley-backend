import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { and, eq, gte, sql } from 'drizzle-orm';
import { db } from '../db/index';
import { generated_resumes, users } from '../db/schema';
import { readApplicationReview } from '../lib/applicationReview';
import { isCronAuthorized, isCronConfigured } from '../lib/cronAuth';
import { emailSender, sendEmail } from '../lib/email';
import { nudgeableStalls, stallRate, summarizeStalls, type StallRow } from '../lib/stallMetrics';
import { nudgeHtml, nudgeSubject, type NudgeApplication } from '../lib/stallNudge';

/**
 * Reading the stall record, and acting on the part of it that has gone stale.
 *
 * Both endpoints are cron-authorised rather than user-authorised: one reports across all accounts
 * and the other sends mail, and neither is something a signed-in client should be able to trigger.
 */

/** Hours before a stall is old enough to be worth an email. Deliberately long: see stallNudge. */
const NUDGE_AFTER_MS = 12 * 60 * 60 * 1000;

/** One email per person per run, however many applications are waiting. */
const MAX_APPLICATIONS_PER_EMAIL = 5;

type StallCarrier = StallRow & NudgeApplication & { applicationId: string; userId: string; email: string };

/* The rate's denominator starts here, not at the beginning of time.
 *
 * The numerator can only contain applications generated after stall instrumentation shipped, so
 * dividing by every resume ever created would report a rate far below the real one - exactly the
 * "a number that hides its population" failure stallRate was written to prevent. */
const INSTRUMENTATION_SHIPPED_AT = new Date('2026-08-04T00:00:00.000Z');

/* Selected in SQL by the presence of the stall key rather than filtered in Node, so a growing
   history does not mean loading every application ever generated to find a handful of them. */
async function loadStalls(options: { verifiedOnly?: boolean } = {}): Promise<StallCarrier[]> {
  const rows = await db
    .select({
      id: generated_resumes.id,
      spec: generated_resumes.spec,
      jobContext: generated_resumes.job_context,
      userId: generated_resumes.user_id,
      email: users.email,
    })
    .from(generated_resumes)
    .innerJoin(users, eq(users.id, generated_resumes.user_id))
    .where(and(
      sql`${generated_resumes.spec}->'_review'->'stall' is not null`,
      // Bounded to the instrumented window. A stall is closed and never deleted, so resolved ones
      // accumulate forever and would otherwise be re-read in full on every run.
      gte(generated_resumes.created_at, INSTRUMENTATION_SHIPPED_AT),
      // Mail only goes to an address someone confirmed they own. Metrics are unfiltered.
      ...(options.verifiedOnly ? [eq(users.email_verified, true)] : []),
    ));

  const carriers: StallCarrier[] = [];
  for (const row of rows) {
    const review = readApplicationReview(row.spec);
    if (!review?.stall) continue;
    // A row with no email cannot be nudged and must not be dropped from the METRICS either, so it
    // carries an empty address and the send loop skips it.
    const context = (row.jobContext ?? {}) as { company?: string; role?: string };
    carriers.push({
      applicationId: row.id,
      userId: row.userId,
      email: row.email ?? '',
      company: context.company?.trim() || 'this company',
      role: context.role?.trim() || 'this role',
      portalUrl: review.portal_url,
      atsName: review.ats_name,
      stall: review.stall,
    });
  }
  return carriers;
}

/* Written through a targeted jsonb_set rather than a read-modify-write of the whole review: the
   only field changing is this one, and re-writing the blob would clobber anything a concurrent run
   had just recorded. */
async function markNudged(applicationIds: readonly string[], at: string): Promise<void> {
  for (const id of applicationIds) {
    await db.update(generated_resumes)
      .set({ spec: sql`jsonb_set(${generated_resumes.spec}, '{_review,stall,nudged_at}', ${JSON.stringify(at)}::jsonb, true)` })
      .where(eq(generated_resumes.id, id));
  }
}

export async function captchaStallRoutes(fastify: FastifyInstance) {
  /* The answer to "is this a two-second annoyance or the reason applications never get sent".
     Read-only, and reports the denominator alongside the rate so a small sample cannot be mistaken
     for a finding. */
  fastify.get('/internal/captcha-stall-metrics', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!isCronConfigured() || !isCronAuthorized(request)) return reply.status(401).send({ error: 'Unauthorized' });
    const stalls = await loadStalls();
    const [counted] = await db
      .select({ total: sql<number>`count(*)::int` })
      .from(generated_resumes)
      .where(gte(generated_resumes.created_at, INSTRUMENTATION_SHIPPED_AT));
    const summary = summarizeStalls(stalls);
    return reply.send({
      ...summary,
      rate: stallRate(summary.stalled, counted?.total ?? 0),
      // Returned so the reader can see which population the rate is over rather than assuming
      // "all applications ever".
      population_since: INSTRUMENTATION_SHIPPED_AT.toISOString(),
      generated_at: new Date().toISOString(),
    });
  });

  /* The last resort, after the badge and the dashboard have both failed to get someone back. */
  /* GET, because Vercel Cron issues GET only - cronAuth's own comment records a daily job that
     silently never ran for exactly this reason. Not yet scheduled in vercel.json: Hobby is
     daily-only and the right cadence should come from the first read of the metrics. */
  fastify.get('/internal/captcha-stall-nudge', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!isCronConfigured() || !isCronAuthorized(request)) return reply.status(401).send({ error: 'Unauthorized' });
    // emailSender(), not a bespoke env var. It validates the mailbox and normalises the display
    // name, so a retired brand cannot reach a student's inbox - the reason every other sender in
    // this repo goes through it.
    let from: string;
    try {
      from = emailSender();
    } catch {
      return reply.status(503).send({ error: 'Outbound email is not configured' });
    }

    const due = nudgeableStalls(await loadStalls({ verifiedOnly: true }), Date.now(), NUDGE_AFTER_MS);

    // Grouped per person BEFORE sending. Five waiting applications is one email about five things,
    // never five emails - the surest way to make someone mute the sender is to let the volume scale
    // with how far behind they are.
    const byUser = new Map<string, StallCarrier[]>();
    for (const row of due) {
      const existing = byUser.get(row.userId);
      if (existing) existing.push(row);
      else byUser.set(row.userId, [row]);
    }

    let sent = 0;
    let failed = 0;
    for (const [, applications] of byUser) {
      const oldestFirst = [...applications].sort((left, right) => (
        left.stall.stalled_at < right.stall.stalled_at ? -1 : 1
      ));
      // Skipped rather than attempted: a row with no address can still be counted by the metrics,
      // but there is nowhere to send this.
      if (!oldestFirst[0]?.email) continue;
      const listed = oldestFirst.slice(0, MAX_APPLICATIONS_PER_EMAIL);
      try {
        await sendEmail({
          from,
          to: [oldestFirst[0]!.email],
          subject: nudgeSubject(listed),
          // Resend requires a text part; the HTML is the one that renders, per the standing rule.
          text: `${listed.length} of your applications are waiting on a human-verification check. Open your Litos dashboard to finish them.`,
          html: nudgeHtml(listed),
        });
        sent += 1;
        // Recorded only AFTER the send is accepted, so a failure retries next run rather than
        // silently consuming the one nudge this stall gets.
        await markNudged(listed.map((item) => item.applicationId), new Date().toISOString());
      } catch (error) {
        // One person's bounce must not stop everyone else's nudge.
        failed += 1;
        fastify.log.warn({ err: error }, 'CAPTCHA stall nudge failed for one recipient');
      }
    }

    return reply.send({ ok: true, due: due.length, recipients: byUser.size, sent, failed });
  });
}
