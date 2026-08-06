import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';

const resumeRoute = readFileSync('src/routes/resume.ts', 'utf8');
const indexRoute = readFileSync('src/index.ts', 'utf8');
const schema = readFileSync('src/db/schema.ts', 'utf8');
const route = readFileSync('src/routes/applicationEmail.ts', 'utf8');
const service = readFileSync('src/lib/applicationEmail.ts', 'utf8');

test('application packet generation uses the Litos alias as the employer-facing email', () => {
  assert.match(resumeRoute, /applicationAliasFor\(userId, resumeId\)/);
  assert.match(resumeRoute, /applicationContact = applicationEmail[\s\S]*email: applicationEmail\.alias/);
  assert.match(resumeRoute, /_contact: applicationContact/);
  assert.match(resumeRoute, /_application_email: applicationEmail/);
  assert.match(resumeRoute, /ensureApplicationEmailAlias/);
});

test('application inbox schema and webhook route are registered', () => {
  assert.match(schema, /application_email_aliases/);
  assert.match(schema, /application_email_messages/);
  assert.match(indexRoute, /applicationEmailRoutes/);
  assert.match(route, /\/webhooks\/application-email\/inbound/);
  assert.match(route, /inboundSecretMatches/);
  assert.match(route, /resendReceivedBodySchema/);
  assert.match(route, /retrieveResendReceivedEmail/);
  assert.match(route, /x-litos-webhook-signature/);
  assert.match(route, /\/applications\/:id\/email-messages/);
  assert.match(service, /reply_to: input\.inbound\.from\?\.trim\(\) \|\| input\.alias/);
});
