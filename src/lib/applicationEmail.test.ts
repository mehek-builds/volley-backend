import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applicationAliasFor,
  classifyApplicationEmail,
  inboundSecretMatches,
} from './applicationEmail';

test('application aliases are deterministic and live on the configured domain', () => {
  const previousDomain = process.env.LITOS_APPLICATION_EMAIL_DOMAIN;
  const previousSecret = process.env.LITOS_APPLICATION_EMAIL_ALIAS_SECRET;
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
    if (previousDomain === undefined) delete process.env.LITOS_APPLICATION_EMAIL_DOMAIN;
    else process.env.LITOS_APPLICATION_EMAIL_DOMAIN = previousDomain;
    if (previousSecret === undefined) delete process.env.LITOS_APPLICATION_EMAIL_ALIAS_SECRET;
    else process.env.LITOS_APPLICATION_EMAIL_ALIAS_SECRET = previousSecret;
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

test('inbound webhook secret uses exact comparison', () => {
  const previous = process.env.LITOS_APPLICATION_EMAIL_WEBHOOK_SECRET;
  process.env.LITOS_APPLICATION_EMAIL_WEBHOOK_SECRET = 'hook-secret';
  try {
    assert.equal(inboundSecretMatches('hook-secret'), true);
    assert.equal(inboundSecretMatches('hook-secret '), false);
    assert.equal(inboundSecretMatches('wrong'), false);
  } finally {
    if (previous === undefined) delete process.env.LITOS_APPLICATION_EMAIL_WEBHOOK_SECRET;
    else process.env.LITOS_APPLICATION_EMAIL_WEBHOOK_SECRET = previous;
  }
});
