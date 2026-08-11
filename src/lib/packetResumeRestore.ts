import { randomUUID } from 'node:crypto';
import { put } from '@vercel/blob';
import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db/index';
import { generated_resumes } from '../db/schema';
import { readApplicationReview, type ApplicationReviewState } from './applicationReview';
import type { PacketAudit } from './packetAudit';
import { rerenderFrozenResume } from './packetDocumentRecovery';
import { createPdfGenerationBinding } from './pdfGenerationBinding';
import { PacketDocumentExpiredError, resolveBlobUrl } from './resumeAccess';

type ResumeRow = typeof generated_resumes.$inferSelect;

/**
 * The one sentence for a packet whose file aged out and could NOT be rebuilt.
 *
 * Lives here rather than in submissionRunner because the packet-audit layer needs it too, and the
 * runner importing the audit service means the constant cannot travel the other way.
 *
 * Reachable only when restoreExpiredPacketResume refuses. Measured 2026-08-11 that is 28 of 326
 * approvable packets, every one a row whose _contact carries neither an email nor a phone, which is
 * the population applications.ts already describes as curable only by regenerating. A rebuildable
 * packet never reaches this sentence; it is rebuilt and sent.
 */
/* THE CAUSE IS DESCRIBED AS USUAL, NOT AS CERTAIN. Three conditions reach this sentence: no reply
   route frozen on the resume, no content left in the spec, and a render whose page would not be
   sound. All 78 refusals measured across the whole corpus on 2026-08-11 were the first, so naming
   it helps, but stating it flatly would make the sentence a lie on the day one of the other two
   fires. Same discipline as the cause-neutral noSubmitControl wording in submissionRunner. The
   recovery is the same either way, so nothing is lost by not claiming more than is known. */
export const PACKET_EXPIRED_REASON =
  'The resume file for this application is no longer stored and Litos could not rebuild it from what is saved, so nothing was sent to the employer. Litos deletes the resumes it generates after 30 days, and a saved application with no email address or phone number on it cannot be remade, which is normally what has happened here. Regenerate this application and send it again.';

/**
 * Restoring the file a 30-day-old packet no longer has, so it can still be sent.
 *
 * WHY THIS IS NOT IN buildPacket, WHICH IS WHERE IT WAS FIRST WRITTEN. Every path that sends an
 * application passes a packet-audit gate BEFORE it assembles a packet: currentPacketAudit in
 * prepare(), currentAcknowledgedPacketAudit in submit(), and both call defaultPdfLoader, which
 * throws the moment resume_object_key resolves to nothing. buildPacket is never reached on an
 * expired packet, so a recovery living there could never run. The gate is the choke point, so the
 * restore has to happen before it.
 *
 * WHY IT PERSISTS INSTEAD OF REBUILDING IN MEMORY. renderResumePdf is NOT byte-deterministic:
 * pdfkit stamps CreationDate into the document, so two renders of the same spec one second apart
 * differ in sha256 while matching in length (measured, 22607 bytes both times). Three separate
 * records bind the exact bytes - _quality.pdfGenerationBinding.pdfSha256, packet_audit.bindings
 * .pdf.sha256, and packet_audit_acknowledgement.pdfSha256 - so an in-memory rebuild would have the
 * audit verifying one document and the employer receiving another. One render, written once, with
 * all three records re-issued against it, is the only shape that keeps those three agreeing.
 *
 * WHAT THE APPLICANT IS NOT ASKED. The acknowledgement is normally the record that a human looked
 * at these exact bytes. Re-issuing it here writes that record without anyone looking, which is
 * Mehek's explicit call (2026-08-11): a rebuilt packet sends without re-approval. The content is
 * unchanged by construction, since every input to the render is frozen on the row, so what the
 * applicant approved and what the employer receives are the same document. `source` records that
 * the acknowledgement was machine-written anyway, because the alternative is a corpus where
 * "a human checked this" and "a machine rebuilt this" are indistinguishable forever.
 *
 * The new file starts its own 30-day clock, which is the same thing a regenerate does and keeps the
 * published promise true: the old file was deleted on time, and this is a new one.
 */
export type PacketResumeRestoreOutcome =
  /** The file was there. Nothing was rebuilt, written, or re-audited. */
  | { restored: false; row: ResumeRow }
  /** Rebuilt, stored, and re-bound. `row` is re-read and safe to hand to the audit. */
  | { restored: true; row: ResumeRow; objectKey: string }
  /**
   * The file is gone and cannot be rebuilt: no reply route frozen on the resume, no content left in
   * the spec, or the render refused. Measured 2026-08-11, this is 28 of 326 approvable packets, all
   * of them the pre-contact-resolution rows that already could not be sent meaningfully.
   */
  | { restored: false; row: ResumeRow; unrecoverable: PacketDocumentExpiredError };

