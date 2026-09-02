import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';

const resumeRoute = readFileSync('src/routes/resume.ts', 'utf8');
const canonical = readFileSync('src/routes/canonicalApplications.ts', 'utf8');

/* TAILORING A POSTING TWICE USED TO FORK THE TRACKER.
 *
 * Measured on 2026-09-02 against the live account: 201 application rows collapsed to 95 distinct
 * postings, and 74 of those rows carried the exact signature of this writer - tracker_state
 * 'applying', review_state 'ready', source_surface 'dashboard', a legacy_generated_resume_id -
 * with 41 of them sitting inside a duplicate group. 36 of 40 duplicate portal-URL groups shared a
 * SINGLE job_id, which the canonical fingerprint would have collapsed, proving the rows were not
 * created through canonical intake at all.
 *
 * The mechanism was the fingerprint: `legacy:${resumeId}` is unique per generation, so the unique
 * index on (user_id, application_fingerprint) could never collide and the insert always succeeded.
 * These tests pin the lookup that now precedes the insert. */

test('resume generation without an application_id adopts the posting\'s existing row', () => {
  assert.match(resumeRoute, /if \(body\.application_id\) \{\n\s+canonicalApplicationId = body\.application_id;/);
  // The identity ladder mirrors canonicalApplicationFingerprint: job row, then portal URL, then scope+role.
  assert.match(resumeRoute, /ownedLive\.find\(\(row\) => effectiveJobId && row\.job_id === effectiveJobId\)/);
  assert.match(resumeRoute, /row\.portal_url === canonicalApplicationPortalUrl/);
  assert.match(resumeRoute, /row\.company_scope_key === companyScopeKey/);
  assert.match(resumeRoute, /row\.role\.trim\(\)\.toLowerCase\(\) === normalizedRole/);
  assert.match(resumeRoute, /canonicalApplicationId = existing\.id/);
});

test('the adoption lookup only ever considers the caller\'s own live rows', () => {
  assert.match(resumeRoute, /tx\.select\(\)\.from\(applications\)\.where\(and\(\n\s+eq\(applications\.user_id, userId\),\n\s+isNull\(applications\.removed_at\),/);
});

test('a row already with the employer keeps the packet it sent', () => {
  assert.match(resumeRoute, /existing\.submission_state === 'submitted'/);
  assert.match(resumeRoute, /isAppliedOrLaterTrackerState\(existing\.tracker_state\)/);
  assert.match(resumeRoute, /if \(!alreadyWithEmployer\) \{/);
  // The repoint is inside the guard, so a submitted row never has its sent packet overwritten.
  const guardIndex = resumeRoute.indexOf('if (!alreadyWithEmployer) {');
  const repointIndex = resumeRoute.indexOf('legacy_generated_resume_id: resumeId,\n                ...(effectiveJobId');
  assert.ok(guardIndex > 0 && repointIndex > guardIndex, 'repoint must sit inside the alreadyWithEmployer guard');
});

test('a genuinely new posting still inserts exactly one row', () => {
  assert.match(resumeRoute, /canonicalApplicationId = randomUUID\(\);\n\s+await tx\.insert\(applications\)\.values\(\{/);
  assert.match(resumeRoute, /application_fingerprint: `legacy:\$\{resumeId\}`/);
});

/* A bare resume tailoring carries status 'resume_ready' and no portal binding. Adopting a prepared
 * application with it would strip that row's portal and answered questions, so it keeps its own row. */
test('a resume-only generation never adopts a prepared application', () => {
  assert.match(resumeRoute, /\} else if \(!body\.application\) \{/);
  const bareIndex = resumeRoute.indexOf('} else if (!body.application) {');
  const adoptIndex = resumeRoute.indexOf('const ownedLive = await tx.select()');
  assert.ok(bareIndex > 0 && adoptIndex > bareIndex, 'the resume-only branch must precede the adoption branch');
});

/* THE ADOPTED ROW CARRIES A NEW PACKET, SO THE OLD PACKET'S PROJECTIONS GO WITH IT.
 * selected_resume_artifact_id left in place would send the PREVIOUS tailored resume to the employer
 * while the review displayed the new one. submission_state left in place would carry a stale
 * needs_attention and its attention_reason onto a packet that was never attempted. */
test('adoption clears every projection derived from the packet it replaced', () => {
  const setBlock = resumeRoute.slice(
    resumeRoute.indexOf('await tx.update(applications).set({'),
    resumeRoute.indexOf('}).where(eq(applications.id, existing.id));'),
  );
  assert.match(setBlock, /submission_state: 'not_started'/);
  assert.match(setBlock, /selected_resume_artifact_id: null/);
  assert.match(setBlock, /resume_attached: false/);
  assert.match(setBlock, /resume_source: 'none'/);
  assert.match(setBlock, /resume_attached_at: null/);
});

test('canonical intake still owns the fingerprint ladder this lookup mirrors', () => {
  assert.match(canonical, /if \(input\.jobId\) return `job:\$\{input\.jobId\}`/);
  assert.match(canonical, /\? `portal:\$\{input\.portalUrl\}`/);
  assert.match(canonical, /: `scope:\$\{input\.companyScopeKey\}:role:\$\{input\.role\.trim\(\)\.toLowerCase\(\)\}`/);
});
