import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
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
} from '../db/schema';
import { requireAuth } from '../middleware/auth';
import { deleteResumeBlobsForUser, mintDownloadToken, EXPORT_TOKEN_TTL_MS } from '../lib/resumeAccess';
import { apiBaseFor } from '../lib/apiBase';
import { decryptRow } from './applicationProfile';

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
    const [appProfile] = await db
      .select()
      .from(application_profile)
      .where(eq(application_profile.user_id, userId))
      .limit(1);
    const bank = await db.select().from(experience_bank).where(eq(experience_bank.user_id, userId));
    const resumes = await db.select().from(generated_resumes).where(eq(generated_resumes.user_id, userId));
    const outreach = await db.select().from(outreach_events).where(eq(outreach_events.user_id, userId));
    const fills = await db.select().from(autofill_events).where(eq(autofill_events.user_id, userId));
    // usage_counters has no FK to users (it is keyed by a plain string so pre-auth endpoints can
    // rate-limit by email), so it has to be queried - and later deleted - by key explicitly.
    const counters = await db.select().from(usage_counters).where(eq(usage_counters.key, userId));

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
        // Links expire (EXPORT_TOKEN_TTL_MS), and files past the retention window are already
        // gone, so this 404s rather than resolving. Called out in `notes` so an empty download
        // does not read as data loss.
        download_url: `${base}/resume/download?t=${mintDownloadToken(userId, row.resume_object_key, {
          ttlMs: EXPORT_TOKEN_TTL_MS,
        })}`,
      })),
      outreach_events: outreach,
      autofill_events: fills,
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
  const deleteSchema = z.object({ confirm_email: z.string().min(1) });

  fastify.delete('/account', { preHandler: requireAuth }, async (request: FastifyRequest, reply: FastifyReply) => {
    const userId = request.jwtPayload!.userId;
    const email = request.jwtPayload!.email;

    const parsed = deleteSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'Send { confirm_email } matching your account email to confirm' });
    }
    if (parsed.data.confirm_email.trim().toLowerCase() !== email.toLowerCase()) {
      return reply.status(400).send({ error: 'confirm_email does not match your account email' });
    }

    // Blobs FIRST, and abort if they fail. generated_resumes cascades on users.id, so deleting
    // the user row destroys resume_object_key - the only pointer we have to these files. Doing
    // the DB first and the storage second would, on any storage hiccup, permanently strand
    // public PII PDFs with nothing left to find them by. Leaving the account intact and
    // returning an error is the recoverable failure; the other order is not.
    let deletedFiles: number;
    try {
      deletedFiles = await deleteResumeBlobsForUser(userId);
    } catch (err) {
      fastify.log.error({ err, userId }, 'account deletion aborted: could not delete resume files');
      return reply.status(500).send({
        error: 'Could not delete your stored resume files, so nothing was deleted. Please retry.',
      });
    }

    try {
      // Neither of these has an FK to users, so the cascade does not reach them.
      await db.delete(usage_counters).where(eq(usage_counters.key, userId));
      await db.delete(email_verification_codes).where(eq(email_verification_codes.email, email));
      // Cascades to profiles, application_profile, experience_bank, generated_resumes,
      // outreach_events and autofill_events; learning_signals is onDelete:'set null', which
      // anonymizes those aggregate rows rather than keeping them tied to a deleted account.
      await db.delete(users).where(eq(users.id, userId));
    } catch (err) {
      fastify.log.error({ err, userId }, 'account deletion failed after resume files were deleted');
      return reply.status(500).send({ error: 'Could not delete your account. Please contact support.' });
    }

    fastify.log.info({ userId, deletedFiles }, 'account deleted at user request');
    return reply.status(200).send({ deleted: true, resume_files_deleted: deletedFiles });
  });
}
