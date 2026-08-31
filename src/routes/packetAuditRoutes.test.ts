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
const canonicalCoverLetters = readFileSync('src/lib/canonicalCoverLetterService.ts', 'utf8');
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
  assert.match(route, /createEmployerDeliveryBindings\(packet, boundReview, deliverySelection\)/);
  assert.match(route, /createAndPersistPacketAudit\(packetRow, \{ review: auditReview \}\)/);
  assert.match(route, /currentPacketAudit\(row[,)]/);
  assert.match(route, /allowHourly\(request\.jwtPayload!\.userId, 'packet-audit', LIMITS\.perHour\.packetAudit\)/);
  assert.match(route, /PACKET_AUDIT_STALE/);
  assert.match(route, /result\.audit\.bindings\.pdf\.sha256/);
  assert.match(route, /result\.audit\.bindings\.pdf\.sizeBytes/);
  assert.match(route, /mintDownloadToken/);
  const canonicalCoverLetter = route.indexOf('reconcileCanonicalCoverLetterForPacket(row)');
  const terminalRefusal = route.indexOf("review.status === 'submitted'");
  const reviewRead = route.indexOf('readApplicationReview(row.spec)', canonicalCoverLetter);
  const packetBuild = route.indexOf('const packet = await buildPacket(', canonicalCoverLetter);
  assert.ok(terminalRefusal >= 0 && canonicalCoverLetter > terminalRefusal
    && reviewRead > canonicalCoverLetter && packetBuild > reviewRead,
    'historical canonical cover-letter selection must be mirrored before audit build but never rewrite sent history');
});

