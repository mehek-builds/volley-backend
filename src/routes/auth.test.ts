import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { buildVerificationEmail } from './auth';

const EMAIL = 'student@usc.edu';
const CODE = '123456';

function withEnv(vars: Record<string, string | undefined>, fn: () => void) {
  const saved: Record<string, string | undefined> = {};
  for (const key of Object.keys(vars)) {
    saved[key] = process.env[key];
    if (vars[key] === undefined) delete process.env[key];
    else process.env[key] = vars[key];
  }
  try {
    fn();
  } finally {
    for (const key of Object.keys(saved)) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}

describe('verification email copy', () => {
  test('uses the Litos brand and semantic HTML', () => {
    withEnv({ RESEND_FROM: undefined }, () => {
      const email = buildVerificationEmail(EMAIL, CODE);
      assert.equal(email.from, 'Litos <onboarding@resend.dev>');
      assert.equal(email.subject, '123456 is your Litos verification code');
      assert.deepEqual(email.to, [EMAIL]);
      assert.match(email.html, /<p>Welcome to Litos\./);
      assert.match(email.html, /expires in 10 minutes/);
      assert.doesNotMatch(email.html, /RoleQuick|Volley/i);
      assert.doesNotMatch(email.html, /style=/i);
    });
  });

  test('preserves a verified sender and rejects malformed codes', () => {
    withEnv({ RESEND_FROM: 'Litos <hello@example.com>' }, () => {
      assert.equal(buildVerificationEmail(EMAIL, CODE).from, 'Litos <hello@example.com>');
      assert.throws(() => buildVerificationEmail(EMAIL, '<script>'), /six digits/);
    });
  });
});
