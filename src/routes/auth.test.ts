import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { buildVerificationEmail, sendVerificationEmail } from './auth';

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
