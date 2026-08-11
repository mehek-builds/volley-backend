import { renderCoverLetterPdf } from './coverLetterPdf';
import { PacketDocumentExpiredError } from './resumeAccess';
import {
  hasContactRoute,
  renderResumePdf,
  validateResumeVisualLayout,
  type ContactHeader,
} from '../engine/resumeRender';
import { resumeSafeTargetRole } from '../engine/resumePolicy';
import { normalizeSpec } from '../llm/resumeSpec';

/**
 * Re-deriving a packet's documents at send time, from the data the retention sweep does not delete.
 *
 * THE SWEEP DELETES FILES, NOT CONTENT. RESUME_RETENTION_DAYS is 30 and the privacy page promises
 * exactly that, but what it promises is that "the file is gone and old links stop working". The row
 * in generated_resumes is kept, and the same page says so ("your dashboard still shows which resume
 * went to which job"). Measured on 2026-08-11: 325 of the 326 rows in a status that can still reach
 * a send were still carrying full resume content in `spec`, and all 44 rows whose blob had already
 * gone were too. So a packet past its window has everything it needs to be rebuilt except the bytes.
 *
 * WHY THIS DOES NOT WEAKEN THE PROMISE. Nothing is retained that was not already retained and
 * already disclosed. The file stays deleted, old links stay dead, and no document is resurrected
 * for browsing. Bytes exist only inside the send the applicant just approved, and are never written
 * back to storage: buildPacket holds them for the length of one run and drops them. The alternative
 * that was weighed and rejected, exempting queued packets from the sweep, would have made the
 * published sentence false for exactly the packets most likely to hold a resume.
 *
 * WHY IT DOES NOT BREAK THE FREEZE EITHER. Every input here is frozen on the row: the stored spec,
 * the `_contact` block captured at generation, the frozen `jd_text`, and for a letter its stored
 * body and generation date. The current profile is deliberately NOT consulted. That is the whole
 * discipline of this module, because reading the live profile would silently send an employer a
 * different document from the one the applicant approved, and submissionEducationGuard's comparison
 * of stored spec against current profile, which is what actually catches a corrected graduation
 * date, would be comparing the packet against itself.
 *
 * renderResumePdf is a pure function of those inputs: pdfkit only, no network and no model call. So
 * this is a re-render, not a regeneration, and it is content-identical by construction. It is not
 * byte-identical: RESUME_DESIGN tokens can move between the day a packet was built and the day it is
 * sent. That is the one real risk here, and it is why the layout is validated below rather than
 * trusted.
 */

/** Everything the resume render needs, all of it frozen on the row. */
export interface FrozenResumeInputs {
  /** The row's stored spec: resume content, plus the `_contact` block captured at generation. */
  spec: unknown;
  /** The frozen job description, not the posting as it reads today. */
  jdText: string;
  role?: string;
}

export function frozenContactHeader(spec: unknown): ContactHeader {
  const stored = (spec && typeof spec === 'object' ? spec : {}) as Record<string, unknown>;
  const contact = (stored._contact ?? {}) as Record<string, unknown>;
  const text = (value: unknown) => (typeof value === 'string' && value.trim() ? value : undefined);
  return {
    full_name: text(contact.full_name) ?? '',
    email: text(contact.email),
    phone: text(contact.phone),
    linkedin_url: text(contact.linkedin_url),
    github_url: text(contact.github_url),
    portfolio_url: text(contact.portfolio_url),
  };
}

/**
 * The resume an expired packet would have sent, rebuilt from the row.
 *
 * EVERY FAILURE HERE BECOMES PacketDocumentExpiredError, including a render that throws. The caller
 * is a send that is already in trouble, and the applicant is owed one honest sentence about it
 * rather than a pdfkit message or a ResumeContactError reaching a dashboard card. The recovery is
 * best-effort by design: when it cannot produce a document the packet is exactly as expired as it
 * was before this module existed, and the sentence fail() writes is the same one.
 */
