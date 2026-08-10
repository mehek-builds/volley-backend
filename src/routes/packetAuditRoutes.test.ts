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
  assert.match(route, /createAndPersistPacketAudit\(row\)/);
  assert.match(route, /currentPacketAudit\(row\)/);
  assert.match(route, /allowHourly\(request\.jwtPayload!\.userId, 'packet-audit', LIMITS\.perHour\.packetAudit\)/);
  assert.match(route, /PACKET_AUDIT_STALE/);
  assert.match(route, /result\.audit\.bindings\.pdf\.sha256/);
  assert.match(route, /result\.audit\.bindings\.pdf\.sizeBytes/);
  assert.match(route, /mintDownloadToken/);
});

test('extension packet refuses missing or stale server audit before disclosure', () => {
  const route = routeSlice("'/applications/:id/submission/extension-packet'", "'/applications/:id/submission/extension-start'");
  const audit = route.indexOf('currentPacketAudit(row)');
  const response = route.indexOf('resume_url:');
  assert.ok(audit >= 0 && response > audit);
  assert.match(route, /packet_audit: auditVerdict\.audit/);
});

test('packet acknowledgement binds the exact rendered audit and PDF with an exact CAS', () => {
  const route = routeSlice("'/applications/:id/packet-audit/acknowledge'", "'/applications/:id/submission/extension-packet'");
  assert.match(route, /currentPacketAudit\(row\)/);
  assert.match(route, /parsed\.data\.audit_digest !== audit\.audit_digest/);
  assert.match(route, /parsed\.data\.packet_version !== audit\.packet_version/);
  assert.match(route, /parsed\.data\.pdf_sha256 !== audit\.bindings\.pdf\.sha256/);
  assert.match(route, /parsed\.data\.size_bytes !== audit\.bindings\.pdf\.sizeBytes/);
  assert.match(route, /JSON\.stringify\(row\.spec\)/);
  assert.match(route, /acknowledged: true/);
});

test('resume generation and edits persist an immutable exact spec-to-PDF binding', () => {
  assert.match(resume, /pdfGenerationBinding: createPdfGenerationBinding\(spec, objectKey, pdfBuffer\)/);
  const edit = routeSlice("'/applications/:id/resume'", "'/applications/:id/review'");
  assert.match(edit, /pdfGenerationBinding: createPdfGenerationBinding\(rendered\.spec, blob\.pathname, rendered\.buffer\)/);
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
  const runnerAudit = runnerSubmit.indexOf('currentAcknowledgedPacketAudit(row)');
  const employerClaim = runnerSubmit.indexOf('claimSubmission(');
  assert.ok(runnerAudit >= 0 && employerClaim > runnerAudit);
});
