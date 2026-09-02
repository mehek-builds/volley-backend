import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db/index';
import { generated_resumes } from '../db/schema';
import {
  readApplicationReview,
  type ApplicationReviewQuestion,
  type ApplicationReviewState,
} from './applicationReview';
import {
  acknowledgementBindsAudit,
  packetAuditContentIdentity,
  packetAuditIsSubmissionReady,
  packetAuditSha256,
  packetVisibleQuestions,
  type PacketAudit,
  packetAuditContentIdentityWithoutDelivery,
} from './packetAudit';
import { rerenderFrozenResume } from './packetDocumentRecovery';
import { createPdfGenerationBinding } from './pdfGenerationBinding';
import { putObject as storePutObject } from './objectStorage';
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
 * audit verifying one document and the employer receiving another. One render is written once,
 * the generation binding and audit are re-issued, and any acknowledgement that names the deleted
 * bytes remains stale until the applicant reviews the fresh delivery-bound packet.
 *
 * WHAT THE APPLICANT IS ASKED. A normal rebuild changes the PDF bytes, and the employer-delivery
 * binding hashes those exact bytes. This layer cannot rebuild that binding because it does not
 * construct the channel-specific packet, so changed bytes require the packet-audit route to build
 * a fresh exact delivery binding and the applicant to acknowledge it. A prior acknowledgement may
 * carry only in the unusual case where the stored object key changes but the PDF bytes and every
 * current audit and delivery binding remain exact. `source` records that exceptional carry as a
 * machine rewrite rather than a new human review.
 *
 * A restore CANNOT CREATE ONE. Where no acknowledgement existed, none is written. Where the PDF
 * bytes changed, both the obsolete acknowledgement and its employer-delivery binding are removed
 * before the replacement audit is created. Writing or rebinding either here would collapse the
 * two-step gate into whichever step happened to run first, and the first step is routinely a
 * review that authorizes nothing.
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
 *   3. Both audits carry the current employer-delivery binding. A legacy audit with no exhaustive
 *      delivery identity cannot authorize a later transport.
 *   4. The re-issued audit says the same thing about the packet as the one she approved, and the
 *      resume bytes are identical. The employer-delivery hash includes those bytes, but restore
 *      cannot rebuild that hash because it does not construct the exact channel packet. A normal
 *      PDF rerender changes its bytes, so it requires a fresh audit and acknowledgement.
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
  if (!packetAuditIsSubmissionReady(input.priorAudit)
    || !packetAuditIsSubmissionReady(input.restoredAudit)) return null;
  if (!acknowledgementBindsAudit(input.priorAcknowledgement, input.priorAudit)) return null;
  if (input.priorAudit.bindings.pdf.sha256 !== input.restoredAudit.bindings.pdf.sha256) return null;
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

/**
 * The acknowledgement a packet re-audited WITH THE CAPABILITIES DISCOVERY MEASURED may carry.
 *
 * The review card she approved on says, verbatim, "Litos will check the company's form first. If
 * the form has a cover-letter attachment, Litos writes one and attaches it." The audit she
 * acknowledged was built before that check, with both capability facts unknown; the discovery pass
 * then learned them, the delivery envelope moved, and every first approve of a form with no
 * questions parked on "this application changed after you approved". Measured 2026-09-01 on
 * TixTrack (teamtailor) and Cartesia (ashby): the acknowledged sha and the measured sha differed
 * by exactly the two capability facts, nothing she had looked at had moved, and the only way on was
 * a second identical approve.
 *
 * Same discipline as restoredPacketAcknowledgement, and deliberately narrower in one way and wider
 * in one way. Narrower: no authority argument, because the only caller is the runner's prepare,
 * which is authorizing a send by construction. Wider: the employer-delivery hash is set aside from
 * the identity comparison, and ONLY that hash; the caller has to have proven, with
 * deliveryDriftIsLitosLearnedOnly, that what moved it is a fact the form taught Litos after she
 * approved. Every other condition is the restore's: an acknowledgement existed and bound the prior
 * audit exactly, both audits carry the current delivery binding in the same mode (the channel and
 * runtime inside the hash are the caller's to pin, and deliveryDriftIsLitosLearnedOnly does), the
 * resume bytes are identical, and the re-issued audit says the same thing about the packet.
 *
 * THE SECOND THING A FORM TEACHES IS WHAT IT ASKS, and that is why this is no longer only about
 * capabilities. Measured in prod 2026-09-02 on four of the campaign's ten boards - Hudson River
 * Trading (greenhouse), Confluence (pinpoint), TixTrack (teamtailor), Apollo Research (lever) -
 * each parked after an approve on "This application changed after you approved the exact packet
 * Litos prepared. What changed: the questions this form asks, how Litos reaches this employer",
 * with no acknowledgement and no preview. Nothing she approved had moved on any of them: the
 * discovery pass had simply read the form more thoroughly than the inventory the approval was
 * taken against, and the delivery hash moved because it hashes the question rows. Litos reading
 * the same form better is not a change to what she approved, so the approval carries; what
 * discovery learned still reaches her as questions, and `learnedQuestions` below is what keeps
 * those two facts from being confused with each other.
 */
