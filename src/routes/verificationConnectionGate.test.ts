import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('both permission writers require a proven verification email source', async () => {
  const routes = await readFile('src/routes/onboarding.ts', 'utf8');
  const complete = routes.slice(routes.indexOf("post('/onboarding/complete'"), routes.indexOf("put('/onboarding/automation'"));
  const automation = routes.slice(routes.indexOf("put('/onboarding/automation'"));

  assert.match(routes, /async function verificationConnectionProblem/);
  assert.match(routes, /verificationEmailSource\(userId\)/);
  assert.match(complete, /verificationConnectionProblem\(userId, parsed\.data\)/);
  assert.match(automation, /verificationConnectionProblem\(userId, parsed\.data\)/);
});

test('disconnecting an inbox preserves consent when another verification source remains', async () => {
  const routes = await readFile('src/routes/emailConnections.ts', 'utf8');
  const disconnect = routes.slice(routes.indexOf("delete('/email-connections/:provider'"));

  assert.match(disconnect, /disconnectEmailProvider\(userId, parsed\.data\.provider\)/);
  assert.match(disconnect, /verificationEmailSource\(userId\)/);
  assert.match(disconnect, /if \(!anotherVerificationSource\)/);
  assert.match(disconnect, /automatic_verification_enabled: false/);
  assert.match(disconnect, /automatic_verification_consented_at: null/);
});
