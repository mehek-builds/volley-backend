import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const applications = readFileSync(join(process.cwd(), 'src/routes/applications.ts'), 'utf8');

test('every applications-router duplicate refusal uses the shared full response contract', () => {
  assert.match(applications, /unidentifiableDuplicateApplicationResponse,/);
  assert.match(applications, /function duplicateRiskResponse[\s\S]*?: unidentifiableDuplicateApplicationResponse\(verdict\);/);
  assert.doesNotMatch(
    applications,
    /function duplicateRiskResponse[\s\S]*?code: 'DUPLICATE_RISK_UNIDENTIFIABLE'[\s\S]*?application_id:/,
  );
});

test('submit-request and final approval both spread the one duplicate response helper', () => {
  const submitRequest = applications.slice(
    applications.indexOf("'/applications/:id/submit-request'"),
    applications.indexOf("'/applications/:id/submission/approve'"),
  );
  const finalApproval = applications.slice(
    applications.indexOf("'/applications/:id/submission/approve'"),
  );
  assert.match(submitRequest, /duplicateRiskResponse\(duplicateVerdict\)/);
  assert.match(finalApproval, /duplicateRiskResponse\(approvalDuplicate\)/);
});
