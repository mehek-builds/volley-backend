import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { eq, sql } from 'drizzle-orm';
import { db } from '../db/index';
import { generated_resumes, users } from '../db/schema';
import { readApplicationReview } from '../lib/applicationReview';
import { isCronAuthorized, isCronConfigured } from '../lib/cronAuth';
import { sendEmail } from '../lib/email';
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

type StallCarrier = StallRow & NudgeApplication & { userId: string; email: string; firstName?: string };

/* Selected in SQL by the presence of the stall key rather than filtered in Node, so a growing
   history does not mean loading every application ever generated to find a handful of them. */
async function loadStalls(): Promise<StallCarrier[]> {
  const rows = await db
    .select({
      spec: generated_resumes.spec,
      jobContext: generated_resumes.job_context,
      userId: generated_resumes.user_id,
      email: users.email,
    })
    .from(generated_resumes)
    .innerJoin(users, eq(users.id, generated_resumes.user_id))
    .where(sql`${generated_resumes.spec}->'_review'->'stall' is not null`);

  const carriers: StallCarrier[] = [];
  for (const row of rows) {
    const review = readApplicationReview(row.spec);
    if (!review?.stall) continue;
    // A row with no email cannot be nudged and must not be dropped from the METRICS either, so it
    // carries an empty address and the send loop skips it.
    const context = (row.jobContext ?? {}) as { company?: string; role?: string };
    carriers.push({
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

export async function captchaStallRoutes(fastify: FastifyInstance) {
  /* The answer to "is this a two-second annoyance or the reason applications never get sent".
     Read-only, and reports the denominator alongside the rate so a small sample cannot be mistaken
     for a finding. */
  fastify.get('/internal/captcha-stall-metrics', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!isCronConfigured() || !isCronAuthorized(request)) return reply.status(401).send({ error: 'Unauthorized' });
    const stalls = await loadStalls();
    const [counted] = await db.select({ total: sql<number>`count(*)::int` }).from(generated_resumes);
    const summary = summarizeStalls(stalls);
    return reply.send({
      ...summary,
      rate: stallRate(summary.stalled, counted?.total ?? 0),
      generated_at: new Date().toISOString(),
    });
  });

  /* The last resort, after the badge and the dashboard have both failed to get someone back. */
  fastify.post('/internal/captcha-stall-nudge', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!isCronConfigured() || !isCronAuthorized(request)) return reply.status(401).send({ error: 'Unauthorized' });
    const from = process.env.OUTBOUND_FROM_EMAIL;
    if (!from) return reply.status(503).send({ error: 'Outbound email is not configured' });

    const due = nudgeableStalls(await loadStalls(), Date.now(), NUDGE_AFTER_MS);

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
          html: nudgeHtml(listed, oldestFirst[0]!.firstName),
        });
        sent += 1;
      } catch (error) {
        // One person's bounce must not stop everyone else's nudge.
        failed += 1;
        fastify.log.warn({ err: error }, 'CAPTCHA stall nudge failed for one recipient');
      }
    }

    return reply.send({ ok: true, due: due.length, recipients: byUser.size, sent, failed });
  });
}