test('packet cover-letter reconciliation retries read-only transactions without repeating Blob recovery', () => {
  const start = canonicalCoverLetters.indexOf('async function reconcileCanonicalCoverLetterAttempt(');
  const end = canonicalCoverLetters.indexOf('export async function reuseCanonicalCoverLetter(', start);
  assert.ok(start >= 0 && end > start, 'canonical cover-letter reconciliation slice was not found');
  const reconciliation = canonicalCoverLetters.slice(start, end);
  const recover = reconciliation.indexOf('dependencies.recoverDocument({');
  const upload = reconciliation.indexOf('dependencies.putObject(restoredKey, recovered.buffer)');
  const beforeLock = reconciliation.indexOf('dependencies.beforeLock?.(attempt)');
  const transaction = reconciliation.indexOf('const runReconcileTransaction =');
  const retry = reconciliation.indexOf('return await withReadOnlyRetry(');
  const directFallback = reconciliation.indexOf('onExhausted: () => withDedicatedDatabase');
  const directTransaction = reconciliation.indexOf('runReconcileTransaction(directDb)');
  const cleanup = reconciliation.indexOf('dependencies.deleteObject(restoredBlob.url)', retry);

  assert.ok(recover >= 0 && upload > recover && beforeLock > upload && transaction > beforeLock
    && retry > transaction && directFallback > retry && directTransaction > directFallback
    && cleanup > directTransaction,
  'one recovered cover-letter Blob must be reused across the database-only retries and cleaned up after final failure');
  assert.match(reconciliation, /withReadOnlyRetry\(\s*\(\) => runReconcileTransaction\(db\)/);
  assert.match(reconciliation, /onExhausted: \(\) => withDedicatedDatabase/);
  assert.match(reconciliation, /runReconcileTransaction\(directDb\)/);
  assert.doesNotMatch(
    reconciliation.slice(transaction, retry),
    /dependencies\.(?:resolveObjectUrl|recoverDocument|putObject|deleteObject|beforeLock)/,
    'the whole-transaction retry callback must remain free of external Blob and hook side effects',
  );
});

test('cover-letter persistence proves read-only state before Blob work in its retried transaction', () => {
  const start = canonicalCoverLetters.indexOf('async function persistCanonicalBody(');
  const end = canonicalCoverLetters.indexOf('export async function generateCanonicalCoverLetter(', start);
  assert.ok(start >= 0 && end > start, 'canonical cover-letter persistence slice was not found');
  const persistence = canonicalCoverLetters.slice(start, end);
  const render = persistence.indexOf('dependencies.renderPdf(');
  const transaction = persistence.indexOf('const runPersistTransaction =');
  const lockedRead = persistence.indexOf('lockedApplication(tx,', transaction);
  const upload = persistence.indexOf('dependencies.putObject(', lockedRead);
  const firstMutation = persistence.indexOf('tx.update(application_artifacts)', transaction);
  const retry = persistence.indexOf('stored = await withReadOnlyRetry(');
  const directFallback = persistence.indexOf('onExhausted: () => withDedicatedDatabase');
  const directTransaction = persistence.indexOf('runPersistTransaction(directDb)');
  const cleanup = persistence.indexOf('dependencies.deleteObject(blobState.current.url)', retry);

  assert.ok(render >= 0 && transaction > render && lockedRead > transaction && upload > lockedRead
    && firstMutation > upload && retry > firstMutation
    && directFallback > retry && directTransaction > directFallback && cleanup > directTransaction,
  'the lock must reject a read-only transaction before Blob upload, with cleanup after final failure');
  assert.match(persistence, /withReadOnlyRetry\(\s*\(\) => runPersistTransaction\(db\)/);
  assert.match(persistence, /onExhausted: \(\) => withDedicatedDatabase/);
  assert.match(persistence, /runPersistTransaction\(directDb\)/);
  assert.doesNotMatch(
    persistence.slice(transaction, retry),
    /dependencies\.(?:renderPdf|deleteObject)/,
    'rendering and cleanup must remain outside the retried transaction',
  );
});

test('the canonical cover-letter lock proves writability before any data-dependent read', () => {
  const start = canonicalCoverLetters.indexOf('async function lockedApplication(');
  const end = canonicalCoverLetters.indexOf('function packetCoverLetterForArtifact(', start);
  assert.ok(start >= 0 && end > start, 'canonical cover-letter lock helper slice was not found');
  const lock = canonicalCoverLetters.slice(start, end);
  const writerProof = lock.indexOf("where(sql`false`).for('update')");
  const candidateRead = lock.indexOf('const [candidate] = await tx.select()');
  const packetLock = lock.indexOf(".limit(1).for('update')", candidateRead);
  const applicationLock = lock.indexOf(".limit(1).for('update')", packetLock + 1);

  assert.ok(writerProof >= 0 && candidateRead > writerProof && packetLock > candidateRead
    && applicationLock > packetLock,
  'writability must be proved before the unlocked lookup while preserving packet-before-application lock order');
});

test('every canonical cover-letter mutation has a direct-writer fallback', () => {
  const expectations = [
    ['reuseCanonicalCoverLetter', 'runReuseTransaction'],
    ['uploadCanonicalCoverLetter', 'runUploadTransaction'],
    ['deleteCanonicalCoverLetters', 'runDeleteTransaction'],
  ] as const;

  for (const [exportName, transactionName] of expectations) {
    const start = canonicalCoverLetters.indexOf(`export async function ${exportName}(`);
    const nextExport = canonicalCoverLetters.indexOf('\nexport ', start + 1);
    const end = nextExport > start ? nextExport : canonicalCoverLetters.length;
    assert.ok(start >= 0 && end > start, `${exportName} slice was not found`);
    const mutation = canonicalCoverLetters.slice(start, end);
    assert.match(mutation, new RegExp(`withReadOnlyRetry\\(\\s*\\(\\) => ${transactionName}\\(db\\)`));
    assert.match(mutation, /onExhausted: \(\) => withDedicatedDatabase/);
    assert.match(mutation, new RegExp(`${transactionName}\\(directDb\\)`));
  }
});

test('cover-letter upload proves read-only state before Blob work in its retried transaction', () => {
  const start = canonicalCoverLetters.indexOf('export async function uploadCanonicalCoverLetter(');
  const end = canonicalCoverLetters.indexOf('export async function deleteCanonicalCoverLetters(', start);
  assert.ok(start >= 0 && end > start, 'canonical cover-letter upload slice was not found');
  const upload = canonicalCoverLetters.slice(start, end);
  const transaction = upload.indexOf('const runUploadTransaction =');
  const lockedRead = upload.indexOf('lockedApplication(tx,', transaction);
  const blobWrite = upload.indexOf('dependencies.putObject(', lockedRead);
  const firstMutation = upload.indexOf('tx.update(application_artifacts)', transaction);
  const retry = upload.indexOf('stored = await withReadOnlyRetry(');
  const cleanup = upload.indexOf('dependencies.deleteObject(blobState.current.url)', retry);

  assert.ok(transaction >= 0 && lockedRead > transaction && blobWrite > lockedRead
    && firstMutation > blobWrite && retry > firstMutation && cleanup > retry,
  'upload must lock before Blob work and clean up only after all writer retries fail');
  assert.doesNotMatch(
    upload.slice(transaction, retry),
    /dependencies\.deleteObject/,
    'cleanup must remain outside the retried transaction',
  );
});

test('extension packet refuses missing, stale, or unacknowledged server audit before disclosure', () => {
  const route = routeSlice("'/applications/:id/submission/extension-packet'", "'/applications/:id/submission/extension-start'");
  const audit = route.indexOf('currentAcknowledgedPacketAudit(row');
  const response = route.indexOf('resume_url:');
  assert.ok(audit >= 0 && response > audit);
  assert.match(route, /packet_audit: auditVerdict\.audit/);
  assert.match(route, /extensionEmployerDeliveryBindingIssue\(/);
  assert.ok(route.indexOf('extensionEmployerDeliveryBindingIssue(') < response,
    'the extension payload must match its audit-time delivery hash before disclosure');
});

test('packet acknowledgement binds the exact rendered audit and PDF with an exact CAS', () => {
  const route = routeSlice("'/applications/:id/packet-audit/acknowledge'", "'/applications/:id/submission/manual-handoff'");
  assert.match(route, /verifyStoredPacketAuditAcknowledgement\(\{/);
  assert.match(route, /audit:\s*review\.packet_audit/);
  assert.match(route, /client:\s*parsed\.data/);
  assert.doesNotMatch(route, /current(?:Acknowledged)?PacketAudit\(/);
  assert.doesNotMatch(route, /resolvedPacketAuditQuestions\(|buildPacket\(|loadApplicationProfileLike\(|resolveFrozenApplicantEmail\(|resolveBlobUrl\(|fetch\(|process\.env/,
    'acknowledgement must do no profile, resolver, file, email, or environment read');
  assert.match(route, /JSON\.stringify\(row\.spec\)/);
  assert.match(route, /generated_resumes\.resume_object_key\} = \$\{row\.resume_object_key\}/);
  assert.match(route, /acknowledged: true/);
  assert.match(route, /if \(!updated\.length\)[\s\S]{0,300}reply\.status\(409\)/,
    'an exact-CAS race must fail closed instead of acknowledging a different saved packet');
  const storedVerify = route.indexOf('verifyStoredPacketAuditAcknowledgement({');
  const timestamp = route.indexOf('acknowledged_at: new Date().toISOString()', storedVerify);
  const cas = route.indexOf('db.update(generated_resumes)', timestamp);
  assert.ok(storedVerify >= 0 && timestamp > storedVerify && cas > timestamp,
    'the clock is read only after pure stored verification and the acknowledgement lands through the exact CAS');
});

test('manual dashboard navigation comes only from an action-time current acknowledged packet check', () => {
  const route = routeSlice("'/applications/:id/submission/manual-handoff'", "'/applications/:id/submission/extension-packet'");
  const ownership = route.indexOf('ownedResume(request, reply)');
  const audit = route.indexOf('currentAcknowledgedPacketAudit(row');
  const transaction = route.indexOf('const result = await db.transaction', audit);
  const lock = route.indexOf('await lockSubmissionAttemptUser(tx, userId)', transaction);
  const binding = route.indexOf('verifiedDashboardHandoffUrl({', lock);
  const response = route.indexOf('manual_handoff:');
  assert.ok(ownership >= 0 && audit > ownership && transaction > audit && lock > transaction
    && binding > lock && response > binding);
  assert.match(route, /const auditedRow = audit\.row/,
    'a retention restore must replace the pre-audit row before the handoff CAS');
  assert.match(route, /locked\.resume_object_key !== auditedRow\.resume_object_key/);
  assert.match(route, /!isDeepStrictEqual\(locked\.job_context, auditedRow\.job_context\)/);
  assert.match(route, /!sameApplicationPacketSpec\(locked\.spec, auditedRow\.spec\)/);
  assert.match(route, /frozenUrl: current\.portal_url/);
  assert.match(route, /frozenHandoffUrl: current\.extension_handoff_url/);
  assert.match(route, /frozenAtsName: current\.ats_name/);
  assert.match(route, /status: current\.status/);
  assert.match(route, /attentionReason: current\.attention_reason/);
  assert.match(route, /attentionCategories: current\.attention_categories/);
  assert.match(route, /submissionClaimedAt: current\.submission_claimed_at/);
  assert.match(route, /submissionClaimId: current\.submission_claim_id/);
  assert.match(route, /submissionPacketVersion: current\.submission_packet_version/);
  assert.match(route, /submissionAttemptedAt: current\.submission_attempted_at/);
  assert.match(route, /submittedAt: current\.submitted_at/);
  assert.match(route, /receipt: current\.receipt/);
  assert.match(route, /unverifiedSubmission: current\.unverified_submission/);
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
  assert.match(extensionOutcome, /JSON\.stringify\(latest\.spec\)/);
  const handoffComplete = routeSlice("'/applications/:id/submission/handoff-complete'", "'/applications/:id/submission/approve'");
  assert.match(handoffComplete, /currentAcknowledgedPacketAudit/);
  assert.match(handoffComplete, /JSON\.stringify\(locked\.spec\)/);
  const securityCode = routeSlice("'/applications/:id/security-code'", "'/applications/:id/status'");
  assert.match(securityCode, /currentAcknowledgedPacketAudit/);
  const runnerSubmit = runner.slice(runner.indexOf('async function submit('), runner.indexOf('export async function finishSecurityCodeSubmission'));
  // submit() verifies through verifiedPacketForRun, which names currentAcknowledgedPacketAudit as
  // its authority; the claim still has to come after the verification.
  const runnerAudit = runnerSubmit.indexOf('verifiedPacketForRun(row, current, currentAcknowledgedPacketAudit)');
  const employerClaim = runnerSubmit.indexOf('claimSubmission(');
  assert.ok(runnerAudit >= 0 && employerClaim > runnerAudit);
});

test('extension start retries read-only transactions without repeating external prechecks', () => {
  const route = routeSlice("'/applications/:id/submission/extension-start'", "'/applications/:id/submission/extension-outcome'");
  const packetAudit = route.indexOf('currentAcknowledgedPacketAudit(precheckRow');
  const duplicateCheck = route.indexOf('refuseDuplicateApplication(precheckRow');
  const resumeVerification = route.indexOf('preSendResumeVerificationIssues(');
  const transaction = route.indexOf('const runExtensionStartTransaction =');
  const retry = route.indexOf('const result = await withReadOnlyRetry(');
  const directFallback = route.indexOf('onExhausted: () => withDedicatedDatabase');
  const directTransaction = route.indexOf('runExtensionStartTransaction(directDb)');

  assert.ok(packetAudit >= 0 && duplicateCheck > packetAudit && resumeVerification > duplicateCheck
    && transaction > resumeVerification && retry > transaction && directFallback > retry
    && directTransaction > directFallback,
  'packet audit, duplicate detection, and resume verification must complete once before database-only retries');
  assert.match(route, /withReadOnlyRetry\(\s*\(\) => runExtensionStartTransaction\(db\)/);
  assert.match(route, /onExhausted: \(\) => withDedicatedDatabase/);
  assert.match(route, /runExtensionStartTransaction\(directDb\)/);
  assert.doesNotMatch(
    route.slice(transaction, retry),
    /currentAcknowledgedPacketAudit|refuseDuplicateApplication|preSendResumeVerificationIssues|\b(?:fetch|put|del)\s*\(/,
    'the whole-transaction retry callback must remain free of external audit, duplicate, network, and storage effects',
  );
});

test('reviewed per-application approval stays free while unattended submission remains entitled', () => {
  const approve = routeSlice("'/applications/:id/submission/approve'", "registerWorkdayVerificationRoute");
  assert.doesNotMatch(approve, /requireFeature|automatic_submission|dashboard_automatic_submission/);
  assert.match(approve, /submission_authorization:[\s\S]*source: 'per_application_approval'/);

  const extensionStart = routeSlice("'/applications/:id/submission/extension-start'", "'/applications/:id/submission/extension-outcome'");
  assert.match(extensionStart, /parsed\.data\.authorization === 'standing_consent'/);
  assert.match(extensionStart, /await getEntitlementSnapshot\(userId, new Date\(\), tx\)/);
  assert.match(extensionStart, /!entitlement\.features\.automatic_submission/);
  assert.doesNotMatch(extensionStart, /requireFeature\(/);
});

test('submission polling hides a retained handoff when the current packet identity is no longer valid', () => {
  assert.match(applications, /review\.status === 'filling' \|\| review\.status === 'needs_attention'[\s\S]*currentAcknowledgedPacketAudit\(row[,)]/);
  assert.match(applications, /handoff_packet_valid = audit\.valid/);
  assert.match(applications, /manual_handoff_available: handoff_packet_valid && manualHandoffAvailable\(review\)/);
});

test('resume edits refuse a stale personal email before rendering or storing a replacement PDF', () => {
  const editRoute = routeSlice("'/applications/:id/resume'", "'/applications/:id/review'");
  const identityCheck = editRoute.indexOf('const currentResumeEmail = resumeEmailOfRecord');
  assert.ok(identityCheck >= 0);
  assert.ok(identityCheck < editRoute.indexOf('await renderResumePdf'));
  assert.match(editRoute, /!resumePacketEmailIsCurrent\(storedContact\.email, currentResumeEmail\)/);
  assert.ok(identityCheck < editRoute.indexOf('await putObject('));
  assert.match(editRoute, /resume_email_regeneration_required/);
});

test('resume edits re-render current phone and residence while preserving packet identity', () => {
  const editRoute = routeSlice("'/applications/:id/resume'", "'/applications/:id/review'");
  const profileRead = editRoute.indexOf('loadApplicationProfileLike(userId)');
  const contactRefresh = editRoute.indexOf('refreshResumeContactFromProfile(');
  const render = editRoute.indexOf('await renderResumePdf');
  const stored = editRoute.indexOf('_contact: contact');

  assert.ok(profileRead >= 0 && contactRefresh > profileRead && render > contactRefresh && stored > render);
  assert.match(editRoute, /refreshResumeContactFromProfile\([\s\S]*storedContact[\s\S]*applicationProfile/);
  assert.match(editRoute, /renderResumePdf\(edited, \{ \.\.\.contact, full_name: contact\.full_name \}/);
});

test('resume edit transaction retries read-only pool failures on the direct writer without repeating uploads', () => {
  const editRoute = routeSlice("'/applications/:id/resume'", "'/applications/:id/review'");
  const upload = editRoute.indexOf('const blob = await putObject(');
  const transaction = editRoute.indexOf('const runResumeEditTransaction =');
  const transactionEnd = editRoute.indexOf('\n\n      let updated:', transaction);
  const retry = editRoute.indexOf('updated = await withReadOnlyRetry(');
  const directFallback = editRoute.indexOf('withDedicatedDatabase((directDb) =>');
  const directTransaction = editRoute.indexOf('runResumeEditTransaction(directDb)');
  const cleanup = editRoute.indexOf('await deleteObjects(blob.pathname).catch', retry);

  assert.ok(upload >= 0 && transaction > upload && transactionEnd > transaction && retry > transactionEnd
    && directFallback > retry && directTransaction > directFallback && cleanup > directTransaction,
  'one uploaded PDF must be reused across the database-only retries and cleaned up after final failure');
  assert.match(editRoute, /withReadOnlyRetry\(\s*\(\) => runResumeEditTransaction\(db\)/);
  assert.match(editRoute, /onExhausted: \(\) => withDedicatedDatabase/);
  assert.doesNotMatch(editRoute.slice(retry, cleanup), /await putObject\(/,
    'the retry callback must not repeat an external Blob write');
  assert.doesNotMatch(editRoute.slice(transaction, transactionEnd), /\b(?:putObject|deleteObjects|fetch)\s*\(/,
    'the whole-transaction retry callback must remain free of external network and storage side effects');
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
    /let auditQuestions = await resolvedPacketAuditQuestions\(row, auditSourceReview\)/,
    'the audit must use the shared normalized and resolved packet reading, or it can hash portal-owned controls acknowledgement drops',
  );
  assert.match(
    route,
    /currentPacketAudit\(row,\s*\{[^}]*questions:\s*auditQuestions/s,
    'the refreshed set must reach currentPacketAudit',
  );
  assert.match(
    route,
    /const canonicalReview: ApplicationReviewState = \{ \.\.\.repairedPacketReview, questions: auditQuestions \}/,
    'the exact question fixpoint must become the review used for packet construction',
  );
  assert.match(
    route,
    /createAndPersistPacketAudit\(packetRow, \{ review: auditReview \}\)/,
    'the exact questions and delivery hashes must reach the constructor together',
  );
  assert.match(
    route,
    /employer_delivery_bindings: createEmployerDeliveryBindings\(packet, boundReview, deliverySelection\)/,
    'the audit must persist the one selected employer delivery mode and exact envelope',
  );
  assert.match(
    route,
    /const packetRow = cached\.valid \? cached\.row : await ownedResume\(request, reply\)/,
    'a retention-restored packet must be the packet whose delivery hashes are built',
  );
});

/* A SECOND DEADLOCK IN THE SAME FAMILY, and the shape is not "one side refreshes and one does not"
 * (that was the 2026-08-13 deadlock above) but "both sides refresh, against two different jdText
 * inputs for what is supposed to be one packet."
 *
 * Every LIVE fill - buildPacket and discoverAndResolveQuestions in routes/submissionRunner.ts -
 * has always resolved known answers against applicationContextForQuestionResolution(row, review),
 * which appends the packet's frozen employer and frozen locations to jd_text. Six other call sites
 * across this file, resume.ts and lib/submittedAnswers.ts independently resolved the SAME question
 * set against review.jd_text bare. resolveKnownAnswer gates several real, common employer field
 * labels - a bare "Source" or "Application Referral" control, several relocation and
 * prior-application labels - on markers that exist ONLY in the enriched context's output, so those
 * labels are deterministically held on jd_text bare and deterministically answered on the enriched
 * context: two different literal answers for one unedited question, hashed into two different
 * packet_version values, with no re-audit able to converge because the audit side kept recomputing
 * on the poorer context. See lib/questionDiscovery.test.ts for the resolver-level proof that the
 * two contexts really do disagree.
 *
 * Measured on production 2026-08-20 on two unrelated employers (Mytos/Lever, Davies-Keoghs/pinpoint):
 * a clean "Review and fill" audit, zero manual edits, then packet_stale on the send.
 *
 * Asserted on the ROUTE SOURCE for the same reason the 2026-08-13 test above is: the failure is a
 * wiring property (which context one call site builds its `questions` argument from), and a
 * behavioural test would pass whenever a fixture's employer/location happened not to matter to any
 * resolver - exactly the condition that let this hide until it hit two real postings in one day. */
test('every pre-send canonicalization uses the shared enriched-context fixpoint and acknowledgement stays on the stored snapshot', () => {
  const packetAudit = routeSlice("'/applications/:id/packet-audit'", "'/applications/:id/packet-audit/acknowledge'");
  assert.match(
    packetAudit,
    /resolvedPacketAuditQuestions\(row, auditSourceReview\)/,
    'the packet-audit endpoint must use the shared normalized and enriched reading',
  );

  const acknowledge = routeSlice("'/applications/:id/packet-audit/acknowledge'", "'/applications/:id/submission/manual-handoff'");
  assert.match(acknowledge, /verifyStoredPacketAuditAcknowledgement\(\{/);
  assert.doesNotMatch(acknowledge, /resolvedPacketAuditQuestions\(/);

  const extensionStart = routeSlice("'/applications/:id/submission/extension-start'", "'/applications/:id/submission/extension-outcome'");
  assert.match(
    extensionStart,
    /const packetQuestions = resolvePacketAuditQuestionFixpoint\(\s*precheckReview,\s*sensitiveProfile,\s*applicationContextForQuestionResolution\(precheckRow, precheckReview\)/,
    'extension-start must construct the audited snapshot once against the enriched context',
  );
  assert.match(extensionStart, /const refreshedQuestions = precheckPacketQuestions;/,
    'the transaction must carry the exact snapshot that passed the precheck');

  const getSubmission = routeSlice("'/applications/:id/submission'", "'/applications/:id/submission/handoff-complete'");
  assert.match(
    getSubmission,
    /resolvePacketAuditQuestionFixpoint\(\s*review,\s*profile,\s*applicationContextForQuestionResolution\(row, review\)/,
    'the dashboard display route must show the same resolution the send will actually compute',
  );

  const approve = routeSlice("'/applications/:id/submission/approve'", "registerWorkdayVerificationRoute");
  assert.match(
    approve,
    /resolvePacketAuditQuestionFixpoint\(\s*current,\s*sensitiveProfile,\s*applicationContextForQuestionResolution\(row, current\)/,
    'submission/approve must not recompute the already-filled packet on jd_text bare before its own audit check',
  );

  const submitRequest = routeSlice("'/applications/:id/submit-request'", "'/applications/:id/submission'");
  assert.match(
    submitRequest,
    /const submitResolutionCurrent = \{ \.\.\.current, jd_text: applicationContextForQuestionResolution\(row, current\) \}[\s\S]*?const canonicalSubmittedQuestions = resolvePacketAuditQuestionFixpoint\([\s\S]*?submitResolutionCurrent\.jd_text/,
    'submit-request must verify and persist the same enriched-context fixpoint used by audit and prepare',
  );
});

test('extension receipt paths verify the captured stored snapshot without post-send resolver drift', () => {
  const extensionOutcome = routeSlice("'/applications/:id/submission/extension-outcome'", "'/applications/:id/resume'");
  assert.match(extensionOutcome, /questions:\s*current\.questions/);
  assert.doesNotMatch(extensionOutcome, /resolvedPacketAuditQuestions\(/);
  assert.match(extensionOutcome, /current\.submission_packet_version !== outcomeAudit\.audit\.packet_version/);

  const handoffComplete = routeSlice("'/applications/:id/submission/handoff-complete'", "'/applications/:id/submission/approve'");
  assert.match(handoffComplete, /questions:\s*current\.questions/);
  assert.doesNotMatch(handoffComplete, /resolvedPacketAuditQuestions\(/);
});

/* A THIRD DEADLOCK IN THE SAME FAMILY, on the seam between two HTTP requests rather than inside one.
 *
 * The route above already hashes auditQuestions - refreshed and persisted - rather than the raw
 * stored row, which is what closed the 2026-08-13 deadlock. That fixed the SERVER side agreeing with
 * itself. It did nothing for the CLIENT: the response below carried packet_audit and pdf but not
 * auditQuestions itself, so a caller had no way to learn the audit it just took, and the acknowledgement
 * it is about to give, describe a question set that can differ from whatever it still holds locally.
 *
 * Measured with a synthetic packet on 2026-08-20: a question the resolver holds (no attributed
 * "she supplied this" claim) round-trips through PUT /review/answers unchanged, so no claim is
 * minted for it there. This route's own refreshKnownQuestionAnswers call then blanks it - correctly,
 * nothing here proves she supplied it - and persists that. A caller that goes on to POST
 * /submit-request with its own older, still non-blank copy of that same answer hands it back through
 * a SECOND merge, which - comparing against the now-blanked row - reads the difference as a fresh
 * edit and mints a claim for it, reinstating the value THIS audit just removed. Two computations of
 * one unedited packet, three seconds apart, disagree, and the acknowledgement this audit produces is
 * spent by a submit-request that should never have diverged from it.
 *
 * THE FIX IS THE RESPONSE, not the merge or refresh rules: handing the caller the questions this
 * audit actually hashed lets it resubmit exactly those, closing the gap the two merges would
 * otherwise disagree across. Narrowing the merge or refresh logic instead would either reopen the
 * 802-answer laundering incident (minting claims on an unedited resubmission) or the 2026-08-12 IMC
 * hold (trusting an unattributed answer with no claim at all). */
test('the packet-audit response hands back the questions it hashed, or the client cannot stay in sync', () => {
  const route = routeSlice("'/applications/:id/packet-audit'", "'/applications/:id/packet-audit/acknowledge'");
  assert.match(
    route,
    /questions:\s*auditQuestions,?\s*\n\s*\};/,
    'the response must return the exact refreshed set this audit hashed and persisted',
  );
});

/* The code step needs a CURRENT acknowledgement, so awaiting_security_code cannot be past auditing.
 *
 * Entering the security code performs a fresh fill and send from the packet, and
 * POST /applications/:id/security-code gates on currentAcknowledgedPacketAudit. The submit attempt
 * that produced the code request also merges the employer questions it discovered into the review,
 * which changes packet_version, so the stored acknowledgement is stale from that moment. While this
 * route also refused the state, nothing could clear it and no code-gated application could ever be
 * filed.
 *
 * Measured on Jane Street application 496cff97 on 2026-08-17: submitted 16:14:01, code emailed,
 * stored audit and acknowledgement agreeing with each other and not with the live recompute, and
 * "Finish sending" answering packet_stale with no route forward.
 *
 * The states that HAVE claimed or completed a send stay refused: re-auditing those would rewrite
 * what an employer already received. */
test('packet audit is refused after a send is claimed, but not while a security code is pending', () => {
  const route = routeSlice("'/applications/:id/packet-audit'", "'/applications/:id/submission/extension-packet'");
  const guard = route.slice(0, route.indexOf('can no longer be audited before submission'));

  for (const status of ['submitting', 'submission_claimed', 'submitted']) {
    assert.match(guard, new RegExp(`review\\.status === '${status}'`), `${status} must stay refused`);
  }
  assert.match(guard, /review\.submission_claimed_at/);

  assert.doesNotMatch(
    guard,
    /review\.status === 'awaiting_security_code'/,
    'awaiting_security_code must NOT be refused: the security-code route needs a current acknowledged audit and this is the only route that can produce one',
  );
});

/* ---- the raw packet_stale token never reaches an applicant surface ----
 *
 * Same class as the fixed banner bug: verifyCurrentPacketAudit's reasons are developer tokens
 * (packet_stale, owner_mismatch, application_mismatch, packet_audit_invalid), and on 2026-08-20
 * the runner wrote one into attention_reason on the live Moburst packet, so the dashboard printed
 * the bare word "packet_stale" with nothing actionable beside it. Every surface an applicant
 * reads goes through packetAuditClientError, which serves the authored sentence and never the
 * token. The verdict keeps the token for logs and for the tests that pin it.
 */
test('packet audit failures reach applicant surfaces only as authored sentences', () => {
  // The runner's writes into attention_reason.
  assert.doesNotMatch(runner, /attention_reason:\s*packetAudit\.reason/);
  assert.doesNotMatch(runner, /\$\{packetAudit\.reason\}/);
  assert.match(runner, /attention_reason:\s*packetAuditClientError\(packetAudit\)\.error/);
  // The three HTTP boundaries in applications.ts that replied with the raw reason.
  assert.doesNotMatch(applications, /error:\s*outcomeAudit\.reason/);
  assert.doesNotMatch(applications, /error:\s*securityCodeAudit\.reason/);
  assert.doesNotMatch(applications, /approvalIssues\.push\(approvalAudit\.reason\)/);
});
