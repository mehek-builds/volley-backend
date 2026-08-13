/* ANCHORS ACCEPT AN OPTIONS ARGUMENT.
   These guards pin WHICH gate each employer-bound path calls, not how many arguments it takes.
   currentPacketAudit gained a second parameter (restoreExpiredResume) so a send path can rebuild a
   packet whose file aged out of the 30-day retention window, and matching `(row)` exactly turned
   every one of these into a check on the arity instead of on the gate. `(row[,)]` keeps the
   property that matters: the call is to the audit gate, on this row. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const applications = readFileSync('src/routes/applications.ts', 'utf8');
const runner = readFileSync('src/routes/submissionRunner.ts', 'utf8');
const resume = readFileSync('src/routes/resume.ts', 'utf8');

function routeSlice(start: string, end: string): string {
  const from = applications.indexOf(start);
  const to = applications.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, `route slice ${start} was not found`);
  return applications.slice(from, to);
}

test('packet audit endpoint is owner scoped and persists only with exact packet CAS', () => {
  const route = routeSlice("'/applications/:id/packet-audit'", "'/applications/:id/submission/extension-packet'");
  assert.match(route, /ownedResume\(request, reply\)/);
  /* Was /createAndPersistPacketAudit\(row\)/. The constructor now takes the refreshed question
   * set, so that the audit it persists carries the same packet_version the send gate computes.
   * See the deadlock test at the bottom of this file. */
  assert.match(route, /createAndPersistPacketAudit\(row,\s*\{\s*questions:\s*auditQuestions\s*\}\)/);
  assert.match(route, /currentPacketAudit\(row[,)]/);
  assert.match(route, /allowHourly\(request\.jwtPayload!\.userId, 'packet-audit', LIMITS\.perHour\.packetAudit\)/);
  assert.match(route, /PACKET_AUDIT_STALE/);
  assert.match(route, /result\.audit\.bindings\.pdf\.sha256/);
  assert.match(route, /result\.audit\.bindings\.pdf\.sizeBytes/);
  assert.match(route, /mintDownloadToken/);
});

test('extension packet refuses missing, stale, or unacknowledged server audit before disclosure', () => {
  const route = routeSlice("'/applications/:id/submission/extension-packet'", "'/applications/:id/submission/extension-start'");
  const audit = route.indexOf('currentAcknowledgedPacketAudit(row');
  const response = route.indexOf('resume_url:');
  assert.ok(audit >= 0 && response > audit);
  assert.match(route, /packet_audit: auditVerdict\.audit/);
});

test('packet acknowledgement binds the exact rendered audit and PDF with an exact CAS', () => {
  const route = routeSlice("'/applications/:id/packet-audit/acknowledge'", "'/applications/:id/submission/extension-packet'");
  assert.match(route, /currentPacketAudit\(row[,)]/);
  assert.match(route, /parsed\.data\.audit_digest !== audit\.audit_digest/);
  assert.match(route, /parsed\.data\.packet_version !== audit\.packet_version/);
  assert.match(route, /parsed\.data\.pdf_sha256 !== audit\.bindings\.pdf\.sha256/);
  assert.match(route, /parsed\.data\.size_bytes !== audit\.bindings\.pdf\.sizeBytes/);
  assert.match(route, /JSON\.stringify\(row\.spec\)/);
  assert.match(route, /acknowledged: true/);
});

test('manual dashboard navigation comes only from an action-time current acknowledged packet check', () => {
  const route = routeSlice("'/applications/:id/submission/manual-handoff'", "'/applications/:id/submission/extension-packet'");
  const ownership = route.indexOf('ownedResume(request, reply)');
  const audit = route.indexOf('currentAcknowledgedPacketAudit(row');
  const refresh = route.indexOf('const refreshed = await ownedResume(request, reply)', audit);
  const binding = route.indexOf('verifiedDashboardHandoffUrl({');
  const response = route.indexOf('manual_handoff:');
  assert.ok(ownership >= 0 && audit > ownership && refresh > audit && binding > refresh && response > binding);
  assert.match(route, /refreshed\.resume_object_key !== row\.resume_object_key/);
  assert.match(route, /!isDeepStrictEqual\(refreshed\.spec, row\.spec\)/);
  assert.match(route, /frozenUrl: refreshedReview\.portal_url/);
  assert.match(route, /frozenHandoffUrl: refreshedReview\.extension_handoff_url/);
  assert.match(route, /frozenAtsName: refreshedReview\.ats_name/);
  assert.match(route, /status: refreshedReview\.status/);
  assert.match(route, /attentionReason: refreshedReview\.attention_reason/);
  assert.match(route, /attentionCategories: refreshedReview\.attention_categories/);
  assert.match(route, /submissionClaimedAt: refreshedReview\.submission_claimed_at/);
  assert.match(route, /submissionClaimId: refreshedReview\.submission_claim_id/);
  assert.match(route, /submissionPacketVersion: refreshedReview\.submission_packet_version/);
  assert.match(route, /submissionAttemptedAt: refreshedReview\.submission_attempted_at/);
  assert.match(route, /submittedAt: refreshedReview\.submitted_at/);
  assert.match(route, /receipt: refreshedReview\.receipt/);
  assert.match(route, /unverifiedSubmission: refreshedReview\.unverified_submission/);
  assert.match(route, /audit_digest: audit\.audit\.audit_digest/);
  assert.match(route, /packet_version: audit\.audit\.packet_version/);
  assert.match(route, /pdf_sha256: audit\.audit\.bindings\.pdf\.sha256/);
  assert.match(route, /size_bytes: audit\.audit\.bindings\.pdf\.sizeBytes/);
});

