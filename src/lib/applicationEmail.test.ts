import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applicationAliasFor,
  applicationEmailRouteLabel,
  classifyApplicationEmail,
  retrieveResendReceivedEmail,
} from './applicationEmail';

test('application aliases are deterministic and live on the configured domain', () => {
  const previousMailbox = process.env.LITOS_APPLICATION_EMAIL_MAILBOX;
  const previousDomain = process.env.LITOS_APPLICATION_EMAIL_DOMAIN;
  const previousSecret = process.env.LITOS_APPLICATION_EMAIL_ALIAS_SECRET;
  delete process.env.LITOS_APPLICATION_EMAIL_MAILBOX;
  process.env.LITOS_APPLICATION_EMAIL_DOMAIN = 'apply.litos.test';
  process.env.LITOS_APPLICATION_EMAIL_ALIAS_SECRET = 'secret';
  try {
    const first = applicationAliasFor(
      '11111111-1111-4111-8111-111111111111',
      '22222222-2222-4222-8222-222222222222',
    );
    const second = applicationAliasFor(
      '11111111-1111-4111-8111-111111111111',
      '22222222-2222-4222-8222-222222222222',
    );
    assert.equal(first, second);
    assert.match(first ?? '', /^app-2222222222-[a-f0-9]{12}@apply\.litos\.test$/);
  } finally {
    if (previousMailbox === undefined) delete process.env.LITOS_APPLICATION_EMAIL_MAILBOX;
    else process.env.LITOS_APPLICATION_EMAIL_MAILBOX = previousMailbox;
    if (previousDomain === undefined) delete process.env.LITOS_APPLICATION_EMAIL_DOMAIN;
    else process.env.LITOS_APPLICATION_EMAIL_DOMAIN = previousDomain;
    if (previousSecret === undefined) delete process.env.LITOS_APPLICATION_EMAIL_ALIAS_SECRET;
    else process.env.LITOS_APPLICATION_EMAIL_ALIAS_SECRET = previousSecret;
  }
});

test('application aliases can route through one main mailbox', () => {
  const previousMailbox = process.env.LITOS_APPLICATION_EMAIL_MAILBOX;
  const previousDomain = process.env.LITOS_APPLICATION_EMAIL_DOMAIN;
  const previousSecret = process.env.LITOS_APPLICATION_EMAIL_ALIAS_SECRET;
  process.env.LITOS_APPLICATION_EMAIL_MAILBOX = 'applications@trylitos.com';
  process.env.LITOS_APPLICATION_EMAIL_DOMAIN = 'apply.litos.test';
  process.env.LITOS_APPLICATION_EMAIL_ALIAS_SECRET = 'secret';
  try {
    const alias = applicationAliasFor(
      '11111111-1111-4111-8111-111111111111',
      '22222222-2222-4222-8222-222222222222',
    );
    assert.match(alias ?? '', /^applications\+app-2222222222-[a-f0-9]{12}@trylitos\.com$/);
    assert.equal(applicationEmailRouteLabel(), 'applications@trylitos.com');
  } finally {
    if (previousMailbox === undefined) delete process.env.LITOS_APPLICATION_EMAIL_MAILBOX;
    else process.env.LITOS_APPLICATION_EMAIL_MAILBOX = previousMailbox;
    if (previousDomain === undefined) delete process.env.LITOS_APPLICATION_EMAIL_DOMAIN;
    else process.env.LITOS_APPLICATION_EMAIL_DOMAIN = previousDomain;
    if (previousSecret === undefined) delete process.env.LITOS_APPLICATION_EMAIL_ALIAS_SECRET;
    else process.env.LITOS_APPLICATION_EMAIL_ALIAS_SECRET = previousSecret;
  }
});