export function relearnedFormReadingAcknowledgement(input: {
  priorAudit: PacketAudit | undefined;
  priorAcknowledgement: PacketAcknowledgement | undefined;
  reissuedAudit: PacketAudit;
  acknowledgedAt: string;
  /* The two question sets, when this run learned the form asks more than the approval covered.
   * Absent means the sets are identical and the identity below compares them whole, which is the
   * capability-only carry exactly as it always was. */
  learnedQuestions?: {
    /** The rows the approval covered, byte-for-byte as it covered them. */
    acknowledged: readonly ApplicationReviewQuestion[];
    /** The full set the reissued audit bound: those same rows first, then what discovery learned. */
    reissued: readonly ApplicationReviewQuestion[];
  };
}): PacketAcknowledgement | null {
  if (!input.priorAudit || !input.priorAcknowledgement) return null;
  if (!packetAuditIsSubmissionReady(input.priorAudit)
    || !packetAuditIsSubmissionReady(input.reissuedAudit)) return null;
  if (!acknowledgementBindsAudit(input.priorAcknowledgement, input.priorAudit)) return null;
  if (input.priorAudit.bindings.pdf.sha256 !== input.reissuedAudit.bindings.pdf.sha256) return null;
  if (input.priorAudit.bindings.employerDelivery?.mode !== input.reissuedAudit.bindings.employerDelivery?.mode) return null;
  const learned = input.learnedQuestions;
  let questionsSha256Override: string | undefined;
  if (learned) {
    /* THE FOUR PROOFS THAT KEEP A LEARNED ROW FROM BECOMING APPROVED CONTENT. Each one is refused
     * here rather than at the caller, because this function is the only thing standing between a
     * re-measurement and a re-approval, and a caller that got any of them wrong would otherwise
     * mint a human approval out of a record that never matched.
     *
     * 1. The acknowledged rows hash to exactly what the prior audit bound. A caller that handed a
     *    trimmed or edited "acknowledged" set to make the identity line up fails here first.
     * 2. The reissued set hashes to exactly what the reissued audit bound, so the rows checked
     *    below are the rows the audit actually carries, not a hopeful copy of them.
     * 3. The reissued set OPENS with the acknowledged rows, unchanged and in order. This is what
     *    makes the restriction in the identity comparison a real restriction: the override is the
     *    hash of a genuine prefix of the audit's own set.
     * 4. Every row past that prefix is answerless and carries no claim of hers. A learned row with
     *    a machine answer on it is content she has never seen, and carrying an approval over it is
     *    precisely the send this gate exists to refuse - so it holds, she is asked, and the round
     *    after covers it. Nothing here writes or blanks an answer to make a carry possible. */
    const acknowledgedSha256 = packetAuditSha256(packetVisibleQuestions([...learned.acknowledged]));
    if (acknowledgedSha256 !== input.priorAudit.bindings.questionsSha256) return null;
    if (packetAuditSha256(packetVisibleQuestions([...learned.reissued]))
      !== input.reissuedAudit.bindings.questionsSha256) return null;
    if (learned.reissued.length < learned.acknowledged.length) return null;
    if (!isDeepStrictEqual(
      learned.reissued.slice(0, learned.acknowledged.length),
      [...learned.acknowledged],
    )) return null;
    const added = learned.reissued.slice(learned.acknowledged.length);
    if (added.some((question) => !learnedQuestionIsUnanswered(question))) return null;
    questionsSha256Override = acknowledgedSha256;
  }
  if (packetAuditContentIdentityWithoutDelivery(input.priorAudit)
    !== packetAuditContentIdentityWithoutDelivery(input.reissuedAudit, questionsSha256Override)) return null;
  return {
    ownerSha256: input.reissuedAudit.bindings.ownerSha256,
    applicationId: input.reissuedAudit.bindings.applicationId,
    audit_digest: input.reissuedAudit.audit_digest,
    packet_version: input.reissuedAudit.packet_version,
    pdfSha256: input.reissuedAudit.bindings.pdf.sha256,
    pdfSizeBytes: input.reissuedAudit.bindings.pdf.sizeBytes,
    acknowledged_at: input.acknowledgedAt,
    source: 'form_reading_measured',
  };
}

/**
 * A ROW THE FORM JUST TAUGHT LITOS ABOUT, WITH NOTHING IN IT YET.
 *
 * Blank is the whole test, and it is deliberately blind to WHY the row is blank. A discovery pass
 * that could not read a control's options files a metadata blocker and leaves the answer empty; a
 * resolver that had no profile value to give leaves it empty too. Both are questions, both reach
 * her on the answers screen, and neither is content. Anything with a value in it - a profile relay,
 * a drafted paragraph, a sentence reused from another employer's form - is content she has not
 * seen, whatever produced it, and is not carried. answer_source is checked as well because a row
 * carrying her claim while holding no answer is a record nobody should be reasoning about.
 */
