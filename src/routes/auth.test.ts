import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildVerificationEmail } from './auth';

test('verification email uses the Litos brand and semantic HTML', () => {
  const previous = process.env.RESEND_FROM;
  delete process.env.RESEND_FROM;
  try {
    const email = buildVerificationEmail('student@example.com', '123456');
    assert.equal(email.from, 'Litos <onboarding@resend.dev>');
    assert.equal(email.subject, '123456 is your Litos verification code');
    assert.equal(email.to[0], 'student@example.com');
    assert.match(email.html, /<p>Welcome to Litos\./);
    assert.doesNotMatch(email.html, /RoleQuick|Volley/i);
  } finally {
    if (previous === undefined) delete process.env.RESEND_FROM;
    else process.env.RESEND_FROM = previous;
  }
});

test('verification email preserves a verified sender and rejects malformed codes', () => {
  const previous = process.env.RESEND_FROM;
  process.env.RESEND_FROM = 'Litos <hello@example.com>';
  try {
    assert.equal(buildVerificationEmail('student@example.com', '123456').from, process.env.RESEND_FROM);
    assert.throws(() => buildVerificationEmail('student@example.com', '<script>'), /six digits/);
  } finally {
    if (previous === undefined) delete process.env.RESEND_FROM;
    else process.env.RESEND_FROM = previous;
  }
});
