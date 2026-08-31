import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

const source = readFileSync('src/routes/applications.ts', 'utf8');

test('extension submission routes keep auth, ownership, quota, and claims server-side', () => {
  assert.match(source, /submission\/extension-start'[\s\S]*?preHandler: requireAuth/);
  assert.match(source, /submission\/extension-outcome'[\s\S]*?preHandler: requireAuth/);
  assert.match(source, /await lockSubmissionAttemptUser\(tx, userId\)/);
  assert.match(source, /eq\(generated_resumes\.user_id, userId\)/);
  assert.match(source, /submission_claimed_at' is null/);
  assert.match(source, /submission_claim_id' = \$\{parsed\.data\.claim_id\}/);
  assert.match(source, /submission_claim_id'->|submission_claim_id/);
});

test('Free attended submissions stay manual while standing consent remains entitlement-gated', () => {
  const route = source.slice(
    source.indexOf("'/applications/:id/submission/extension-start'"),
    source.indexOf("'/applications/:id/submission/extension-outcome'"),
  );
  assert.match(route, /parsed\.data\.authorization === 'standing_consent'/);
  assert.match(route, /consentRow\?\.automatic_submission_enabled === true/);
  assert.match(route, /consentRow\.automatic_submission_consent_version === AUTOMATIC_SUBMISSION_CONSENT_VERSION/);
  assert.match(route, /await getEntitlementSnapshot\(userId, new Date\(\), tx\)/);
  assert.doesNotMatch(route, /requireFeature\(/);
  assert.ok(
    route.indexOf("parsed.data.authorization === 'standing_consent'")
      < route.indexOf('await getEntitlementSnapshot(userId, new Date(), tx)'),
    'only the standing-consent branch should spend automatic-submission entitlement',
  );
});

test('standing-consent extension authority is revalidated under lock and returns its exact expiry', () => {
  const route = source.slice(
    source.indexOf("'/applications/:id/submission/extension-start'"),
    source.indexOf("'/applications/:id/submission/extension-outcome'"),
  );
  const transaction = route.slice(route.indexOf('const runExtensionStartTransaction'));
  const lock = transaction.indexOf('await lockSubmissionAttemptUser(tx, userId)');
  const consent = transaction.indexOf('AUTOMATIC_SUBMISSION_CONSENT_VERSION', lock);
  const entitlement = transaction.indexOf('await getEntitlementSnapshot(userId, new Date(), tx)', consent);
  const opening = transaction.indexOf("eventKind: 'attempt_opened'", entitlement);
  const authorization = transaction.indexOf('authorizeFinalSubmissionBoundary(binding', opening);
  assert.ok(lock >= 0 && consent > lock && entitlement > consent && opening > entitlement
    && authorization > opening);
  assert.match(route, /activation_id: result\.activationId/);
  assert.match(route, /activation_lease_id: result\.activationLeaseId/);
  assert.match(route, /activation_expires_at: result\.activationExpiresAt/);
  assert.match(transaction, /activationServerNow: authorization\.authorization\.serverNow/);
  assert.match(route, /activation_server_now: result\.activationServerNow/);
  assert.match(route, /activation_contract: 'server-lease-v1'/);
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

test('attended extension start validates every supplied binding and carries one audited question snapshot into its exact-CAS claim', () => {
  const route = source.slice(
    source.indexOf("'/applications/:id/submission/extension-start'"),
    source.indexOf("'/applications/:id/submission/extension-outcome'"),
  );
  assert.match(route, /extensionStartHandoffBinding\(/);
  assert.match(route, /binding === 'missing'/);
  assert.match(route, /binding === 'mismatch'/);
  assert.match(route, /binding === 'stale'/);
  assert.doesNotMatch(route, /extension_handoff_url\).*binding/);
  assert.match(route, /const packetQuestions = resolvePacketAuditQuestionFixpoint\(/);
  assert.match(route, /questions:\s*packetQuestions/);
  assert.match(route, /precheckPacketQuestions = packetQuestions/);
  assert.match(route, /const refreshedQuestions = precheckPacketQuestions;/);
  assert.equal(route.match(/resolvePacketAuditQuestionFixpoint\(/g)?.length, 1,
    'the transaction must not produce a second question identity from a later profile or clock read');
  assert.equal(route.match(/loadSensitiveQuestionProfile\(/g)?.length, 1,
    'the profile that produced the audited snapshot must also drive the send-time sensitive gate');
  assert.doesNotMatch(route, /parsed\.data\.handoff_version && !isDeepStrictEqual/,
    'legacy clients without a handoff version must not be allowed to send a second snapshot');
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
  const route = source.slice(
    source.indexOf("'/applications/:id/submission/extension-outcome'"),
    source.indexOf("'/applications/:id/resume'"),
  );
  assert.match(route, /questions:\s*current\.questions/,
    'a receipt must bind to the stored snapshot the extension sent');
  assert.match(route, /authorization\.activationId !== parsed\.data\.activation_id/);
  assert.match(route, /authorization\.leaseId !== parsed\.data\.activation_lease_id/);
  assert.match(route, /authorization\.expiresAt !== parsed\.data\.activation_expires_at/);
  assert.doesNotMatch(route, /resolvedPacketAuditQuestions\(/,
    'post-send profile or clock drift must not prevent receipt recording');
});

test('attended handoff submission records either an exact retained receipt or an applicant attestation', () => {
  assert.match(source, /handoffCompleteBodySchema/);
  assert.match(source, /submission\/handoff-complete'[\s\S]*?preHandler: requireAuth/);
  const handler = source.slice(
    source.indexOf("'/applications/:id/submission/handoff-complete'"),
    source.indexOf("'/applications/:id/submission/self-submitted'"),
  );
  assert.match(handler, /parsed\.data\.outcome === 'submitted' && current\.browser_session_id/);
  assert.match(handler, /getBrowserSession\(current\.browser_session_id\)/);
  assert.match(handler, /connectToSession\(session\)/);
  assert.match(handler, /observedReceipt = await readReceipt\(connected\.page\)/);
  assert.match(handler, /extensionEmployerReceiptIsSufficient\([\s\S]*?confirmationText: observedReceipt\.confirmationText[\s\S]*?finalUrl: observedReceipt\.finalUrl/);
  assert.match(handler, /await lockSubmissionAttemptUser\(tx, userId\)[\s\S]*?\.for\('update'\)/);
  assert.match(handler, /const applicantAttestation = !observedReceipt/);
  assert.match(handler, /applicantFoundSubmissionReceiptText\(/);
  assert.match(handler, /evidenceCode: applicantAttestation \? 'applicant_found_submission' : 'attended_receipt_confirmed'/);
  assert.match(handler, /authoritativeConfirmedProjectionMatches/);
  assert.match(handler, /source: 'attended_handoff'/);
  assert.match(handler, /pipeline_stage: 'applied'/);
  assert.doesNotMatch(handler, /confirmation_text: parsed\.data\.confirmation_text/);
  assert.doesNotMatch(handler, /final_url: parsed\.data\.final_url/);
});
