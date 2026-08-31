import { createHash } from 'node:crypto';

const EVIDENCE_PREFIX = 'unsupported_email_provider_accepted:';
const RECEIPT_PATTERN = /^This application was emailed to ([^\s@]+@[^\s@]+)\. Resend message id: ([^\s]+)$/u;

function normalizedTuple(recipient: string, messageId: string): [string, string] {
  return [recipient.trim().toLowerCase(), messageId.trim()];
}

export function unsupportedEmailConfirmationText(input: {
  recipient: string;
  messageId: string;
}): string {
  const [recipient, messageId] = normalizedTuple(input.recipient, input.messageId);
  return `This application was emailed to ${recipient}. Resend message id: ${messageId}`;
}

export function unsupportedEmailConfirmationEvidenceCode(input: {
  recipient: string;
  messageId: string;
}): string {
  const tuple = normalizedTuple(input.recipient, input.messageId);
  const digest = createHash('sha256').update(JSON.stringify(tuple)).digest('hex');
  return `${EVIDENCE_PREFIX}${digest}`;
}

export function parseUnsupportedEmailConfirmationText(
  confirmationText: string,
): { recipient: string; messageId: string } | null {
  const matched = confirmationText.trim().match(RECEIPT_PATTERN);
  if (!matched) return null;
  const [recipient, messageId] = normalizedTuple(matched[1]!, matched[2]!);
  if (!recipient || !messageId) return null;
  return { recipient, messageId };
}

export function unsupportedEmailConfirmationEvidenceMatches(input: {
  evidenceCode: string | null | undefined;
  confirmationText: string;
  referenceId?: string;
}): boolean {
  const parsed = parseUnsupportedEmailConfirmationText(input.confirmationText);
  if (!parsed) return false;
  if (!input.referenceId?.trim() || input.referenceId.trim() !== parsed.messageId) return false;
  return input.evidenceCode === unsupportedEmailConfirmationEvidenceCode(parsed);
}