function learnedQuestionIsUnanswered(question: ApplicationReviewQuestion): boolean {
  if (question.answer_source !== undefined) return false;
  const answer: unknown = question.answer;
  if (answer === undefined || answer === null) return true;
  return typeof answer === 'string' && answer.trim().length === 0;
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
    persistAudit: (row: ResumeRow) => Promise<{ audit: PacketAudit; persisted: boolean }>;
    /** The blob write, as a seam. Defaulted to @vercel/blob's put, so production is unchanged and a
        test can drive this function end to end against a real database without a network store. */
    putObject?: (key: string, bytes: Buffer) => Promise<{ pathname: string }>;
    /** Test seam for the otherwise non-deterministic PDF render. */
    rerenderResume?: typeof rerenderFrozenResume;
    /** Test seam for a database mutation after the audited row is read and before acknowledgement
        carry attempts its exact compare-and-swap. */
    beforeAcknowledgementCarry?: () => Promise<void>;
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
    bytes = await (dependencies.rerenderResume ?? rerenderFrozenResume)({
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
    ?? ((key: string, payload: Buffer) => storePutObject(key, payload, { contentType: 'application/pdf' }));
  const blob = await write(objectKey, bytes);

  const quality = ((row.spec as Record<string, unknown>)?._quality ?? {}) as Record<string, unknown>;
  const nextQuality = {
    ...quality,
    pdfGenerationBinding: createPdfGenerationBinding(row.spec, blob.pathname, bytes, resumeEmail),
    /* Kept beside the binding rather than on _review, because it is a fact about how this FILE came
       to exist, and _quality is where the other facts about the rendered document already live. */
    restoredFromSpecAt: new Date().toISOString(),
  };

  const restoredPdfSha256 = createHash('sha256').update(bytes).digest('hex');
  const bytesChanged = review.packet_audit?.bindings.pdf.sha256 !== restoredPdfSha256;

  /* Guarded on the OLD key, so two runners racing the same expired packet cannot both win: the
     second update matches nothing, and that run re-reads a row whose file another run already
     restored. Its orphaned blob ages out on the normal 30-day window. */
  const updated = await db.update(generated_resumes).set({
    resume_object_key: blob.pathname,
    spec: bytesChanged
      ? sql`jsonb_set(
          coalesce(${generated_resumes.spec}, '{}'::jsonb)
            #- '{_review,employer_delivery_bindings}'
            #- '{_review,packet_audit_acknowledgement}'
            #- '{_review,packet_audit}',
          '{_quality}', ${JSON.stringify(nextQuality)}::jsonb, true
        )`
      : sql`jsonb_set(coalesce(${generated_resumes.spec}, '{}'::jsonb), '{_quality}', ${JSON.stringify(nextQuality)}::jsonb, true)`,
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
  const persistedAudit = await dependencies.persistAudit(refreshed);
  if (!persistedAudit.persisted) {
    const [latest] = await db.select().from(generated_resumes)
      .where(eq(generated_resumes.id, row.id)).limit(1);
    return { restored: true, row: latest ?? refreshed, objectKey: blob.pathname };
  }
  const { audit } = persistedAudit;

  const audited = await db.select().from(generated_resumes)
    .where(eq(generated_resumes.id, row.id)).limit(1);
  const auditedRow = audited[0] ?? refreshed;
  const auditedReview = readApplicationReview(auditedRow.spec);
  if (!auditedReview
    || auditedRow.resume_object_key !== blob.pathname
    || !isDeepStrictEqual(auditedReview.packet_audit, audit)) {
    return { restored: true, row: auditedRow, objectKey: blob.pathname };
  }

  /* THE APPROVAL SHE ALREADY GAVE, OR NOTHING. Read off the PRE-restore review, which is the one
     that holds the audit she was shown and the acknowledgement she gave for it. */
  const carried = restoredPacketAcknowledgement({
    authority: dependencies.authority,
    priorAudit: review.packet_audit,
    priorAcknowledgement: review.packet_audit_acknowledgement,
    restoredAudit: audit,
    acknowledgedAt: new Date().toISOString(),
  });
  /* Nothing to carry, so nothing is written. Changed bytes already removed obsolete authorization
     before audit persistence. In the byte-identical review-only case an old acknowledgement may
     remain, but it names the prior packet version and every downstream gate refuses it. */
  if (!carried) return { restored: true, row: auditedRow, objectKey: blob.pathname };

  await dependencies.beforeAcknowledgementCarry?.();
  await db.update(generated_resumes).set({
    spec: sql`jsonb_set(coalesce(${generated_resumes.spec}, '{}'::jsonb), '{_review,packet_audit_acknowledgement}', ${JSON.stringify(carried)}::jsonb, true)`,
  }).where(and(
    eq(generated_resumes.id, row.id),
    eq(generated_resumes.user_id, row.user_id),
    eq(generated_resumes.resume_object_key, auditedRow.resume_object_key),
    sql`${generated_resumes.spec} = ${JSON.stringify(auditedRow.spec)}::jsonb`,
  ));

  const [final] = await db.select().from(generated_resumes)
    .where(eq(generated_resumes.id, row.id)).limit(1);
  return { restored: true, row: final ?? auditedRow, objectKey: blob.pathname };
}