export async function rerenderFrozenResume(
  inputs: FrozenResumeInputs,
  render: typeof renderResumePdf = renderResumePdf,
): Promise<Buffer> {
  const contact = frozenContactHeader(inputs.spec);
  /* Checked before rendering rather than left to renderResumePdf's own throw, for the reason
     applications.ts states at its copy of this guard: packets generated before /resume/generate
     resolved the contact block against the account have neither an email nor a phone frozen into
     `_contact`, and 28 of them exist. A resume nobody can reply to must not be rebuilt and sent;
     that row needs regenerating, which is what the expired sentence asks for. */
  if (!hasContactRoute(contact)) throw new PacketDocumentExpiredError('resume');

  let buffer: Buffer;
  try {
    const spec = normalizeSpec(inputs.spec);
    /* The same emptiness gate applications.ts applies before its render. normalizeSpec is tolerant
       by design, so an empty spec renders as a blank page rather than throwing, and a blank page is
       the one output that must never reach an employer. */
    if (!spec.school && spec.experience.length === 0 && spec.skills.length === 0) {
      throw new PacketDocumentExpiredError('resume');
    }
    if (inputs.role) spec.target_role = resumeSafeTargetRole(inputs.role);
    const rendered = await render(spec, contact, inputs.jdText);
    /* THE ONE CHECK THAT EARNS ITS PLACE ON THE SEND PATH. It is pure arithmetic over the layout
       metrics the render already produced, so it costs nothing, and it catches precisely what a
       re-render can newly break that the original could not: content clipped off the page, a fill
       ratio over 100%, sections out of order or overlapping, a bullet grown past its line budget, a
       body font shrunk below the floor. All of those are design-token drift between build day and
       send day, which is the only way this document can differ from the one that was approved.

       The heavier validators from the edit path are deliberately not re-run. They exist there
       because the applicant CHANGED the content; here the content is unchanged and was validated
       when the packet was built. Lead alignment in particular is already checked at send time by
       runnerLeadAlignmentIssues in processSubmissionApplication, so re-running it here would be a
       second opinion on a question already asked, paid for on every send. */
    const visual = validateResumeVisualLayout(rendered.layout);
    if (visual.issues.length > 0) throw new PacketDocumentExpiredError('resume');
    buffer = rendered.buffer;
  } catch (error) {
    if (error instanceof PacketDocumentExpiredError) throw error;
    throw new PacketDocumentExpiredError('resume');
  }
  return buffer;
}

/** Everything the letter render needs. All of it frozen, including the date printed on the page. */
export interface FrozenCoverLetterInputs {
  fullName: string;
  email?: string;
  company: string;
  body: string;
  /**
   * The artifact's `generated_at`. Threaded through rather than left to default, because
   * renderCoverLetterPdf stamps a date on the page: without it a letter rebuilt in September would
   * reach the employer dated September while claiming to be the letter approved in August. The
   * original stamp and `generated_at` come from the same moment, so passing it reproduces the page
   * the applicant approved instead of a fresh one that merely says the same words.
   */
  generatedAt?: string;
}

export async function rerenderFrozenCoverLetter(
  inputs: FrozenCoverLetterInputs,
  render: typeof renderCoverLetterPdf = renderCoverLetterPdf,
): Promise<Buffer> {
  if (!inputs.fullName.trim() || !inputs.company.trim() || !inputs.body.trim()) {
    throw new PacketDocumentExpiredError('cover_letter');
  }
  const stamped = inputs.generatedAt ? new Date(inputs.generatedAt) : undefined;
  try {
    return await render(
      { full_name: inputs.fullName, email: inputs.email },
      inputs.company,
      inputs.body,
      stamped && !Number.isNaN(stamped.getTime()) ? stamped : undefined,
    );
  } catch (error) {
    if (error instanceof PacketDocumentExpiredError) throw error;
    throw new PacketDocumentExpiredError('cover_letter');
  }
}
