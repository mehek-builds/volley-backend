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
  assert.match(resumeRoute, /canonicalAliasMatches,\n\s*canonicalApplicationFingerprint,\n\s*canonicalIdentityMatches,\n\s*canonicalPortalUrl,/);
  assert.match(resumeRoute, /&& canonicalIdentityMatches\(row, identity\)\)/);
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
/* A ROW THAT REACHED THE EMPLOYER IS NEVER ADOPTED.
 *
 * linkGeneratedPacketToCanonicalApplication sets legacy_generated_resume_id and
 * selected_resume_artifact_id UNCONDITIONALLY - only the three lifecycle columns sit inside its
 * terminalLifecycle CASE - so adopting a submitted row would repoint the Tracker at a resume the
 * employer never received, and authoritativeSubmissionProjection compares exactly those two columns.
 * The ranked pick makes this sharper, not softer: it PREFERS a row that already carries a packet,
 * and a submitted row always has one. */
test('a row already with the employer is excluded from adoption', () => {
  assert.match(resumeRoute, /const alreadyWithEmployer = \(row: typeof applications\.\$inferSelect\) =>/);
  assert.match(resumeRoute, /row\.submission_state === 'submitted'/);
  assert.match(resumeRoute, /\|\| isAppliedOrLaterTrackerState\(row\.tracker_state\)/);
  assert.match(resumeRoute, /\.filter\(\(row\) => !alreadyWithEmployer\(row\)\)/);
  // The exclusion must be applied to the candidate set, before the ranked pick.
  const exclIdx = resumeRoute.indexOf('.filter((row) => !alreadyWithEmployer(row))');
  const pickIdx = resumeRoute.indexOf('const existing = matches.find');
  assert.ok(exclIdx > 0 && pickIdx > exclIdx, 'exclusion must precede the pick');
  // And the helper really does set the document pointers unconditionally - the reason for all this.
  const setBlock = artifactVersions.slice(
    artifactVersions.indexOf('const [linked] = await tx.update(applications).set({'),
    artifactVersions.indexOf('}).where(and('),
  );
  assert.match(setBlock, /legacy_generated_resume_id: input\.generatedResumeId,/);
  assert.match(setBlock, /selected_resume_artifact_id: input\.artifactId,/);
  assert.doesNotMatch(setBlock.split('tracker_state:')[0], /terminalLifecycle/);
});

/* Canonical intake matches a canonically fingerprinted row by EXACT fingerprint and reserves
 * identity matching for rows still stamped `legacy:`. Applying the predicate to every live row
 * would adopt rows the extension and website created, which intake would only match exactly. */
