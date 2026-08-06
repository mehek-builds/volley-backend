import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('inbound application email route scans all recipient fields', async () => {
  const route = await readFile('src/routes/applicationEmail.ts', 'utf8');
  assert.match(route, /function allRecipients/);
  for (const field of ['value.to', 'value.recipients', 'value.cc', 'value.envelope_to', 'value.delivered_to', 'value.recipient']) {
    assert.match(route, new RegExp(field.replace('.', '\\.')));
  }
  assert.doesNotMatch(route, /firstRecipient/);
});

test('inbound application email route avoids raw provider payload storage and static string comparison', async () => {
  const route = await readFile('src/routes/applicationEmail.ts', 'utf8');
  assert.match(route, /timingSafeEqual/);
  assert.match(route, /X-Litos-Webhook-Timestamp/i);
  assert.match(route, /X-Litos-Webhook-Signature/i);
  assert.match(route, /createHmac\('sha256'/);
  assert.match(route, /WEBHOOK_MAX_SKEW_MS/);
  assert.match(route, /rawJson:\s*\{/);
  assert.doesNotMatch(route, /rawJson:\s*parsed\.data/);
  assert.doesNotMatch(route, /provided === configured/);
});

test('inbound application email route can accept envelope-only recipient payloads', async () => {
  const route = await readFile('src/routes/applicationEmail.ts', 'utf8');
  assert.match(route, /to:[\s\S]{0,180}\.optional\(\)/);
  assert.match(route, /\.refine\(\(value\) => allRecipients\(value\)\.length > 0/);
});
