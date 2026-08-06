#!/usr/bin/env node

import { spawnSync } from 'node:child_process';

const endpoint = process.env.LITOS_APPLICATION_EMAIL_WEBHOOK_URL?.trim()
  || 'https://student-outreach-backend.vercel.app/webhooks/application-email/inbound';
const apiKey = process.env.RESEND_API_KEY?.trim();

function die(message, code = 1) {
  console.error(message);
  process.exit(code);
}

function redactedError(error) {
  return String(error?.message ?? error)
    .replace(/re_[A-Za-z0-9_\\-]+/g, 're_[redacted]')
    .replace(/Bearer\\s+\\S+/gi, 'Bearer [redacted]');
}

async function resend(path, init = {}) {
  const response = await fetch(`https://api.resend.com${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json',
      ...(init.headers || {}),
    },
  });
  const text = await response.text();
  let body;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { raw: text };
  }
  if (!response.ok) {
    throw new Error(`Resend ${path} failed with ${response.status}: ${JSON.stringify(body)}`);
  }
  return body;
}

function vercelEnvSet(name, value) {
  const result = spawnSync('vercel', [
    'env',
    'add',
    name,
    'production',
    '--value',
    value,
    '--yes',
    '--force',
  ], { encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`vercel env add ${name} failed: ${result.stderr || result.stdout}`);
  }
}

async function main() {
  if (!apiKey) die('RESEND_API_KEY is not set or is not readable in this environment.', 2);

  const existing = await resend('/webhooks');
  const webhooks = Array.isArray(existing.data) ? existing.data : [];
  const match = webhooks.find((webhook) =>
    webhook?.endpoint === endpoint
    && Array.isArray(webhook.events)
    && webhook.events.includes('email.received'));

  if (match?.signing_secret) {
    vercelEnvSet('RESEND_WEBHOOK_SECRET', match.signing_secret);
    console.log(`Ready: reused Resend email.received webhook ${match.id} and stored its signing secret.`);
    return;
  }

  if (match) {
    console.log(`Found existing webhook ${match.id}, but Resend did not return its signing secret.`);
    console.log('Create a replacement webhook or copy the signing secret from Resend into RESEND_WEBHOOK_SECRET.');
    return;
  }

  const created = await resend('/webhooks', {
    method: 'POST',
    body: JSON.stringify({
      endpoint,
      events: ['email.received'],
    }),
  });
  const webhook = created.data || created;
  const secret = webhook.signing_secret || webhook.signingSecret;
  if (!secret) {
    die(`Created webhook ${webhook.id || '(unknown id)'}, but Resend did not return a signing secret. Copy it manually into RESEND_WEBHOOK_SECRET.`, 3);
  }

  vercelEnvSet('RESEND_WEBHOOK_SECRET', secret);
  console.log(`Ready: created Resend email.received webhook ${webhook.id} and stored its signing secret.`);
}

main().catch((error) => die(redactedError(error)));
