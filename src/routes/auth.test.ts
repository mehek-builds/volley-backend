import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { buildVerificationEmail } from './auth';

const EMAIL = 'person@example.com';
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
  test('uses the Litos brand and a welcoming transactional layout', () => {
    withEnv({ RESEND_FROM: undefined }, () => {
      const email = buildVerificationEmail(EMAIL, CODE);
      assert.equal(email.from, 'Litos <onboarding@resend.dev>');
      assert.equal(email.subject, '123456 is your Litos verification code');
      assert.deepEqual(email.to, [EMAIL]);
      assert.match(email.html, /<html lang="en">/);
      assert.match(email.html, /You're one quick step away/);
      assert.match(email.html, /We're so excited to have you here/);
      assert.match(email.html, /https:\/\/trylitos\.com\/icon\.png/);
      assert.match(email.html, /href="https:\/\/trylitos\.com\/login"/);
      assert.match(email.html, /Find roles[\s\S]*Tailor[\s\S]*Apply/);
      assert.match(email.html, />123456</);
      assert.match(email.html, /expires in 10 minutes/);
      assert.match(email.text, /123456/);
      assert.match(email.text, /https:\/\/trylitos\.com\/login/);
      assert.doesNotMatch(email.html, /RoleQuick|Volley/i);
    });
  });

  test('replaces a stale sender display name while preserving its verified mailbox', () => {
    withEnv({ RESEND_FROM: 'Volley <onboarding@resend.dev>' }, () => {
      assert.equal(buildVerificationEmail(EMAIL, CODE).from, 'Litos <onboarding@resend.dev>');
    });
  });

  test('preserves a verified sender mailbox and rejects malformed inputs', () => {
    withEnv({ RESEND_FROM: 'Former Brand <hello@example.com>' }, () => {
      assert.equal(buildVerificationEmail(EMAIL, CODE).from, 'Litos <hello@example.com>');
      assert.throws(() => buildVerificationEmail(EMAIL, '<script>'), /six digits/);
    });

    withEnv({ RESEND_FROM: 'not a mailbox' }, () => {
      assert.throws(() => buildVerificationEmail(EMAIL, CODE), /RESEND_FROM/);
    });
  });
});