test('resume generation and edits persist an immutable exact spec-to-PDF binding', () => {
  assert.match(resume, /pdfGenerationBinding: createPdfGenerationBinding\(spec, objectKey, pdfBuffer, applicationContact\.email \?\? ''\)/);
  const edit = routeSlice("'/applications/:id/resume'", "'/applications/:id/review'");
  assert.match(edit, /pdfGenerationBinding: createPdfGenerationBinding\(rendered\.spec, blob\.pathname, rendered\.buffer, contact\.email \?\? ''\)/);
  assert.match(edit, /JSON\.stringify\(row\.spec\)/);
  assert.match(edit, /generated_resumes\.resume_object_key/);
});

test('every employer-bound path names the current packet audit gate', () => {
  const submitRequest = routeSlice("'/applications/:id/submit-request'", "'/applications/:id/submission'");
  const approve = routeSlice("'/applications/:id/submission/approve'", "registerWorkdayVerificationRoute");
  const extensionStart = routeSlice("'/applications/:id/submission/extension-start'", "'/applications/:id/submission/extension-outcome'");
  const extensionOutcome = routeSlice("'/applications/:id/submission/extension-outcome'", "'/applications/:id/resume'");
  assert.match(submitRequest, /currentAcknowledgedPacketAudit/);
  assert.match(approve, /currentAcknowledgedPacketAudit/);
  assert.match(extensionStart, /currentAcknowledgedPacketAudit/);
  assert.match(extensionStart, /precheckPacketVersion = auditVerdict\.audit\.packet_version/);
  assert.match(extensionStart, /submission_packet_version: precheckPacketVersion!/);
  assert.match(extensionOutcome, /currentAcknowledgedPacketAudit/);
  assert.match(extensionOutcome, /current\.submission_packet_version !== outcomeAudit\.audit\.packet_version/);
  assert.match(extensionOutcome, /JSON\.stringify\(row\.spec\)/);
  const handoffComplete = routeSlice("'/applications/:id/submission/handoff-complete'", "'/applications/:id/submission/approve'");
  assert.match(handoffComplete, /currentAcknowledgedPacketAudit/);
  assert.match(handoffComplete, /JSON\.stringify\(row\.spec\)/);
  const securityCode = routeSlice("'/applications/:id/security-code'", "'/applications/:id/status'");
  assert.match(securityCode, /currentAcknowledgedPacketAudit/);
  const runnerSubmit = runner.slice(runner.indexOf('async function submit('), runner.indexOf('export async function finishSecurityCodeSubmission'));
  const runnerAudit = runnerSubmit.indexOf('currentAcknowledgedPacketAudit(row');
  const employerClaim = runnerSubmit.indexOf('claimSubmission(');
  assert.ok(runnerAudit >= 0 && employerClaim > runnerAudit);
});

test('submission polling hides a retained handoff when the current packet identity is no longer valid', () => {
  assert.match(applications, /review\.status === 'filling' \|\| review\.status === 'needs_attention'[\s\S]*currentAcknowledgedPacketAudit\(row[,)]/);
  assert.match(applications, /handoff_packet_valid = audit\.valid/);
  assert.match(applications, /if \(audit\.valid\)[\s\S]*getLiveViewUrl/);
});

test('resume edits refuse a stale personal email before rendering or storing a replacement PDF', () => {
  const editRoute = routeSlice("'/applications/:id/resume'", "'/applications/:id/review'");
  const identityCheck = editRoute.indexOf('const currentResumeEmail = resumeEmailOfRecord');
  assert.ok(identityCheck >= 0);
  assert.ok(identityCheck < editRoute.indexOf('await renderResumePdf'));
  assert.ok(identityCheck < editRoute.indexOf('await put('));
  assert.match(editRoute, /!resumePacketEmailIsCurrent\(contact\.email, currentResumeEmail\)/);
  assert.match(editRoute, /resume_email_regeneration_required/);
});

/* THE CONSTRUCTOR AND THE VERIFIER MUST BE LOOKING AT ONE PACKET.
 *
 * On 2026-08-13, three merges that taught resolvers to ANSWER questions they had previously left
 * blank (#509 declared test-score absence, #515/#518 restrictive_agreements) deadlocked every
 * packet on the owner's account at once. Nothing about the packets changed. What changed is that
 * refreshKnownQuestionAnswers stopped being a no-op for them:
 *
 *   POST /packet-audit  hashed review.questions            -> version A, which she acknowledged
 *   submit-request      hashed refreshKnownQuestionAnswers -> version B, "packet_stale"
 *
 * Both sides recompute their own on every retry, so re-auditing could never converge. Same shape
 * as the answer-provenance deadlock in packetAudit.ts, and the same fix: audit the packet the send
 * gate will check.
 *
 * Asserted on the ROUTE SOURCE rather than through a live audit, deliberately. The failure is that
 * one call site passes a question set the other does not, which is a wiring property; a behavioural
 * test passes whenever the resolvers happen to be no-ops for its fixture, which is exactly the
 * condition that hid this for as long as it was hidden.
 */
test('the packet-audit route audits the refreshed questions the send gate verifies against', () => {
  const route = routeSlice("'/applications/:id/packet-audit'", "'/applications/:id/packet-audit/acknowledge'");

  assert.match(
    route,
    /refreshKnownQuestionAnswers\(/,
    'the audit must refresh known answers, or it hashes a packet that will never be sent',
  );
  assert.match(
    route,
    /currentPacketAudit\(row,\s*\{[^}]*questions:\s*auditQuestions/s,
    'the refreshed set must reach currentPacketAudit',
  );
  assert.match(
    route,
    /createAndPersistPacketAudit\(row,\s*\{\s*questions:\s*auditQuestions\s*\}\)/,
    'and must reach the constructor too, or a first-time audit persists the wrong version',
  );
});