export async function restoreExpiredPacketResume(
  row: ResumeRow,
  dependencies: {
    resolveObjectUrl?: (key: string) => Promise<string | null>;
    /* INJECTED, NOT IMPORTED. packetAuditService is what calls this function, so a static import
       back into it would close a cycle. Required rather than defaulted for the same reason: there
       is no sensible default that does not reach across the cycle. */
    persistAudit: (row: ResumeRow) => Promise<{ audit: PacketAudit }>;
  },
): Promise<PacketResumeRestoreOutcome> {
  const resolve = dependencies.resolveObjectUrl ?? resolveBlobUrl;
  /* The ONLY trigger is an object key that resolves to nothing. A key that resolves and then fails
     to download is a live storage fault, and rebuilding on that would quietly replace a file that
     still exists, restarting its retention clock for a transient 500. */
  if (!row.resume_object_key || await resolve(row.resume_object_key)) {
    return { restored: false, row };
  }

  const review = readApplicationReview(row.spec);
  if (!review) return { restored: false, row };

  let bytes: Buffer;
  try {
    bytes = await rerenderFrozenResume({
      spec: row.spec,
      jdText: review.jd_text ?? '',
      role: review.role,
    });
  } catch (error) {
    if (error instanceof PacketDocumentExpiredError) return { restored: false, row, unrecoverable: error };
    return { restored: false, row, unrecoverable: new PacketDocumentExpiredError('resume') };
  }

  const contact = ((row.spec as Record<string, unknown>)?._contact ?? {}) as Record<string, unknown>;
  const resumeEmail = String(contact.email ?? '').trim().toLowerCase();
  /* hasCurrentGenerationBinding returns false on an empty resume email no matter what the binding
     says, so a packet without one can never pass the audit and must not be given a fresh file. */
  if (!resumeEmail) return { restored: false, row, unrecoverable: new PacketDocumentExpiredError('resume') };

  const objectKey = `users/${row.user_id}/resumes/${row.id}-restored-${randomUUID()}.pdf`;
  const blob = await put(objectKey, bytes, { access: 'public', contentType: 'application/pdf' });

  const quality = ((row.spec as Record<string, unknown>)?._quality ?? {}) as Record<string, unknown>;
  const nextQuality = {
    ...quality,
    pdfGenerationBinding: createPdfGenerationBinding(row.spec, blob.pathname, bytes, resumeEmail),
    /* Kept beside the binding rather than on _review, because it is a fact about how this FILE came
       to exist, and _quality is where the other facts about the rendered document already live. */
    restoredFromSpecAt: new Date().toISOString(),
  };

  /* Guarded on the OLD key, so two runners racing the same expired packet cannot both win: the
     second update matches nothing, and that run re-reads a row whose file another run already
     restored. Its orphaned blob ages out on the normal 30-day window. */
  const updated = await db.update(generated_resumes).set({
    resume_object_key: blob.pathname,
    spec: sql`jsonb_set(coalesce(${generated_resumes.spec}, '{}'::jsonb), '{_quality}', ${JSON.stringify(nextQuality)}::jsonb, true)`,
  }).where(and(
    eq(generated_resumes.id, row.id),
    eq(generated_resumes.user_id, row.user_id),
    eq(generated_resumes.resume_object_key, row.resume_object_key),
  )).returning({ id: generated_resumes.id });

  const [refreshed] = await db.select().from(generated_resumes)
    .where(eq(generated_resumes.id, row.id)).limit(1);
  if (!refreshed) return { restored: false, row };
  if (updated.length !== 1) {
    /* Lost the race. Another runner restored this packet between the resolve above and the update,
       so the row now carries ITS file and ITS re-issued records. Returning that row is correct and
       returning ours would not be: our blob is bound to nothing. Reported as restored only if the
       key actually moved, so a lost race is never mistaken for a no-op on an unchanged row. */
    return refreshed.resume_object_key !== row.resume_object_key
      ? { restored: true, row: refreshed, objectKey: refreshed.resume_object_key }
      : { restored: false, row: refreshed };
  }

  /* Re-issued in dependency order: the audit reads the generation binding written above, and the
     acknowledgement reads the audit written here. Doing these in one place is what stops a packet
     existing in the half-state where its file is new and its audit still describes the deleted one. */
  const { audit } = await dependencies.persistAudit(refreshed);

  const audited = await db.select().from(generated_resumes)
    .where(eq(generated_resumes.id, row.id)).limit(1);
  const auditedRow = audited[0] ?? refreshed;
  const auditedReview = readApplicationReview(auditedRow.spec);
  if (!auditedReview) return { restored: true, row: auditedRow, objectKey: blob.pathname };

  const nextReview: ApplicationReviewState = {
    ...auditedReview,
    packet_audit_acknowledgement: {
      ownerSha256: audit.bindings.ownerSha256,
      applicationId: audit.bindings.applicationId,
      audit_digest: audit.audit_digest,
      packet_version: audit.packet_version,
      pdfSha256: audit.bindings.pdf.sha256,
      pdfSizeBytes: audit.bindings.pdf.sizeBytes,
      acknowledged_at: new Date().toISOString(),
      source: 'auto_restored',
    },
  };
  await db.update(generated_resumes).set({
    spec: sql`jsonb_set(coalesce(${generated_resumes.spec}, '{}'::jsonb), '{_review}', ${JSON.stringify(nextReview)}::jsonb, true)`,
  }).where(and(eq(generated_resumes.id, row.id), eq(generated_resumes.user_id, row.user_id)));

  const [final] = await db.select().from(generated_resumes)
    .where(eq(generated_resumes.id, row.id)).limit(1);
  return { restored: true, row: final ?? auditedRow, objectKey: blob.pathname };
}
