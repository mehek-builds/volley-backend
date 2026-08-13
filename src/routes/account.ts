import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { eq, inArray } from 'drizzle-orm';
import { db } from '../db/index';
import {
  users,
  profiles,
  experience_bank,
  application_profile,
  generated_resumes,
  outreach_events,
  autofill_events,
  usage_counters,
  email_verification_codes,
  application_email_aliases,
  application_email_messages,
} from '../db/schema';
import { requireAuth } from '../middleware/auth';
import { specWithoutDocumentPointers } from '../lib/documentStore';
import { deleteBlobsForUser, mintDownloadToken } from '../lib/resumeAccess';
import { apiBaseFor } from '../lib/apiBase';
import { decryptRow } from './applicationProfile';
import { selectApplicationProfileRow } from '../lib/applicationFacts';
import { selectApplicationEmailMessagesForUser } from '../lib/applicationEmail';
import { deleteAnalyticsProfile } from '../lib/serverAnalytics';

// The privacy policy promises the student can export or delete everything we hold. Until now
// nothing here backed that claim: there was no delete path in the codebase at all, so the only
// honest options were to build this or to stop making the promise. These are the endpoints
// that make the page true.

export async function accountRoutes(fastify: FastifyInstance) {
  // GET /account/export - everything we store about the caller, as one JSON document.
  fastify.get('/account/export', { preHandler: requireAuth }, async (request: FastifyRequest, reply: FastifyReply) => {
    const userId = request.jwtPayload!.userId;

    const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
    if (!user) return reply.status(404).send({ error: 'Account not found' });

    const [profile] = await db.select().from(profiles).where(eq(profiles.user_id, userId)).limit(1);
    // Tolerant read (lib/applicationFacts.ts): an export must not 500 during the window where
    // this code is deployed and the facts migration has not been run yet.
    const appProfile = await selectApplicationProfileRow(userId);
    const bank = await db.select().from(experience_bank).where(eq(experience_bank.user_id, userId));
    const resumes = await db.select().from(generated_resumes).where(eq(generated_resumes.user_id, userId));
    const outreach = await db.select().from(outreach_events).where(eq(outreach_events.user_id, userId));
    const fills = await db.select().from(autofill_events).where(eq(autofill_events.user_id, userId));
    const applicationEmailAliases = await db.select().from(application_email_aliases).where(eq(application_email_aliases.user_id, userId));
    // Tolerant read (lib/applicationEmail.ts), for the same reason as the line above: this was a
    // bare select, and a bare select asks for every column the schema declares. One added column
    // that the database has not got yet turns the whole export into a 500 for every user.
    const applicationEmailMessages = await selectApplicationEmailMessagesForUser(userId);
    // usage_counters has no FK to users (it is keyed by a plain string so pre-auth endpoints can
    // rate-limit by email), so it has to be queried - and later deleted - by key explicitly. Both
    // keys: auth.ts rate-limits the pre-auth endpoints by EMAIL, so an export keyed only on the
    // user id would omit rows we hold about her.
    const counterKeys = request.jwtPayload!.email ? [userId, request.jwtPayload!.email] : [userId];
    const counters = await db
      .select()
      .from(usage_counters)
      .where(inArray(usage_counters.key, counterKeys));

    const base = apiBaseFor(request);

    return reply.status(200).send({
      exported_at: new Date().toISOString(),
      account: user,
      resume_profile: profile ?? null,
      // Decrypted deliberately: these columns are encrypted at rest, but this is the owner
      // asking for their own copy, over an authed request.
      application_profile: appProfile ? decryptRow(appProfile) : null,
      experience_bank: bank,
      generated_resumes: resumes.map((row) => ({
        ...row,
        /* THE ROW IS SPREAD WHOLE, WHICH IS WHY THE SPEC IS OVERRIDDEN AFTER IT.
         *
         * An export is every column of every application, so it picks up a new jsonb field the day
         * that field is written and without a line of this file changing: it began shipping
         * _documents.transcript.object_key, for every application with an attachment, as soon as
         * attachments existed. A Blob object is written `access: 'public'` because that is the only
         * mode the SDK has, so the key plus the store's stable base URL is permanent
         * unauthenticated access to the file, and an export is a JSON document a student is
         * expected to save, mail to herself and hand to whoever asks for it.
         *
         * The override has to come AFTER the spread or the raw spec wins and the strip is
         * decoration. That ordering is asserted in documentResponseContract.test.ts, because it is
         * a one-line move away from being wrong and looking right.
         *
         * She loses nothing by it: the file itself is not in the export either way, and what the
         * spec still records is that a transcript was attached, under what name and when. */
        spec: specWithoutDocumentPointers(row.spec),
        // Links expire (DOWNLOAD_TOKEN_TTL_MS), and files past the retention window are already
        // gone, so this 404s rather than resolving. Called out in `notes` so an empty download
        // does not read as data loss.
        download_url: `${base}/resume/download?t=${mintDownloadToken(userId, row.resume_object_key)}`,
      })),
      outreach_events: outreach,
      autofill_events: fills,
      application_email_aliases: applicationEmailAliases,
      application_email_messages: applicationEmailMessages,
      usage_counters: counters,
      notes: {
        generated_resume_files:
          'download_url links are valid for one hour from this export. Resume files older than the retention window stated in the privacy policy have already been deleted and their links will 404; the tailoring record above is kept.',
        contacts:
          'Contacts and verified email addresses are stored per company, not per person, and are shared across everyone who looks up that company. They are not part of your account and are not included here or removed on deletion. Which contacts YOU were shown and drafted to is in outreach_events.',
        learning_signals:
          'Anonymous outcome rows (which persona/template performed well) are retained with the link to your account removed, so they cannot be traced back to you.',
      },
    });
  });

  // DELETE /account - irreversible. Requires the caller to echo their own email in the body:
  // a bare authed DELETE is one mis-wired client away from destroying an account by accident,
  // and there is no undo behind this.
  const deleteSchema = z.object({ confirm_email: z.string().min(1).optional(), confirm_guest: z.literal('DELETE').optional() });

  fastify.delete('/account', { preHandler: requireAuth }, async (request: FastifyRequest, reply: FastifyReply) => {
    const userId = request.jwtPayload!.userId;
    const email = request.jwtPayload!.email;

    const parsed = deleteSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'Send account confirmation to continue' });
    }
    if (request.jwtPayload!.isGuest && parsed.data.confirm_guest !== 'DELETE') {
      return reply.status(400).send({ error: 'Send { confirm_guest: "DELETE" } to confirm' });
    }
    if (!request.jwtPayload!.isGuest && (!email || parsed.data.confirm_email?.trim().toLowerCase() !== email.toLowerCase())) {
      return reply.status(400).send({ error: 'confirm_email does not match your account email' });
    }

    // Blobs FIRST, and abort if they fail. generated_resumes cascades on users.id, so deleting
    // the user row destroys resume_object_key - the only pointer we have to these files. Doing
    // the DB first and the storage second would, on any storage hiccup, permanently strand
    // public PII PDFs with nothing left to find them by. Leaving the account intact and
    // returning an error is the recoverable failure; the other order is not.
    let deletedFiles: number;
    try {
      deletedFiles = await deleteBlobsForUser(userId);
    } catch (err) {
      fastify.log.error({ err, userId }, 'account deletion aborted: could not delete resume files');
      return reply.status(500).send({
        error: 'Could not delete your stored resume files, so nothing was deleted. Please retry.',
      });
    }

    try {
      // Neither of these has an FK to users, so the cascade does not reach them.
      //
      // BOTH keys, not just the user id. usage_counters.key is a plain string precisely so the
      // pre-auth endpoints can rate-limit before a user id exists, and auth.ts does exactly that:
      // `allowHourly(email, ...)` for session/request-code/verify-code. Deleting only the userId
      // rows left every one of those keyed by her email address, tying her address to a deleted
      // account forever, with nothing else in the codebase that would ever purge them.
      const counterKeys = email ? [userId, email] : [userId];
      await db.delete(usage_counters).where(inArray(usage_counters.key, counterKeys));
      if (email) await db.delete(email_verification_codes).where(eq(email_verification_codes.email, email));
      // Cascades to profiles, application_profile, experience_bank, generated_resumes,
      // application email aliases, routed application email, outreach_events and autofill_events;
      // learning_signals is onDelete:'set null', which
      // anonymizes those aggregate rows rather than keeping them tied to a deleted account.
      await db.delete(users).where(eq(users.id, userId));
    } catch (err) {
      fastify.log.error({ err, userId }, 'account deletion failed after resume files were deleted');
      return reply.status(500).send({ error: 'Could not delete your account. Please contact support.' });
    }

    /* The privacy policy promises the PostHog profile goes too.
     *
     * Deliberately AFTER the account row is gone and deliberately not able to
     * fail the request: the destructive, irreversible part has already
     * succeeded, and returning 500 here would tell someone their deletion
     * failed when their data is in fact deleted. A profile that outlives its
     * account is a promise to fix, not a reason to alarm the person who just
     * asked to leave. Failures are logged loudly instead.
     *
     * Awaited for the same serverless reason as everywhere else: this handler
     * resolves at response flush and the container may freeze immediately
     * after, so un-awaited cleanup would simply not happen. */
    const analyticsDeleted = await deleteAnalyticsProfile(userId, fastify.log);

    fastify.log.info({ userId, deletedFiles, analyticsDeleted }, 'account deleted at user request');
    return reply.status(200).send({ deleted: true, resume_files_deleted: deletedFiles });
  });
}