test('application aliases are disabled until a real secret is configured', () => {
  const previousMailbox = process.env.LITOS_APPLICATION_EMAIL_MAILBOX;
  const previousDomain = process.env.LITOS_APPLICATION_EMAIL_DOMAIN;
  const previousAliasSecret = process.env.LITOS_APPLICATION_EMAIL_ALIAS_SECRET;
  const previousCompatSecret = process.env.LITOS_APPLICATION_EMAIL_SECRET;
  const previousJwtSecret = process.env.JWT_SIGNING_SECRET;
  delete process.env.LITOS_APPLICATION_EMAIL_MAILBOX;
  process.env.LITOS_APPLICATION_EMAIL_DOMAIN = 'apply.litos.test';
  delete process.env.LITOS_APPLICATION_EMAIL_ALIAS_SECRET;
  delete process.env.LITOS_APPLICATION_EMAIL_SECRET;
  delete process.env.JWT_SIGNING_SECRET;
  try {
    assert.equal(applicationAliasFor(
      '11111111-1111-4111-8111-111111111111',
      '22222222-2222-4222-8222-222222222222',
    ), null);
  } finally {
    if (previousMailbox === undefined) delete process.env.LITOS_APPLICATION_EMAIL_MAILBOX;
    else process.env.LITOS_APPLICATION_EMAIL_MAILBOX = previousMailbox;
    if (previousDomain === undefined) delete process.env.LITOS_APPLICATION_EMAIL_DOMAIN;
    else process.env.LITOS_APPLICATION_EMAIL_DOMAIN = previousDomain;
    if (previousAliasSecret === undefined) delete process.env.LITOS_APPLICATION_EMAIL_ALIAS_SECRET;
    else process.env.LITOS_APPLICATION_EMAIL_ALIAS_SECRET = previousAliasSecret;
    if (previousCompatSecret === undefined) delete process.env.LITOS_APPLICATION_EMAIL_SECRET;
    else process.env.LITOS_APPLICATION_EMAIL_SECRET = previousCompatSecret;
    if (previousJwtSecret === undefined) delete process.env.JWT_SIGNING_SECRET;
    else process.env.JWT_SIGNING_SECRET = previousJwtSecret;
  }
});

test('application email classifier recognizes employer outcomes', () => {
  assert.equal(
    classifyApplicationEmail('Thank you for applying', 'We received your application.'),
    'submission_confirmation',
  );
  assert.equal(
    classifyApplicationEmail('Interview availability', 'Can you schedule a call with our recruiter?'),
    'interview_request',
  );
  assert.equal(
    classifyApplicationEmail('Your verification code', 'Use passcode 123456.'),
    'verification_code',
  );
});

test('resend received email hydration fetches the full body before routing', async () => {
  const previousKey = process.env.RESEND_API_KEY;
  const previousFetch = globalThis.fetch;
  process.env.RESEND_API_KEY = 're_test';
  try {
    globalThis.fetch = (async (url, init) => {
      assert.equal(String(url), 'https://api.resend.com/emails/receiving/email_123');
      assert.equal((init?.headers as Record<string, string>).Authorization, 'Bearer re_test');
      return new Response(JSON.stringify({
        id: 'email_123',
        to: ['app-abc@apply.litos.test'],
        from: 'recruiter@example.com',
        created_at: '2026-08-06T10:00:00.000Z',
        subject: 'Interview availability',
        text: 'Can you schedule a call?',
        html: '<p>Can you schedule a call?</p>',
        message_id: '<message@example.com>',
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    const hydrated = await retrieveResendReceivedEmail({
      emailId: 'email_123',
      fallback: { provider: 'resend', to: [], raw: { type: 'email.received' } },
    });
    assert.equal(hydrated.providerMessageId, '<message@example.com>');
    assert.equal(hydrated.from, 'recruiter@example.com');
    assert.equal(hydrated.text, 'Can you schedule a call?');
    assert.deepEqual(hydrated.to, ['app-abc@apply.litos.test']);
  } finally {
    if (previousKey === undefined) delete process.env.RESEND_API_KEY;
    else process.env.RESEND_API_KEY = previousKey;
    globalThis.fetch = previousFetch;
  }
});
