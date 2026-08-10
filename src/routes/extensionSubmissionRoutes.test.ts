import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

const source = readFileSync('src/routes/applications.ts', 'utf8');

test('extension submission routes keep auth, ownership, quota, and claims server-side', () => {
  assert.match(source, /submission\/extension-start'[\s\S]*?preHandler: requireAuth/);
  assert.match(source, /submission\/extension-outcome'[\s\S]*?preHandler: requireAuth/);
  assert.match(source, /pg_advisory_xact_lock\(hashtext/);
  assert.match(source, /eq\(generated_resumes\.user_id, userId\)/);
  assert.match(source, /submission_claimed_at' is null/);
  assert.match(source, /submission_claim_id' = \$\{parsed\.data\.claim_id\}/);
  assert.match(source, /submission_claim_id'->|submission_claim_id/);
});

test('attended extension refill returns the exact owned generated packet and a fresh resume capability', () => {
  const route = source.slice(
    source.indexOf("'/applications/:id/submission/extension-packet'"),
    source.indexOf("'/applications/:id/submission/extension-start'"),
  );
  assert.match(route, /preHandler: requireAuth/);
  assert.match(route, /const row = await ownedResume\(request, reply\)/);
  assert.match(route, /extensionPacketQuerySchema\.safeParse\(request\.query\)/);
  assert.match(route, /extensionHandoffPacketMatches\(/);
  assert.match(route, /row\.resume_object_key/);
  assert.match(route, /mintDownloadToken\([\s\S]*?row\.resume_object_key/);
  assert.match(route, /resume_id: row\.id/);
  assert.match(route, /application: \{ id: row\.id, spec: stored \}/);
  assert.doesNotMatch(route, /resume\/generate/);
  assert.ok(route.indexOf('ownedResume(request, reply)') < route.indexOf('extensionHandoffPacketMatches('));
  assert.ok(route.indexOf('extensionHandoffPacketMatches(') < route.indexOf('mintDownloadToken('));
});

test('extension outcomes only mark confirmed claims applied', () => {
  assert.match(source, /parsed\.data\.outcome === 'confirmed'[\s\S]*?pipeline_stage: 'applied'/);
  assert.match(source, /current\.submission_claim_id !== parsed\.data\.claim_id/);
  assert.match(source, /extensionReceiptUrlSchema/);
});

test('attended handoff can record a user-confirmed submission without an ATS key', () => {
  assert.match(source, /handoffCompleteBodySchema/);
  assert.match(source, /submission\/handoff-complete'[\s\S]*?preHandler: requireAuth/);
  assert.match(source, /parsed\.data\.outcome === 'submitted'/);
  assert.match(source, /!current\.browser_session_id/);
  assert.match(source, /source: 'attended_handoff'/);
  assert.match(source, /pipeline_stage: 'applied'/);
  assert.match(source, /Submitted by the applicant in the live company page/);
  const handler = source.slice(source.indexOf("'/applications/:id/submission/handoff-complete'"));
  /* The check moved into preparedRunHandoffExpired, so this used to look for a field name the
     handler no longer spells. indexOf then returned -1, which is less than everything, and the
     ordering assertion passed while measuring nothing. Anchored on the call and on its presence, so
     renaming it again fails here rather than going quiet. */
  const expiryGate = handler.indexOf('preparedRunHandoffExpired(current)');
  assert.ok(expiryGate >= 0, 'the handoff completion must still consult the expiry gate');
  assert.ok(
    expiryGate < handler.indexOf("parsed.data.outcome === 'submitted'"),
    'expired handoffs must be rejected before either completion outcome mutates state',
  );
});
