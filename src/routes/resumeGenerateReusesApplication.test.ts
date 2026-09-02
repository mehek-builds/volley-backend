import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';

const resumeRoute = readFileSync('src/routes/resume.ts', 'utf8');
const canonical = readFileSync('src/routes/canonicalApplications.ts', 'utf8');
const artifactVersions = readFileSync('src/lib/resumeArtifactVersions.ts', 'utf8');

/* TAILORING A POSTING TWICE USED TO FORK THE TRACKER.
 *
 * Measured 2026-09-02 on the live account: 201 application rows collapsed to 95 distinct postings,
 * and 74 rows carried the exact signature of this writer - tracker_state 'applying', review_state
 * 'ready', source_surface 'dashboard', a legacy_generated_resume_id - with 41 inside a duplicate
 * group. 36 of 40 duplicate portal-URL groups shared a SINGLE job_id, an identity the canonical
 * fingerprint collapses, proving the rows never went through canonical intake.
 *
 * The mechanism was the fingerprint: `legacy:${resumeId}` is unique per generation, so the unique
 * index on (user_id, application_fingerprint) could never collide and the insert always succeeded. */

test('the match is the shared canonical predicate, not a second copy of it', () => {
  assert.match(resumeRoute, /import \{ canonicalIdentityMatches \} from '\.\/canonicalApplications'/);
  assert.match(resumeRoute, /ownedLive\.filter\(\(row\) => canonicalIdentityMatches\(row, identity\)\)/);
  assert.match(canonical, /export function canonicalIdentityMatches/);
});

/* THE CASCADE MUST BE EXCLUSIVE, NOT A FALL-THROUGH.
 *
 * A first cut used `a ?? b ?? c`. Because resumeRequestSchema requires portal_url inside
 * body.application, rung 3 was reachable ONLY when the portal URL named no row - exactly the state
 * that means "a posting I do not have", which must insert. Instead it fell through to
 * company-scope + role and adopted a DIFFERENT posting at the same employer: two seasons of one
 * internship, two locations of one req, or two employers sharing a name. The victim row had its
 * portal_url rewritten and its prepared packet destroyed. */
test('canonicalIdentityMatches returns on jobId, then on portalUrl, before company and role', () => {
  const body = canonical.slice(
    canonical.indexOf('export function canonicalIdentityMatches'),
    canonical.indexOf('function canonicalAliasMatches'),
  );
  assert.match(body, /if \(input\.jobId\) return row\.job_id === input\.jobId;/);
  assert.match(body, /if \(input\.portalUrl\) return safeStoredPortalUrl\(row\.portal_url\) === input\.portalUrl;/);
  // The role/company arm is last and therefore unreachable while either identity is present.
  assert.ok(body.indexOf('input.jobId') < body.indexOf('input.portalUrl'));
  assert.ok(body.indexOf('input.portalUrl') < body.indexOf('roleMatches'));
  // And resume.ts must not reintroduce its own ladder.
  assert.doesNotMatch(resumeRoute, /ownedLive\.find\([^)]*\)\s*\n?\s*\?\?/);
});

/* THE ADOPTED ROW IS NOT WRITTEN HERE, AND THAT IS THE FIX.
 *
 * linkGeneratedPacketToCanonicalApplication already repoints legacy_generated_resume_id and
 * selected_resume_artifact_id, and its terminalLifecycle arm keeps a submitted/applied row on its
 * existing state rather than resetting it. A hand-rolled update alongside it could only duplicate
 * or contradict it - the first cut did both, clearing submission_state and the resume pointers on a
 * row whose prepared hold the link helper then had to reconcile. */
test('adoption writes nothing to the row and leaves the link helper to repoint it', () => {
  const adoptStart = resumeRoute.indexOf('const matches = ownedLive.filter');
  // fromIndex: `canonicalApplicationId = randomUUID()` also appears in the earlier resume-only
  // branch, so the adoption branch must be bounded by the NEXT one after the match.
  const branch = resumeRoute.slice(adoptStart, resumeRoute.indexOf('canonicalApplicationId = randomUUID();', adoptStart));
  assert.ok(branch.length > 0, 'adoption branch slice must not be empty');
  assert.doesNotMatch(branch, /tx\.update\(applications\)/);
  assert.match(branch, /canonicalApplicationId = existing\.id;/);
  assert.match(resumeRoute, /await linkGeneratedPacketToCanonicalApplication\(tx, \{/);
  assert.match(artifactVersions, /terminalLifecycle/);
});

/* job_id and portal_url are two of the three inputs application_fingerprint is derived from.
 * Rewriting them without re-deriving the fingerprint leaves a row whose stored identity names a
 * posting it no longer points at, which canonical intake would then reclaim as a separate row. */
test('adoption never rewrites the identity the fingerprint is derived from', () => {
  const adoptStart = resumeRoute.indexOf('const matches = ownedLive.filter');
  // fromIndex: `canonicalApplicationId = randomUUID()` also appears in the earlier resume-only
  // branch, so the adoption branch must be bounded by the NEXT one after the match.
  const branch = resumeRoute.slice(adoptStart, resumeRoute.indexOf('canonicalApplicationId = randomUUID();', adoptStart));
  assert.ok(branch.length > 0, 'adoption branch slice must not be empty');
  // Assignment form only - the comment above the branch names these fields on purpose.
  const code = branch.replace(/\/\*[\s\S]*?\*\//g, '');
  assert.doesNotMatch(code, /job_id:/);
  assert.doesNotMatch(code, /portal_url:/);
  assert.doesNotMatch(code, /application_fingerprint/);
});

/* The read and the write must not interleave with a concurrent generation for this user - which is
 * how duplicates were produced in the first place. Same lock, same key, as canonical intake. */
test('the adoption read is taken under the canonical advisory lock, on this transaction', () => {
  assert.match(resumeRoute, /pg_advisory_xact_lock\(hashtextextended\(\$\{`canonical-application:\$\{userId\}`\}/);
  const lockIdx = resumeRoute.indexOf('pg_advisory_xact_lock');
  const readIdx = resumeRoute.indexOf('const ownedLive = await tx.select()');
  assert.ok(lockIdx > 0 && readIdx > lockIdx, 'the lock must precede the read');
  assert.match(canonical, /pg_advisory_xact_lock\(hashtextextended\(\$\{`canonical-application:\$\{input\.userId\}`\}/);
});

/* Which row is adopted must not be decided by the query plan, precisely in the duplicated state
 * this exists to end. A row already carrying a packet outranks an empty one; the ordered select
 * breaks the remaining tie. */
test('the adopted row is chosen deterministically', () => {
  assert.match(resumeRoute, /\.orderBy\(applications\.created_at, applications\.id\)/);
  assert.match(resumeRoute, /matches\.find\(\(row\) => Boolean\(row\.legacy_generated_resume_id\)\) \?\? matches\[0\]/);
});

test('a resume-only generation still never adopts a prepared application', () => {
  assert.match(resumeRoute, /\} else if \(!body\.application\) \{/);
  const bareIndex = resumeRoute.indexOf('} else if (!body.application) {');
  const adoptIndex = resumeRoute.indexOf('const ownedLive = await tx.select()');
  assert.ok(bareIndex > 0 && adoptIndex > bareIndex);
});

test('a genuinely new posting still inserts exactly one row', () => {
  assert.match(resumeRoute, /canonicalApplicationId = randomUUID\(\);\n\s+await tx\.insert\(applications\)\.values\(\{/);
  assert.match(resumeRoute, /application_fingerprint: `legacy:\$\{resumeId\}`/);
});
