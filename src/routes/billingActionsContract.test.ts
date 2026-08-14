import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { safeReturnRoute } from './billingV2';

const source = readFileSync('src/routes/billingV2.ts', 'utf8');

test('pending actions preserve exact validated dashboard fragments', () => {
  assert.equal(
    safeReturnRoute('/dashboard/settings?from=upgrade#automation'),
    '/dashboard/settings?from=upgrade#automation',
  );
  assert.equal(safeReturnRoute('/billing/return#plan'), '/billing/return#plan');
  assert.equal(safeReturnRoute('https://attacker.example/dashboard#plan'), null);
  assert.equal(safeReturnRoute('/pricing#plan'), null);
});

test('pending action creation validates owned application and real job context', () => {
  const createRoute = source.slice(
    source.indexOf("fastify.post('/billing/actions'"),
    source.indexOf("fastify.get('/billing/actions/:nonce'"),
  );
  assert.match(createRoute, /eq\(applications\.user_id, userId\)/);
  assert.match(createRoute, /eq\(monitored_jobs\.id, parsed\.data\.job_id\)/);
  assert.match(createRoute, /code: 'application_not_found'/);
  assert.match(createRoute, /code: 'job_not_found'/);
  assert.match(createRoute, /code: 'action_context_mismatch'/);
  assert.match(createRoute, /eq\(user_contact_unlocks\.user_id, userId\)/);
  assert.match(createRoute, /eq\(user_contact_unlocks\.contact_id, parsed\.data\.contact_id\)/);
  assert.match(createRoute, /applicationRows\[0\]\.company_scope_key !== contactRows\[0\]\.company_scope_key/);
  assert.match(createRoute, /Application and contact company context do not match/);
  assert.match(createRoute, /code: 'contact_not_found'/);
  assert.match(createRoute, /contact_id: parsed\.data\.contact_id \?\? null/);
  assert.match(createRoute, /context_hash: contextHash/);
  assert.match(createRoute, /deterministicActionNonce\(userId, idempotencyKey\)/);
  assert.match(createRoute, /eq\(pending_premium_actions\.user_id, userId\)/);
  assert.match(createRoute, /eq\(pending_premium_actions\.idempotency_binding, idempotencyKey\)/);
  assert.match(createRoute, /pendingActionMatchesContext\(/);
  assert.match(createRoute, /code: 'action_idempotency_conflict'/);
  assert.match(createRoute, /idempotency_binding: idempotencyKey/);
  assert.match(createRoute, /nonce_hash: actionHash\(nonce\)/);
  assert.match(createRoute, /\.onConflictDoNothing\(\)\.returning\(\)/);
  assert.doesNotMatch(createRoute, /randomBytes/);
});

test('pending action consume is an atomic once-only transition', () => {
  const consumeRoute = source.slice(source.indexOf("fastify.post('/billing/actions/:nonce/consume'"));
  assert.match(consumeRoute, /eq\(pending_premium_actions\.state, 'pending'\)/);
  assert.match(consumeRoute, /gt\(pending_premium_actions\.expires_at, consumedAt\)/);
  assert.match(consumeRoute, /\.returning\(\)/);
  assert.match(consumeRoute, /idempotent: true/);
  assert.match(consumeRoute, /idempotent: false/);
  assert.ok(consumeRoute.indexOf('if (!consumed)') > consumeRoute.indexOf('.returning()'));
});

test('pending action read and consume expose the server-bound offer id', () => {
  const readRoute = source.slice(
    source.indexOf("fastify.get('/billing/actions/:nonce'"),
    source.indexOf("fastify.post('/billing/actions/:nonce/consume'"),
  );
  const consumeRoute = source.slice(source.indexOf("fastify.post('/billing/actions/:nonce/consume'"));
  assert.match(readRoute, /offer_id: action\.offer_id/);
  assert.match(consumeRoute, /offer_id: action\.offer_id/);
  assert.match(consumeRoute, /offer_id: current\.offer_id/);
  assert.match(consumeRoute, /offer_id: consumed\.offer_id/);
  assert.match(readRoute, /contact_id: action\.contact_id/);
  assert.match(consumeRoute, /contact_id: action\.contact_id/);
  assert.match(consumeRoute, /contact_id: current\.contact_id/);
  assert.match(consumeRoute, /contact_id: consumed\.contact_id/);
});
