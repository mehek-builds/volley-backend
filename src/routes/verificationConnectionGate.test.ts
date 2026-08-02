import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('both permission writers require an active inbox connection', async () => {
  const routes = await readFile('src/routes/onboarding.ts', 'utf8');
  const complete = routes.slice(routes.indexOf("post('/onboarding/complete'"), routes.indexOf("put('/onboarding/automation'"));
  const automation = routes.slice(routes.indexOf("put('/onboarding/automation'"));

  assert.match(routes, /async function verificationConnectionProblem/);
  assert.match(routes, /hasActiveEmailConnection\(userId\)/);
  assert.match(complete, /verificationConnectionProblem\(userId, parsed\.data\)/);
  assert.match(automation, /verificationConnectionProblem\(userId, parsed\.data\)/);
});

test('disconnecting an inbox revokes automatic verification consent', async () => {
  const routes = await readFile('src/routes/emailConnections.ts', 'utf8');
  const disconnect = routes.slice(routes.indexOf("delete('/email-connections/:provider'"));

  assert.match(disconnect, /disconnectEmailProvider\(userId, parsed\.data\.provider\)/);
  assert.match(disconnect, /hasActiveEmailConnection\(userId\)/);
  assert.match(disconnect, /if \(!anotherInboxIsConnected\)/);
  assert.match(disconnect, /automatic_verification_enabled: false/);
  assert.match(disconnect, /automatic_verification_consented_at: null/);
});
