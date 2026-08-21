import { z } from 'zod';
import type { ApplicationReviewState } from './applicationReview';
import { emailSender, sendEmail, type OutboundEmail } from './email';
import type { SubmissionPacket } from './portalSubmission';

type ApplicationLike = {
  id: string;
  job_context: unknown;
  spec: unknown;
};

type SendResult = {
  messageId: string;
  recipient: string;
};

export type PreparedUnsupportedPortalApplicationEmail = {
  recipient: string;
  message: OutboundEmail;
};

const EMAIL_FIELDS = [
  'employer_email',
  'company_email',
  'contact_email',
  'hiring_manager_email',
  'recruiter_email',
] as const;

function clean(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function emailFrom(value: unknown): string | undefined {
  const candidate = clean(value);
  return candidate && z.string().email().safeParse(candidate).success ? candidate : undefined;
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function firstEmail(source: Record<string, unknown>): string | undefined {
  for (const field of EMAIL_FIELDS) {
    const direct = emailFrom(source[field]);
    if (direct) return direct;
  }
  return undefined;
}

export function unsupportedPortalFallbackRecipient(
  review: ApplicationReviewState,
  application: ApplicationLike,
): string | undefined {
  const job = objectValue(application.job_context);
  const spec = objectValue(application.spec);
  const storedReview = objectValue(spec._review);
  return firstEmail(objectValue(review))
    ?? firstEmail(storedReview)
    ?? firstEmail(job)
    ?? emailFrom(process.env.LITOS_UNSUPPORTED_PORTAL_APPLICATION_TO)
    ?? emailFrom(process.env.LITOS_UNSUPPORTED_PORTAL_FALLBACK_TO);
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function textLine(label: string, value: string | undefined): string[] {
  return value ? [`${label}: ${value}`] : [];
}

function htmlParagraph(label: string, value: string | undefined): string {
  return value ? `<p><strong>${escapeHtml(label)}:</strong> ${escapeHtml(value)}</p>` : '';
}

function jobDetails(application: ApplicationLike, review: ApplicationReviewState) {
  const job = objectValue(application.job_context);
  const role = clean(review.role) ?? clean(job.role);
  const company = clean(job.company);
  return { role, company };
}

export function buildUnsupportedPortalApplicationEmail(input: {
  application: ApplicationLike;
  review: ApplicationReviewState;
  packet: SubmissionPacket;
  to: string;
}): OutboundEmail {
  const { application, review, packet, to } = input;
  const { role, company } = jobDetails(application, review);
  const subjectParts = ['Application'];
  if (role) subjectParts.push(`for ${role}`);
  if (company) subjectParts.push(`at ${company}`);
  const subject = subjectParts.join(' ');
  const coverLetterAttached = Boolean(packet.coverLetter && packet.coverLetterName);
  const portalUrl = clean(review.portal_url);

  return {
    from: emailSender(),
    to: [to],
    reply_to: packet.email,
    subject,
    text: [
      `Hello,`,
      ``,
      `Litos is sending this application by email because the company's application portal is not supported for direct Litos submission yet.`,
      ``,
      ...textLine('Applicant', packet.fullName),
      ...textLine('Applicant email', packet.email),
      ...textLine('Role', role),
      ...textLine('Company', company),
      ...textLine('Portal URL', portalUrl),
      ``,
      `The resume is attached.${coverLetterAttached ? ' The cover letter is attached as well.' : ''}`,
      `Replies to this email go directly to the applicant.`,
      ``,
      `Thank you,`,
      `Litos`,
    ].join('\n'),
    html: [
      `<p>Hello,</p>`,
      `<p>Litos is sending this application by email because the company's application portal is not supported for direct Litos submission yet.</p>`,
      htmlParagraph('Applicant', packet.fullName),
      htmlParagraph('Applicant email', packet.email),
      htmlParagraph('Role', role),
      htmlParagraph('Company', company),
      htmlParagraph('Portal URL', portalUrl),
      `<p>The resume is attached.${coverLetterAttached ? ' The cover letter is attached as well.' : ''}</p>`,
      `<p>Replies to this email go directly to the applicant.</p>`,
      `<p>Thank you,<br>Litos</p>`,
    ].filter(Boolean).join(''),
    attachments: [
      {
        filename: packet.resumeName,
        content: packet.resume.toString('base64'),
        content_type: 'application/pdf',
      },
      ...(coverLetterAttached
        ? [{
          filename: packet.coverLetterName!,
          content: packet.coverLetter!.toString('base64'),
          content_type: 'application/pdf',
        }]
        : []),
    ],
  };
}

export async function sendUnsupportedPortalApplicationEmail(input: {
  application: ApplicationLike;
  review: ApplicationReviewState;
  packet: SubmissionPacket;
  fetchImpl?: typeof fetch;
}): Promise<SendResult> {
  const prepared = prepareUnsupportedPortalApplicationEmail(input);
  return sendPreparedUnsupportedPortalApplicationEmail(prepared, input.fetchImpl);
}

export function prepareUnsupportedPortalApplicationEmail(input: {
  application: ApplicationLike;
  review: ApplicationReviewState;
  packet: SubmissionPacket;
}): PreparedUnsupportedPortalApplicationEmail {
  const recipient = unsupportedPortalFallbackRecipient(input.review, input.application);
  if (!recipient) {
    throw new Error('Unsupported portal application email recipient is not configured');
  }
  return {
    recipient,
    message: buildUnsupportedPortalApplicationEmail({
      application: input.application,
      review: input.review,
      packet: input.packet,
      to: recipient,
    }),
  };
}

export async function sendPreparedUnsupportedPortalApplicationEmail(
  prepared: PreparedUnsupportedPortalApplicationEmail,
  fetchImpl?: typeof fetch,
): Promise<SendResult> {
  const messageId = await sendEmail(prepared.message, fetchImpl);
  return { messageId, recipient: prepared.recipient };
}
