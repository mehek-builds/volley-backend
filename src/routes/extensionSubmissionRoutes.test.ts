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
  assert.match(source, /eq\(generated_resumes\.user_id, request\.jwtPayload!\.userId\)/);
  assert.match(route, /extensionPacketQuerySchema\.safeParse\(request\.query\)/);
  assert.match(route, /extensionHandoffPacketMatches\(/);
  assert.match(route, /frozenHandoffUrl: review\.extension_handoff_url/);
  assert.match(route, /row\.resume_object_key/);
  assert.match(route, /mintDownloadToken\([\s\S]*?row\.resume_object_key/);
  assert.match(route, /resume_id: row\.id/);
  assert.match(route, /handoff_version: handoffVersion/);
  assert.match(route, /extensionHandoffVersion\([\s\S]*?applicationId: row\.id[\s\S]*?resumeObjectKey: row\.resume_object_key[\s\S]*?spec: row\.spec[\s\S]*?jobContext: row\.job_context/);
  /* The whole stored packet still goes to the extension, minus the Blob pointers on any document
   * she attached. This pin used to read `spec: stored`, which is how that payload came to be
   * handing a content script running in the employer's page origin a key that is permanent
   * unauthenticated access to a student's transcript. The extension has no file channel for a
   * document anyway: its only one is the resume capability token minted a few lines above. */
  assert.match(route, /application: \{ id: row\.id, spec: specWithoutDocumentPointers\(stored\) \}/);
  /* And the RAW spec is still what the handoff version hashes, deliberately. That value binds the
   * packet the extension is about to fill; stripping a field out of its input would change every
   * version string on an application that has an attachment. */
  assert.match(route, /extensionHandoffVersion\(\{[\s\S]*?spec: row\.spec,/);
  assert.match(route, /applicant_snapshot: review\.applicant_snapshot/);
  assert.match(route, /review\.ats_name === 'jobvite'[\s\S]*?review\.ats_name === 'icims'[\s\S]*?review\.ats_name === 'oraclecloud'[\s\S]*?!review\.applicant_snapshot/);
  assert.doesNotMatch(route, /resume\/generate/);
  assert.ok(route.indexOf('ownedResume(request, reply)') < route.indexOf('extensionHandoffPacketMatches('));
  assert.ok(route.indexOf('extensionHandoffPacketMatches(') < route.indexOf('mintDownloadToken('));
});

test('attended extension start validates every supplied binding and rejects a changed answer refresh', () => {
  const route = source.slice(
    source.indexOf("'/applications/:id/submission/extension-start'"),
    source.indexOf("'/applications/:id/submission/extension-outcome'"),
  );
  assert.match(route, /extensionStartHandoffBinding\(/);
  assert.match(route, /binding === 'missing'/);
  assert.match(route, /binding === 'mismatch'/);
  assert.match(route, /binding === 'stale'/);
  assert.doesNotMatch(route, /extension_handoff_url\).*binding/);
  assert.match(route, /parsed\.data\.handoff_version && !isDeepStrictEqual\(refreshedQuestions, current\.questions\)/);
  assert.match(route, /isDeepStrictEqual\(refreshedQuestions, current\.questions\)/);
  assert.match(route, /generated_resumes\.spec\} = \$\{JSON\.stringify\(precheckRow\.spec\)\}::jsonb/);
  assert.match(route, /row\.resume_object_key !== precheckRow\.resume_object_key/);
  assert.match(route, /isDeepStrictEqual\(row\.job_context, precheckRow\.job_context\)/);
  assert.match(route, /generated_resumes\.resume_object_key\} is not distinct from \$\{precheckRow\.resume_object_key\}/);
  assert.match(route, /generated_resumes\.job_context\} is not distinct from/);
});

test('review writes compare the complete packet, not only its status', () => {
  const route = source.slice(
    source.indexOf("'/applications/:id/review'"),
    source.indexOf("'/applications/:id/submit-request'"),
  );
  assert.match(route, /eq\(generated_resumes\.user_id, request\.jwtPayload!\.userId\)/);
  assert.match(route, /generated_resumes\.spec\} = \$\{JSON\.stringify\(row\.spec\)\}::jsonb/);
});

test('extension outcomes only mark confirmed claims applied', () => {
  assert.match(source, /parsed\.data\.outcome === 'confirmed'[\s\S]*?pipeline_stage: 'applied'/);
  assert.match(source, /current\.submission_claim_id !== parsed\.data\.claim_id/);
  assert.match(source, /extensionReceiptUrlSchema/);
  assert.match(source, /extensionEmployerReceiptIsSufficient\(/);
  assert.match(source, /outcome === 'confirmed'/);
});

test('attended handoff submission trusts only the retained exact session receipt', () => {
  assert.match(source, /handoffCompleteBodySchema/);
  assert.match(source, /submission\/handoff-complete'[\s\S]*?preHandler: requireAuth/);
  assert.match(source, /parsed\.data\.outcome === 'submitted'/);
  assert.match(source, /!current\.browser_session_id/);
  assert.match(source, /getBrowserSession\(current\.browser_session_id\)/);
  assert.match(source, /connectToSession\(session\)/);
  assert.match(source, /observedReceipt = await readReceipt\(connected\.page\)/);
  assert.match(source, /extensionEmployerReceiptIsSufficient\([\s\S]*?confirmationText: observedReceipt\.confirmationText[\s\S]*?finalUrl: observedReceipt\.finalUrl/);
  assert.match(source, /source: 'attended_handoff'/);
  assert.match(source, /pipeline_stage: 'applied'/);
  assert.doesNotMatch(source, /Submitted by the applicant in the live company page/);
  assert.doesNotMatch(source, /confirmation_text: parsed\.data\.confirmation_text/);
  assert.doesNotMatch(source, /final_url: parsed\.data\.final_url/);
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
