import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildVerificationEmail,
  googleRegistrationValues,
  googleIdentityFromClaims,
  googleIsAuthoritativeForEmail,
  sendVerificationEmail,
  verificationFailure,
} from './auth';
import { createHash } from 'node:crypto';

const EMAIL = 'person@example.com';
const CODE = '123456';

describe('Google identity claims', () => {
  test('accepts a verified Google identity and normalizes its email', () => {
    assert.deepEqual(
      googleIdentityFromClaims({ sub: 'google-123', email: 'Person@Gmail.com', email_verified: true }),
      { subject: 'google-123', email: 'person@gmail.com', hostedDomain: null },
    );
  });

  test('rejects identities without a stable subject or verified email', () => {
    assert.equal(googleIdentityFromClaims({ email: EMAIL, email_verified: true }), null);
    assert.equal(googleIdentityFromClaims({ sub: 'google-123', email: EMAIL, email_verified: false }), null);
    assert.equal(googleIdentityFromClaims({ sub: 'google-123', email: 'not-an-email', email_verified: true }), null);
  });

  test('only treats Gmail and Google Workspace addresses as authoritative', () => {
    assert.equal(
      googleIsAuthoritativeForEmail({ subject: '1', email: 'person@gmail.com', hostedDomain: null }),
      true,
    );
    assert.equal(
      googleIsAuthoritativeForEmail({ subject: '2', email: 'person@company.com', hostedDomain: 'company.com' }),
      true,
    );
    assert.equal(
      googleIsAuthoritativeForEmail({ subject: '3', email: 'person@yahoo.com', hostedDomain: null }),
      false,
    );
    assert.equal(
      googleIsAuthoritativeForEmail({ subject: '4', email: 'person@other.com', hostedDomain: 'company.com' }),
      false,
    );
  });

  test('builds a complete first-time registration with trial and onboarding defaults', () => {
    const now = new Date('2026-07-26T08:00:00.000Z');
    const registration = googleRegistrationValues(
      { subject: 'google-new-user', email: 'new.user@gmail.com', hostedDomain: null },
      now,
      '00000000-0000-4000-8000-000000000001',
    );

    assert.deepEqual(registration, {
      id: '00000000-0000-4000-8000-000000000001',
      email: 'new.user@gmail.com',
      email_verified: true,
      google_subject: 'google-new-user',
      plan: 'free',
      trial_ends_at: new Date('2026-08-02T08:00:00.000Z'),
      created_at: now,
      onboarding_completed_at: null,
    });
  });
});

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

describe('verification email delivery requests', () => {
  test('sends every repeated request for the same unfinished email', async () => {
    const requests: Array<{ url: string; body: ReturnType<typeof JSON.parse> }> = [];
    const fakeFetch = async (input: string | URL | Request, init?: RequestInit) => {
      requests.push({
        url: String(input),
        body: JSON.parse(String(init?.body)),
      });
      return new Response(JSON.stringify({ id: `email-${requests.length}` }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };

    await withEnvAsync({ RESEND_API_KEY: 'test-key' }, async () => {
      const firstId = await sendVerificationEmail(EMAIL, '111111', fakeFetch as typeof fetch);
      const secondId = await sendVerificationEmail(EMAIL, '222222', fakeFetch as typeof fetch);

      assert.equal(firstId, 'email-1');
      assert.equal(secondId, 'email-2');
      assert.equal(requests.length, 2);
      assert.equal(requests[0]?.body.to[0], EMAIL);
      assert.equal(requests[1]?.body.to[0], EMAIL);
      assert.equal(requests[0]?.body.subject, '111111 is your Litos verification code');
      assert.equal(requests[1]?.body.subject, '222222 is your Litos verification code');
    });
  });

  test('rejects an accepted response that cannot be tracked', async () => {
    const fakeFetch = async () =>
      new Response(JSON.stringify({}), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });

    await assert.rejects(
      () => sendVerificationEmail(EMAIL, CODE, fakeFetch as typeof fetch),
      /without returning an email id/,
    );
  });
});

describe('verification code edge cases', () => {
  const hash = (value: string) => createHash('sha256').update(value).digest('hex');
  const now = new Date('2026-07-21T08:00:00.000Z');

  test('accepts the matching unexpired code with attempts remaining', () => {
    assert.equal(
      verificationFailure(
        { code_hash: hash(CODE), expires_at: new Date('2026-07-21T08:10:00.000Z'), attempts: 4 },
        CODE,
        now,
      ),
      null,
    );
  });

  test('rejects missing and expired codes without consuming an attempt', () => {
    assert.deepEqual(verificationFailure(undefined, CODE, now), {
      status: 400,
      error: 'Code expired or not found. Request a new one.',
      incrementAttempts: false,
    });
    assert.deepEqual(
      verificationFailure(
        { code_hash: hash(CODE), expires_at: new Date('2026-07-21T07:59:59.000Z'), attempts: 0 },
        CODE,
        now,
      ),
      {
        status: 400,
        error: 'Code expired or not found. Request a new one.',
        incrementAttempts: false,
      },
    );
  });

  test('locks a code after five incorrect attempts', () => {
    assert.deepEqual(
      verificationFailure(
        { code_hash: hash(CODE), expires_at: new Date('2026-07-21T08:10:00.000Z'), attempts: 5 },
        CODE,
        now,
      ),
      {
        status: 429,
        error: 'Too many attempts. Request a new code.',
        incrementAttempts: false,
      },
    );
  });

  test('counts an incorrect code only while the active code can still be used', () => {
    assert.deepEqual(
      verificationFailure(
        { code_hash: hash(CODE), expires_at: new Date('2026-07-21T08:10:00.000Z'), attempts: 2 },
        '654321',
        now,
      ),
      { status: 400, error: 'Incorrect code.', incrementAttempts: true },
    );
  });
});

async function withEnvAsync(vars: Record<string, string | undefined>, fn: () => Promise<void>) {
  const saved: Record<string, string | undefined> = {};
  for (const key of Object.keys(vars)) {
    saved[key] = process.env[key];
    if (vars[key] === undefined) delete process.env[key];
    else process.env[key] = vars[key];
  }
  try {
    await fn();
  } finally {
    for (const key of Object.keys(saved)) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}
