import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  applicationAliasEmail,
  applicationAliasLocalPart,
  applicationEmailDomain,
  buildForwardedApplicationEmail,
  inboundDedupeKey,
  plainTextFromHtml,
} from './applicationEmail';

async function withEnv<T>(patch: Record<string, string | undefined>, fn: () => Promise<T> | T): Promise<T> {
  const saved = Object.fromEntries(Object.keys(patch).map((key) => [key, process.env[key]]));
  try {
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test('application aliases are opaque, deterministic, and domain gated', async () => {
  await withEnv({
    LITOS_APPLICATION_EMAIL_DOMAIN: 'apply.trylitos.com',
    LITOS_APPLICATION_EMAIL_SECRET: 'test-secret',
  }, () => {
    const first = applicationAliasEmail('user-1', 'application-1');
    const second = applicationAliasEmail('user-1', 'application-1');
    const other = applicationAliasEmail('user-1', 'application-2');
    assert.equal(first, second);
    assert.notEqual(first, other);
    assert.match(first ?? '', /^apply-[a-z0-9_-]{18}@apply\.trylitos\.com$/);
    assert.equal((first ?? '').includes('user-1'), false);
    assert.equal((first ?? '').includes('application-1'), false);
  });

  await withEnv({ LITOS_APPLICATION_EMAIL_DOMAIN: '' }, () => {
    assert.equal(applicationEmailDomain(), null);
    assert.equal(applicationAliasEmail('user-1', 'application-1'), null);
  });

  await withEnv({
    LITOS_APPLICATION_EMAIL_DOMAIN: 'apply.trylitos.com',
    LITOS_APPLICATION_EMAIL_SECRET: undefined,
    JWT_SIGNING_SECRET: undefined,
  }, () => {
    assert.equal(applicationAliasEmail('user-1', 'application-1'), null);
    assert.throws(() => applicationAliasLocalPart('user-1', 'application-1'), /not configured/);
  });
});

test('application alias local part changes when the secret changes', async () => {
  let first = '';
  let second = '';
  await withEnv({ LITOS_APPLICATION_EMAIL_SECRET: 'first-secret' }, () => {
    first = applicationAliasLocalPart('user-1', 'application-1');
  });
  await withEnv({ LITOS_APPLICATION_EMAIL_SECRET: 'second-secret' }, () => {
    second = applicationAliasLocalPart('user-1', 'application-1');
  });
  assert.notEqual(first, second);
});

test('forwarded employer mail replies to the employer instead of looping through the alias', async () => {
  await withEnv({ RESEND_FROM: 'ops@trylitos.com' }, () => {
    const message = buildForwardedApplicationEmail({
      forwardingEmail: 'mehek@example.com',
      applicationEmail: 'apply-abc@apply.trylitos.com',
      inbound: {
        fromEmail: 'recruiting@example.com',
        fromName: 'Recruiting',
        toEmail: 'apply-abc@apply.trylitos.com',
        subject: 'Interview request',
        htmlBody: '<p>Can you meet Friday?</p>',
      },
    });
    assert.deepEqual(message.to, ['mehek@example.com']);
    assert.equal(message.reply_to, 'recruiting@example.com');
    assert.match(message.subject, /^\[Litos application\] Interview request$/);
    assert.match(message.html ?? '', /Can you meet Friday\?/);
    assert.doesNotMatch(message.html ?? '', /mehek@example\.com/);
  });
});

test('inbound dedupe key is provider-stable or body-stable', () => {
  assert.equal(
    inboundDedupeKey({
      aliasId: 'alias-1',
      providerMessageId: 'provider-123',
      subject: 'Receipt',
    }),
    'provider:alias-1:provider-123',
  );
  assert.equal(
    inboundDedupeKey({
      aliasId: 'alias-1',
      fromEmail: 'recruiting@example.com',
      subject: 'Receipt',
      textBody: 'Thanks',
    }),
    inboundDedupeKey({
      aliasId: 'alias-1',
      fromEmail: 'RECRUITING@example.com',
      subject: 'Receipt',
      textBody: 'Thanks',
    }),
  );
});

test('html can be converted to a readable forwarding text fallback', () => {
  assert.equal(plainTextFromHtml('<p>Hello<br>World</p><p>A &amp; B</p>'), 'Hello\nWorld\n\nA & B');
});

test('duplicate inbound messages retry forwarding until a forward succeeds', async () => {
  const source = await readFile('src/lib/applicationEmail.ts', 'utf8');
  assert.match(source, /onConflictDoNothing\(\{ target: application_email_messages\.dedupe_key \}\)/);
  assert.match(source, /where\(eq\(application_email_messages\.dedupe_key, dedupeKey\)\)/);
  assert.match(source, /if \(message\.forwarded_at\) return \{ status: 'duplicate'/);
  assert.match(source, /forwarding_claimed_at: new Date\(\)/);
  assert.match(source, /forwarding_claimed_at} is null/);
  assert.match(source, /forwarding_claimed_at} < now\(\) - interval '10 minutes'/);
  assert.match(source, /set\(\{ forwarded_message_id: forwardedId, forwarded_at: new Date\(\), forward_error: null \}\)/);
  assert.match(source, /forwarding_claimed_at: null/);
});
