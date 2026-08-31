import assert from 'node:assert/strict';
import test from 'node:test';
import {
  parseUnsupportedEmailConfirmationText,
  unsupportedEmailConfirmationEvidenceCode,
  unsupportedEmailConfirmationEvidenceMatches,
  unsupportedEmailConfirmationText,
} from './unsupportedEmailReceipt';

test('unsupported email acceptance binds the immutable fact to recipient and provider id', () => {
  const result = { recipient: 'Hiring@Example.com', messageId: 'resend-123' };
  const confirmationText = unsupportedEmailConfirmationText(result);
  const evidenceCode = unsupportedEmailConfirmationEvidenceCode(result);
  assert.deepEqual(parseUnsupportedEmailConfirmationText(confirmationText), {
    recipient: 'hiring@example.com',
    messageId: 'resend-123',
  });
  assert.equal(unsupportedEmailConfirmationEvidenceMatches({
    evidenceCode,
    confirmationText,
    referenceId: result.messageId,
  }), true);
  assert.equal(unsupportedEmailConfirmationEvidenceMatches({
    evidenceCode,
    confirmationText,
  }), false);
});

test('a changed recipient, id, mutable sentence, or reference cannot reuse email authority', () => {
  const result = { recipient: 'hiring@example.com', messageId: 'resend-123' };
  const confirmationText = unsupportedEmailConfirmationText(result);
  const evidenceCode = unsupportedEmailConfirmationEvidenceCode(result);
  assert.equal(unsupportedEmailConfirmationEvidenceMatches({
    evidenceCode,
    confirmationText: unsupportedEmailConfirmationText({ ...result, recipient: 'other@example.com' }),
    referenceId: result.messageId,
  }), false);
  assert.equal(unsupportedEmailConfirmationEvidenceMatches({
    evidenceCode,
    confirmationText: unsupportedEmailConfirmationText({ ...result, messageId: 'resend-456' }),
    referenceId: 'resend-456',
  }), false);
  assert.equal(unsupportedEmailConfirmationEvidenceMatches({
    evidenceCode,
    confirmationText: 'Application sent successfully',
    referenceId: result.messageId,
  }), false);
  assert.equal(unsupportedEmailConfirmationEvidenceMatches({
    evidenceCode,
    confirmationText,
    referenceId: 'different-id',
  }), false);
});
