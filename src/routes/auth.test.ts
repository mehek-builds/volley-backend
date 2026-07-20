import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { buildVerificationEmail } from './auth';

// R-044 coverage. The verification email kept the retired "Volley" name in its subject,
// body, and default sender long after the product became Litos - the stale-name class
// that already cost a store rejection (R-037). These tests pin the user-facing copy of the
// one email every new user receives, so the next rename can't silently miss it either:
// the guard asserts on the whole payload, not on individual strings.

const EMAIL = 'student@usc.edu';
const CODE = '123456';

function withEnv(vars: Record<string, string | undefined>, fn: () => void) {
  const saved: Record<string, string | undefined> = {};
  for (const k of Object.keys(vars)) {
    saved[k] = process.env[k];
    if (vars[k] === undefined) delete process.env[k];
    else process.env[k] = vars[k];
  }
  try {
    fn();
  } finally {
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

describe('verification email copy (R-044)', () => {
  test('default sender display name is Litos when RESEND_FROM is unset', () => {
    withEnv({ RESEND_FROM: undefined }, () => {
      assert.equal(buildVerificationEmail(EMAIL, CODE).from, 'Litos <onboarding@resend.dev>');
    });
  });

  test('a configured RESEND_FROM is passed through verbatim', () => {
    withEnv({ RESEND_FROM: 'Litos <hi@trylitos.com>' }, () => {
      assert.equal(buildVerificationEmail(EMAIL, CODE).from, 'Litos <hi@trylitos.com>');
    });
  });

  test('subject carries the code and the Litos name', () => {
    assert.equal(buildVerificationEmail(EMAIL, CODE).subject, '123456 is your Litos verification code');
  });

  test('body welcomes the user to Litos, shows the code, and states the 10-minute expiry', () => {
    const { html } = buildVerificationEmail(EMAIL, CODE);
    assert.ok(html.includes('Welcome to Litos.'));
    assert.ok(html.includes(CODE));
    assert.ok(html.includes('expires in 10 minutes'));
  });

  test('recipient is exactly the address the code was requested for', () => {
    assert.deepEqual(buildVerificationEmail(EMAIL, CODE).to, [EMAIL]);
  });

  test('R-044 guard: no retired product name anywhere in the payload', () => {
    withEnv({ RESEND_FROM: undefined }, () => {
      const payload = JSON.stringify(buildVerificationEmail(EMAIL, CODE)).toLowerCase();
      assert.ok(!payload.includes('volley'), 'verification email payload still mentions Volley');
    });
  });
});