test('the candidate row set is ALL THREE of canonical intake arms', () => {
  assert.match(resumeRoute, /const canonicalRow = ownedLive\.find\(\(row\) => row\.application_fingerprint === fingerprint\)/);
  assert.match(resumeRoute, /row\.application_fingerprint\.startsWith\('legacy:'\)/);
  /* The alias arm has NO fingerprint restriction and is the only one that reaches a row carrying a
   * canonical fingerprint other than the one being computed now. Dropping it forks on two ordinary
   * paths: a POST /applications row stamped `job:J` is invisible to a later generation that carries
   * the portal URL but no job_id, and the upsert manufactures the mirror image by rewriting the
   * fingerprint while preserving a merged-in job_id. */
  assert.match(resumeRoute, /const aliases = ownedLive\.filter\(\(row\) => canonicalAliasMatches\(row, \{/);
  assert.match(resumeRoute, /\[canonicalRow, \.\.\.adoptable, \.\.\.aliases\]/);
  // Deduplicated by id, because the three arms overlap.
  assert.match(resumeRoute, /all\.findIndex\(\(other\) => other\.id === row\.id\) === index/);
  assert.match(canonical, /export function canonicalAliasMatches/);
  assert.match(canonical, /const adoptable = owned\.filter\(\(row\) =>\s*\n?\s*row\.application_fingerprint\.startsWith\('legacy:'\)/);
});

/* A FILLED, PARKED FORM IS NOT ADOPTABLE EITHER.
 * `ready_for_final_approval` is a filled employer form with a preview screenshot waiting on her Send
 * press. The link helper deliberately releases that hold on a re-tailor - right when she NAMED the
 * application, surprising when adoption is implicit, because the prepared form would end up
 * referencing a resume it was not filled with. */
test('a prepared, filled packet is excluded from implicit adoption', () => {
  assert.match(resumeRoute, /row\.submission_state === preparedSendLifecycle\.submissionState/);
  assert.match(resumeRoute, /import \{ isAppliedOrLaterTrackerState, preparedSendLifecycle \}/);
});

test('adoption writes nothing to the row and leaves the link helper to repoint it', () => {
  const adoptStart = resumeRoute.indexOf('const canonicalRow = ownedLive.find');
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
  const adoptStart = resumeRoute.indexOf('const canonicalRow = ownedLive.find');
  // fromIndex: `canonicalApplicationId = randomUUID()` also appears in the earlier resume-only
  // branch, so the adoption branch must be bounded by the NEXT one after the match.
  const branch = resumeRoute.slice(adoptStart, resumeRoute.indexOf('canonicalApplicationId = randomUUID();', adoptStart));
  assert.ok(branch.length > 0, 'adoption branch slice must not be empty');
  // Assignment form only - the comment above the branch names these fields on purpose.
  const code = branch.replace(/\/\*[\s\S]*?\*\//g, '');
  assert.doesNotMatch(code, /job_id:/);
  assert.doesNotMatch(code, /portal_url:/);
  // Assignment form: the branch legitimately READS application_fingerprint to match on it.
  assert.doesNotMatch(code, /application_fingerprint:/);
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

/* BOTH SIDES NORMALIZED, OR THE POSTING DOES NOT MATCH ITSELF.
 *
 * canonicalIdentityMatches normalizes only the STORED side (safeStoredPortalUrl) and compares the
 * input verbatim, and canonicalApplicationFingerprint hashes whatever it is handed. Passing the
 * request URL raw makes a posting fail to match itself whenever the stored row differs only by a
 * trailing slash, a #hash, or a utm_/ref/source parameter - exactly the differences canonicalPortalUrl
 * exists to erase - so the dedupe silently does not fire. Intake normalizes before doing either. */
test('the request portal URL is normalized before matching and before the fingerprint', () => {
  assert.match(resumeRoute, /normalizedPortalUrl = canonicalPortalUrl\(canonicalApplicationPortalUrl \?\? undefined\)/);
  const adoptStart = resumeRoute.indexOf('const canonicalRow = ownedLive.find');
  const branch = resumeRoute.slice(resumeRoute.indexOf('let normalizedPortalUrl'), adoptStart);
  // Neither the identity nor the fingerprint may see the raw value.
  assert.doesNotMatch(branch.replace(/\/\*[\s\S]*?\*\//g, ''), /portalUrl: canonicalApplicationPortalUrl/);
  assert.match(branch, /portalUrl: normalizedPortalUrl,[\s\S]*portalUrl: normalizedPortalUrl,/);
  // Guarded: the schema admits http:// and canonicalPortalUrl requires https outside tests.
  assert.match(resumeRoute, /normalizedPortalUrl = null;\n\s*portalIdentityUnusable = Boolean\(canonicalApplicationPortalUrl\);/);
  assert.match(canonical, /const portalUrl = canonicalPortalUrl\(input\.portalUrl \?\? undefined\);/);
});

/* FAILING TO NORMALIZE IS NOT THE SAME AS HAVING NO PORTAL.
 *
 * resumeGenerateBodySchema declares portal_url as z.string().url(), which admits http:// and other
 * schemes; canonicalPortalUrl throws on those outside tests. Leaving normalizedPortalUrl null while
 * a URL WAS supplied drops the exclusive cascade onto the company + role rung - the one arm that can
 * adopt a different posting at the same employer, which is the branch's original critical. An
 * identity Litos cannot canonicalize must therefore adopt NOTHING. */
test('an unusable portal URL adopts nothing rather than falling to company and role', () => {
  assert.match(resumeRoute, /portalIdentityUnusable = Boolean\(canonicalApplicationPortalUrl\)/);
  assert.match(resumeRoute, /const matches = \(portalIdentityUnusable \? \[\] : \[canonicalRow, \.\.\.adoptable, \.\.\.aliases\]\)/);
});

/* A row with no portal of its own is not this posting when this packet has one. The alias arm can
 * reach such a row on a job_id match alone; adopting it strands a ready_to_submit packet on a row
 * whose portal_url is null and - since the identity is deliberately not rewritten - can never
 * acquire one, so every send against it 409s for good. */
test('a portal-less row is not adopted for a packet that has a portal', () => {
  assert.match(resumeRoute, /\.filter\(\(row\) => !normalizedPortalUrl \|\| Boolean\(row\.portal_url\)\)/);
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
