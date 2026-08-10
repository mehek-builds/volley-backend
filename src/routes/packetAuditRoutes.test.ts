import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const applications = readFileSync('src/routes/applications.ts', 'utf8');
const runner = readFileSync('src/routes/submissionRunner.ts', 'utf8');

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

test('every employer-bound path names the current packet audit gate', () => {
  const submitRequest = routeSlice("'/applications/:id/submit-request'", "'/applications/:id/submission'");
  const approve = routeSlice("'/applications/:id/submission/approve'", "registerWorkdayVerificationRoute");
  const extensionStart = routeSlice("'/applications/:id/submission/extension-start'", "'/applications/:id/submission/extension-outcome'");
  const extensionOutcome = routeSlice("'/applications/:id/submission/extension-outcome'", "'/applications/:id/resume'");
  assert.match(submitRequest, /currentPacketAudit/);
  assert.match(approve, /currentPacketAudit/);
  assert.match(extensionStart, /currentPacketAudit/);
  assert.match(extensionStart, /precheckPacketVersion = auditVerdict\.audit\.packet_version/);
  assert.match(extensionStart, /submission_packet_version: precheckPacketVersion!/);
  assert.match(extensionOutcome, /currentPacketAudit/);
  assert.match(extensionOutcome, /current\.submission_packet_version !== outcomeAudit\.audit\.packet_version/);
  assert.match(extensionOutcome, /JSON\.stringify\(row\.spec\)/);
  const handoffComplete = routeSlice("'/applications/:id/submission/handoff-complete'", "'/applications/:id/submission/approve'");
  assert.match(handoffComplete, /currentPacketAudit/);
  assert.match(handoffComplete, /JSON\.stringify\(row\.spec\)/);
  const securityCode = routeSlice("'/applications/:id/security-code'", "'/applications/:id/status'");
  assert.match(securityCode, /currentPacketAudit/);
  assert.match(runner, /currentPacketAudit/);
});
