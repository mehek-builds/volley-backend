import { randomUUID } from 'node:crypto';
import { put } from '@vercel/blob';
import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db/index';
import { generated_resumes } from '../db/schema';
import { readApplicationReview, type ApplicationReviewState } from './applicationReview';
import { acknowledgementBindsAudit, packetAuditContentIdentity, type PacketAudit } from './packetAudit';
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
 * WHAT THE APPLICANT IS NOT ASKED, AND WHAT SHE STILL HAS TO HAVE SAID. A rebuilt packet sends
 * without re-approval, which is Mehek's explicit call (2026-08-11) and is what
 * restoredPacketAcknowledgement below implements: an acknowledgement she already gave is CARRIED
 * FORWARD onto the new file, because every input to the render is frozen on the row and the audit
 * re-issued here still says the same thing about the packet. `source` records that the carried
 * record was machine-written, because the alternative is a corpus where "a human checked this" and
 * "a machine rebuilt this" are indistinguishable forever.
 *
 * A restore CANNOT CREATE ONE. Where no acknowledgement existed, none is written and the packet
 * comes out of the rebuild exactly as sendable as it went in - which is not sendable, because the
 * acknowledgement is the record that authorizes the send. Writing one on a packet nobody approved
 * would collapse the two-step gate into whichever step happened to run first, and the first step is
 * routinely a review that authorizes nothing.
 *
 * The new file starts its own 30-day clock, which is the same thing a regenerate does and keeps the
 * published promise true: the old file was deleted on time, and this is a new one.
 */

/**
 * What the caller is doing, stated by the caller, in the type.
 *
 * NOT the HTTP verb, which is what the first version of this rule was really keyed on and why it
 * was wrong: POST /applications/:id/packet-audit is a POST that renders a packet for the applicant
 * to LOOK at, and it authorized nothing. A caller that is about to put this packet in front of an
 * employer says so here; every other caller says review_only and gets a rebuilt file with no
 * approval attached to it.
 *
 * Not a boolean, deliberately. `true` reads as "yes, restore" at the call site and says nothing
 * about authority, so the distinction that matters would live in a comment again.
 */
export type PacketRestoreAuthority =
  /** This call is authorizing a send of this packet now: the runner's prepare and submit, the
   *  extension start precheck, submit-request, final approval, the security-code finish, and the
   *  manual handoff that releases the employer's URL. */
  | 'authorizing_send'
  /** This call is showing the packet to its owner, or refreshing what she is shown. It may rebuild
   *  the file she asked to see; it may not hand a rebuilt file an approval. */
  | 'review_only';

type PacketAcknowledgement = NonNullable<ApplicationReviewState['packet_audit_acknowledgement']>;

/**
 * The acknowledgement a rebuilt packet is allowed to carry, or null for "write nothing".
 *
 * Exported so the decision is testable on its own, because it is the whole gate: everything
 * downstream of the restore reads the acknowledgement and compares it to the current audit, so
 * whatever this function returns is what "a human approved this packet" means for the rest of the
 * system.
 *
 * Three conditions, all required, and each one closes a different way of inventing approval:
 *   1. The caller is authorizing a send. A review may rebuild a file; it may not decide that a
 *      packet is ready to go to an employer.
 *   2. An acknowledgement existed AND bound the pre-restore audit exactly, on the same comparison
 *      the send gate makes. An acknowledgement that was already stale is not approval of anything,
 *      and re-binding it to the new file would launder it into approval of something newer.
 *   3. The re-issued audit says the same thing about the packet as the one she approved, on
 *      everything except which file carries it. Bytes cannot be compared - a rebuild differs from
 *      its own source by construction, see packetAuditContentIdentity - and the content can move
 *      even from a frozen row, because scoring reads the calendar. An audit that now reads
 *      differently is one she has not seen.
 */
export function restoredPacketAcknowledgement(input: {
  authority: PacketRestoreAuthority;
  priorAudit: PacketAudit | undefined;
  priorAcknowledgement: PacketAcknowledgement | undefined;
  restoredAudit: PacketAudit;
  acknowledgedAt: string;
}): PacketAcknowledgement | null {
  if (input.authority !== 'authorizing_send') return null;
  if (!input.priorAudit || !input.priorAcknowledgement) return null;
  if (!acknowledgementBindsAudit(input.priorAcknowledgement, input.priorAudit)) return null;
  if (packetAuditContentIdentity(input.priorAudit) !== packetAuditContentIdentity(input.restoredAudit)) return null;
  return {
    ownerSha256: input.restoredAudit.bindings.ownerSha256,
    applicationId: input.restoredAudit.bindings.applicationId,
    audit_digest: input.restoredAudit.audit_digest,
    packet_version: input.restoredAudit.packet_version,
    pdfSha256: input.restoredAudit.bindings.pdf.sha256,
    pdfSizeBytes: input.restoredAudit.bindings.pdf.sizeBytes,
    acknowledged_at: input.acknowledgedAt,
    source: 'auto_restored',
  };
}

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
    /** What the caller is doing. See PacketRestoreAuthority: it decides whether an acknowledgement
        she already gave may travel to the rebuilt file, and it is required so that no call site can
        acquire that power by leaving an option out. */
    authority: PacketRestoreAuthority;
    resolveObjectUrl?: (key: string) => Promise<string | null>;
    /* INJECTED, NOT IMPORTED. packetAuditService is what calls this function, so a static import
       back into it would close a cycle. Required rather than defaulted for the same reason: there
       is no sensible default that does not reach across the cycle. */
    persistAudit: (row: ResumeRow) => Promise<{ audit: PacketAudit }>;
    /** The blob write, as a seam. Defaulted to @vercel/blob's put, so production is unchanged and a
        test can drive this function end to end against a real database without a network store. */
    putObject?: (key: string, bytes: Buffer) => Promise<{ pathname: string }>;
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
  const write = dependencies.putObject
    ?? ((key: string, payload: Buffer) => put(key, payload, { access: 'public', contentType: 'application/pdf' }));
  const blob = await write(objectKey, bytes);

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

  /* THE APPROVAL SHE ALREADY GAVE, OR NOTHING. Read off the PRE-restore review, which is the one
     that holds the audit she was shown and the acknowledgement she gave for it. */
  const carried = restoredPacketAcknowledgement({
    authority: dependencies.authority,
    priorAudit: review.packet_audit,
    priorAcknowledgement: review.packet_audit_acknowledgement,
    restoredAudit: audit,
    acknowledgedAt: new Date().toISOString(),
  });
  /* Nothing to carry, so nothing is written. The stale acknowledgement, if there is one, is left
     exactly as it is: it names the deleted file, so every gate downstream compares it against the
     re-issued audit and refuses, which is the same answer as deleting it and one fewer write. */
  if (!carried) return { restored: true, row: auditedRow, objectKey: blob.pathname };

  const nextReview: ApplicationReviewState = {
    ...auditedReview,
    packet_audit_acknowledgement: carried,
  };
  await db.update(generated_resumes).set({
    spec: sql`jsonb_set(coalesce(${generated_resumes.spec}, '{}'::jsonb), '{_review}', ${JSON.stringify(nextReview)}::jsonb, true)`,
  }).where(and(eq(generated_resumes.id, row.id), eq(generated_resumes.user_id, row.user_id)));

  const [final] = await db.select().from(generated_resumes)
    .where(eq(generated_resumes.id, row.id)).limit(1);
  return { restored: true, row: final ?? auditedRow, objectKey: blob.pathname };
}
