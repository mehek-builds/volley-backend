import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('preparation and final submission each have an atomic database claim', async () => {
  const runner = await readFile('src/routes/submissionRunner.ts', 'utf8');
  assert.match(runner, /spec}->'_review'->>'status' = 'submit_requested'/);
  assert.match(runner, /spec}->'_review'->>'status' = 'submitting'/);
  assert.match(runner, /spec}->'_review'->>'submission_claimed_at' is null/);
});

test('post-click failures retain the claimed row and become uncertain attention', async () => {
  const runner = await readFile('src/routes/submissionRunner.ts', 'utf8');
  const processStart = runner.indexOf('export async function processSubmissionApplication(');
  const processEnd = runner.indexOf('\nexport async function submissionRunnerRoutes', processStart);
  assert.ok(processStart >= 0 && processEnd > processStart);
  const process = runner.slice(processStart, processEnd);
  assert.match(process, /await fail\(activeRow, error\)/);
  assert.doesNotMatch(process, /const latest = await db\.select/);
  assert.match(runner, /error instanceof SubmissionExecutionError \? error\.actedOnRow : row/);
  /* The intent, not the formatting. This asserted the exact one-line ternary and broke when a
     third stop reason (NoSubmitControlError) was added and the expression wrapped. What matters is
     that an uncertain-after-claim failure still lands on needs_attention rather than failed. */
  assert.match(runner, /uncertainAfterClaim\s*\|\|\s*providerSessionFailure\s*\n?\s*\?\s*'needs_attention'/);
  assert.match(runner, /const uncertainAfterClaim = Boolean\(current\.submission_claimed_at\)/);
});

test('submit-request state transition is conditional so a replay cannot reset submitted state', async () => {
  const route = await readFile('src/routes/applications.ts', 'utf8');
  assert.match(route, /submitRequestDisposition\(\s*current\.status,\s*Boolean\(current\.submission_claimed_at\),/);
  assert.match(route, /spec}->'_review'->>'status' = \$\{current\.status\}/);
  assert.match(route, /spec}->'_review'->>'status' = 'ready_for_final_approval'/);
  assert.match(route, /spec}->'_review'->>'status' = 'needs_attention'/);
  assert.match(route, /active or completed submission cannot be replaced by a delayed failure update/);
});

test('submit-request starts a fresh run instead of carrying stale run artifacts', async () => {
  const route = await readFile('src/routes/applications.ts', 'utf8');
  const start = route.indexOf('function freshSubmitRequestReview(');
  assert.ok(start >= 0, 'submit-request normalization helper is missing');
  const end = route.indexOf('\nasync function ownedResume', start);
  assert.ok(end > start, 'could not bound freshSubmitRequestReview');
  const helper = route.slice(start, end);

  assert.match(helper, /submission_run_id:\s*randomUUID\(\)/);
  for (const field of [
    'preview_screenshot_url',
    'filled_fields',
    'receipt',
    'browser_context_id',
    'browser_session_id',
    'submission_claimed_at',
    'submission_claim_id',
    'submission_authorization',
    'final_approved_at',
    'verification',
    'stall',
    'unverified_submission',
    // The press the (cleared) unverified record was about: leaving it minted a row no code path
    // could exit once the not_sent answer was consumed - the orphaned-attempted_at lock, measured
    // on the Easy Dynamics Rippling packet, 2026-08-20.
    'submission_attempted_at',
  ]) {
    assert.match(helper, new RegExp(`${field}:\\s*undefined`), `${field} must be cleared`);
  }
  assert.match(helper, /updated_at:\s*new Date\(\)\.toISOString\(\)/);
  assert.match(route, /const submittedQuestions = parsed\.data\.questions/);
  /* THE MERGE, THE REFRESH AND THE PERSISTED REVIEW ARE KEYED TO ONE REVIEW ROUND.
   *
   * These were three separate lines each naming `current.questions_reviewed_at`, which agreed only
   * by inspection and which is NULL on a packet that has never been through a review save - 130 of
   * the 134 packets holding a resolver-held question on 2026-08-12. On those, an answer the
   * applicant typed was adopted by the merge with nothing recording where it came from, and the
   * refresh blanked it on the request that reaches the employer. One call now returns both the
   * questions and the round they were stamped against, and that round is what gets persisted.
   * src/lib/submittedAnswers.test.ts holds the behaviour rather than the shape. */
  assert.match(route, /resolveSubmittedApplicationAnswers\(\{[\s\S]{0,240}submitted: submittedQuestions/);
  assert.match(route, /const next = freshSubmitRequestReview\(current, canonicalSubmittedQuestions, submittedReviewedAt\)/);
});

/* R-095's gate, put on the transition it belongs to.
 *
 * A fill run is what ANSWERS a discovered question, so a blank required answer must never stop the
 * run. On 2026-08-08 it did: 15 of 25 packets were refused 422 by submit-request, never opened a
 * browser, and kept reporting an earlier build's attention_reason as though it described the
 * current one. The check belongs on every transition that reaches an employer and on none that
 * merely books a browser. */
test('a blank required answer stops the send and never the fill run', async () => {
  const route = await readFile('src/routes/applications.ts', 'utf8');
  const runner = await readFile('src/routes/submissionRunner.ts', 'utf8');

  const submitStart = route.indexOf("'/applications/:id/submit-request'");
  const submitEnd = route.indexOf("'/applications/:id/submission/channels'", submitStart);
  assert.ok(submitStart >= 0 && submitEnd > submitStart, 'could not bound submit-request');
  const submitRequest = route.slice(submitStart, submitEnd);

  // The run gate is gone: no unconditional required-and-blank refusal in front of the browser.
  assert.doesNotMatch(
    submitRequest,
    /if \(normalizedSubmittedQuestions\.some\(\(question\) => question\.required && !question\.answer\.trim\(\)\)\)/,
  );
  // What remains is scoped to the ONE outcome of this route that sends with no run in between:
  // the unsupported-portal email fallback.
  assert.match(submitRequest, /const sendsWithoutAnotherRun = Boolean\(current\.portal_url\) && !isPortalSupported\(current\.portal_url!\)/);
  assert.match(submitRequest, /if \(sendsWithoutAnotherRun && blankRequired\.length > 0\)/);
  assert.match(submitRequest, /Answer every required question before submitting\./);

  // The send gates all still refuse. Final approval, the runner's direct-send decision on both
  // browser paths, and clickFinalSubmit's own read of the live form.
  const approve = route.slice(
    route.indexOf("'/applications/:id/submission/approve'"),
    route.indexOf("'/applications/:id/status'", route.indexOf("'/applications/:id/submission/approve'")),
  );
  assert.match(approve, /A required application answer is still blank\./);
  assert.match(runner, /&& unansweredRequiredQuestions\.length === 0/);
  assert.match(runner, /unansweredRequiredCount: blankRequiredQuestionLabels\(mergedQuestions\)\.length/);
  const portal = await readFile('src/lib/portalSubmission.ts', 'utf8');
  assert.match(portal, /if \(readiness\.blocking\.length > 0\) throw new FormIncompleteError\(readiness\.blocking\)/);
});

/* A packet frozen against an old build must have a way back. R-066 makes applications write-once
   with no delete, so without this the only exit was a full resume edit that changed nothing. */
test('a filled but unclaimed packet can be restarted, and only when asked by name', async () => {
  const route = await readFile('src/routes/applications.ts', 'utf8');
  assert.match(route, /restart: z\.boolean\(\)\.optional\(\)/);
  assert.match(route, /const restartable = preparedRunCanRestart\(current\.status, Boolean\(current\.submission_claimed_at\)\)/);
  assert.match(route, /if \(disposition === 'reject' && !\(restartable && parsed\.data\.restart === true\)\)/);
  assert.match(route, /code: 'PREPARED_RUN_RESTARTABLE'/);
  // A restart must not carry the previous run's filled form, preview or approval forward.
  assert.match(route, /const next = freshSubmitRequestReview\(current, canonicalSubmittedQuestions, submittedReviewedAt\)/);
});

/* Staleness has to be readable, or a results table silently measures the wrong build. */
test('every review the runner writes records the build that produced it', async () => {
  const runner = await readFile('src/routes/submissionRunner.ts', 'utf8');
  assert.match(runner, /import \{ resolveRevision \} from '\.\.\/lib\/buildInfo'/);
  // Stamped inside the shared merge, not at the call sites, for the same reason updated_at is.
  assert.match(
    runner,
    /function nextReview\([\s\S]{0,200}applyReviewPatch\(current, \{ \.\.\.patch, run_revision: resolveRevision\(\)\.revision \?\? undefined \}\)/,
  );
  const board = await readFile('src/routes/jdMatch.ts', 'utf8');
  assert.match(board, /run_revision: sql<string \| null>/);
  assert.match(board, /revision: resolveRevision\(\)\.revision,/);
});

test('ATS API preparation fails closed before opening a browser or describing a packet as ready', async () => {
  const runner = await readFile('src/routes/submissionRunner.ts', 'utf8');
  assert.doesNotMatch(runner, /from '\.\.\/lib\/atsSubmissionChannels'/,
    'the runner must not import an ATS serializer while audited ATS delivery is fail closed');
  assert.match(runner, /export function atsApiSubmissionEnabled\(env: NodeJS\.ProcessEnv = process\.env\)/);
  const prepareIndex = runner.indexOf('async function prepare(');
  const atsAssessmentIndex = runner.indexOf("if (String(packetAudit.audit.bindings.employerDelivery?.mode) === 'ats_api')", prepareIndex);
  const localControlledIndex = runner.indexOf('if (shouldUseLocalControlledBrowser(portal))', prepareIndex);
  const accountGateIndex = runner.indexOf('isAccountWalledFamily(portal)', prepareIndex);
  assert.ok(atsAssessmentIndex > prepareIndex && localControlledIndex > atsAssessmentIndex && accountGateIndex > atsAssessmentIndex);
  assert.match(runner.slice(atsAssessmentIndex, localControlledIndex), /ATS API delivery is withheld until Litos can verify and send one prebuilt request object/);
});

test('ATS API channel runs after final claim and before browser submission', async () => {
  const runner = await readFile('src/routes/submissionRunner.ts', 'utf8');
  assert.doesNotMatch(runner, /from '\.\.\/lib\/atsSubmissionChannels'/);
  assert.match(runner, /import \{ repairReviewPortalFromMonitoredJob \} from '\.\.\/lib\/applicationPortalRepair'/);
  const prepareIndex = runner.indexOf('async function prepare(');
  const prepareMissingReviewGuardIndex = runner.indexOf("if (!current) throw new Error('We do not have a link to the company application page');", prepareIndex);
  const prepareRepairIndex = runner.indexOf('current = await repairReviewPortalFromMonitoredJob(row, current);', prepareIndex);
  const prepareMissingUrlGuardIndex = runner.indexOf('if (!portalUrl) throw new Error', prepareIndex);
  const helperIndex = runner.indexOf('async function submitViaAtsSubmissionChannel');
  const helperBody = runner.slice(helperIndex, runner.indexOf('/**', helperIndex));
  const selectedModeIndex = runner.indexOf("if (String(audit.bindings.employerDelivery?.mode) !== 'ats_api') return false;", helperIndex);
  const enabledIndex = runner.indexOf('ATS API delivery is withheld until Litos can verify and send one prebuilt request object', helperIndex);
  const repairIndex = helperBody.indexOf('review = await repairReviewPortalFromMonitoredJob(row, review);');
  const transportIndex = helperBody.indexOf('transportVerifiedBuiltPacket');
  const atsIndex = helperBody.indexOf('tryAtsSubmissionChannel');
  const authCheckIndex = helperBody.indexOf('authorizationValidAtClick');
  const claimIndex = runner.indexOf('const claimedRow = await claimSubmission(row, options.claimAlreadyHeld)');
  const detectIndex = runner.indexOf('const claimedPortal = detectPortal(claimedReview.portal_url!);', claimIndex);
  const callIndex = runner.indexOf('if (await submitViaAtsSubmissionChannel(');
  const browserGateIndex = runner.indexOf('portalCanAutoSubmit(portal)', callIndex);
  const managedIndex = runner.indexOf('if (isManagedStratusProvider())', callIndex);
  assert.ok(prepareIndex > 0, 'prepare helper is missing');
  assert.ok(prepareMissingReviewGuardIndex > prepareIndex && prepareMissingReviewGuardIndex < prepareRepairIndex, 'prepare must only require a review before monitored portal repair');
  assert.ok(prepareRepairIndex > prepareMissingReviewGuardIndex && prepareRepairIndex < prepareMissingUrlGuardIndex, 'prepare must repair monitored portal URLs before requiring portal_url');
  assert.ok(helperIndex > 0, 'ATS API submission helper is missing');
  const failClosedIndex = runner.indexOf('ATS API delivery is withheld until Litos can verify and send one prebuilt request object', helperIndex);
  assert.ok(selectedModeIndex > helperIndex && failClosedIndex > selectedModeIndex && enabledIndex === failClosedIndex,
    'an ATS-selected packet must fail closed before configuration, consent, serialization, or POST');
  assert.equal(repairIndex, -1, 'the API target must not be repaired after packet approval');
  assert.equal(authCheckIndex, -1);
  assert.equal(transportIndex, -1);
  assert.equal(atsIndex, -1);
  assert.ok(claimIndex > 0, 'submit must atomically claim the final submission before any send path');
  assert.equal(runner.indexOf('claimedReview = await repairReviewPortalFromMonitoredJob(row, claimedReview);', claimIndex), -1,
    'submit must not repair or replace the approved destination after the final claim');
  assert.ok(detectIndex > claimIndex, 'submit must detect the portal from the exact claimed review');
  assert.ok(callIndex > claimIndex, 'ATS API submission must run only after the final claim');
  assert.ok(browserGateIndex > callIndex, 'ATS API submission must run before browser-only portal gates');
  assert.ok(managedIndex > callIndex, 'ATS API submission must run before managed browser submission');
  assert.doesNotMatch(runner.slice(callIndex, browserGateIndex), /source: 'ats_api'/);
});

test('runner constructs no ATS API packet while exact prepared-wire replay is unavailable', async () => {
  const runner = await readFile('src/routes/submissionRunner.ts', 'utf8');
  assert.doesNotMatch(runner, /packetForApiSubmission|tryAtsSubmissionChannel/);
});

test('application routes refresh answers through the decrypted profile loader', async () => {
  const route = await readFile('src/routes/applications.ts', 'utf8');
  assert.match(route, /import \{ loadApplicationProfileLike \} from '\.\.\/lib\/applicationProfileLike'/);
  assert.match(route, /return loadApplicationProfileLike\(userId\)/);
  assert.doesNotMatch(route, /application_profile\.work_authorized/);
  assert.doesNotMatch(route, /application_profile\.needs_sponsorship/);
  assert.match(route, /resolvePacketAuditQuestionFixpoint\(/);
  assert.match(route, /return loadApplicationProfileLike\(userId\)/);
});

test('final approval validates and submits refreshed known question answers', async () => {
  const route = await readFile('src/routes/applications.ts', 'utf8');
  const start = route.indexOf("'/applications/:id/submission/approve'");
  assert.ok(start >= 0, 'approval route is missing');
  const end = route.indexOf("'/applications/:id/status'", start);
  assert.ok(end > start, 'could not bound approval route');
  const approve = route.slice(start, end);

  assert.match(approve, /const sensitiveProfile = await loadSensitiveQuestionProfile/);
  assert.match(approve, /const approvalReview: ApplicationReviewState = \{/);
  assert.match(approve, /questions: resolvePacketAuditQuestionFixpoint\([\s\S]{0,220}sensitiveProfile/);
  assert.match(approve, /approvalReview\.questions\.some/);
  assert.match(approve, /sensitiveQuestionFor\(\s*approvalReview\.questions, sensitiveProfile, approvalReview\.jd_text,/);
  assert.match(approve, /\.\.\.approvalReview,[\s\S]{0,120}status:\s*'submitting'/);
  assert.doesNotMatch(approve, /current\.questions\.some/);
  assert.doesNotMatch(approve, /sensitiveQuestionFor\(current\.questions/);
});

test('resume history refreshes known question answers without changing review status', async () => {
  const route = await readFile('src/routes/resume.ts', 'utf8');
  assert.match(route, /function refreshedHistorySpec/);
  assert.match(route, /loadApplicationProfileLike\(userId\)/);
  assert.match(route, /questions: packetQuestionFixpoint\([\s\S]{0,260}refreshKnownQuestionAnswers\(/);
  assert.match(route, /review\.questions_reviewed_at,[\s\S]{0,160}asOf/);
  assert.doesNotMatch(route, /status:\s*'ready_to_submit'[\s\S]{0,300}refreshKnownQuestionAnswers/);
});

test('submission packet attaches the role-specific resume filename', async () => {
  const runner = await readFile('src/routes/submissionRunner.ts', 'utf8');
  assert.match(runner, /const refreshedQuestions = verifiedQuestionSnapshot[\s\S]{0,180}resolvePacketAuditQuestionFixpoint\(/);
  assert.match(runner, /const roleTitle = \(row\.job_context as \{ role\?: unknown \} \| null\)\?\.role/);
  assert.match(runner, /resumeName:\s*resumeFileNameForRole\(fullName,\s*roleTitle\)/);
  assert.doesNotMatch(runner, /resumeName:\s*`litos-\$\{row\.id\}\.pdf`/);
});

/* Replaces 'submission packet uses the Litos application email alias before the account email'.
 *
 * That test pinned the exact line that caused the incident: the alias was preferred over the real
 * address unconditionally, and on 2026-08-08 the alias domain had no MX record, so every employer
 * form got an address that cannot receive mail. Preferring the alias is still correct, but only
 * behind the deliverability precondition, so the assertion moves with it. */
test('submission packet only reaches for the alias through the deliverability precondition', async () => {
  const runner = await readFile('src/routes/submissionRunner.ts', 'utf8');
  assert.match(runner, /import \{[\s\S]*resolveFrozenApplicantEmail[\s\S]*\} from '\.\.\/lib\/applicationEmail'/);
  const buildPacketIndex = runner.indexOf('export async function buildPacket');
  const resolveIndex = runner.indexOf('const applicantEmail = await resolveFrozenApplicantEmail', buildPacketIndex);
  const emailIndex = runner.indexOf('const email = applicantEmail.address.trim()', buildPacketIndex);
  assert.ok(resolveIndex > buildPacketIndex, 'buildPacket must resolve the applicant email through the precondition');
  assert.ok(emailIndex > resolveIndex, 'the filled email must be the resolved address');
  // The old unconditional preference must not come back by any route.
  assert.doesNotMatch(runner, /applicationEmail\?\.alias \?\? contact\.email/);
  assert.doesNotMatch(runner, /ensureApplicationEmailAlias/);
  // The choice and its reason are recorded on both full-fill paths and the attended account-gate
  // path. The latter validates the frozen alias before handing Jobvite or iCIMS to Chrome.
  assert.equal(runner.match(/applicant_email: packet\.applicantEmail/g)?.length, 5);
});

test('attended packets freeze one structured applicant snapshot with exact profile dates and application facts', async () => {
  const runner = await readFile('src/routes/submissionRunner.ts', 'utf8');
  const buildPacketIndex = runner.indexOf('export async function buildPacket');
  const managedGateIndex = runner.indexOf('async function prepareManagedAttendedAccountGate');
  assert.ok(buildPacketIndex >= 0 && managedGateIndex > buildPacketIndex);
  const packetBuilder = runner.slice(buildPacketIndex, managedGateIndex);
  assert.match(packetBuilder, /applicantSnapshot:[\s\S]*?profile:[\s\S]*?application_profile: applicationProfile/);
  assert.match(packetBuilder, /experience: snapshotExperience/);
  assert.match(packetBuilder, /start: string\('start'/);
  assert.match(packetBuilder, /end: string\('end'/);
  const profileLoader = await readFile('src/lib/applicationProfileLike.ts', 'utf8');
  assert.match(profileLoader, /address_zip: str\('address_zip'\)/);
  const managedGate = runner.slice(managedGateIndex, runner.indexOf('\nasync function prepare(', managedGateIndex));
  assert.match(managedGate, /applicant_snapshot: packet\.applicantSnapshot/);
});

test('Oracle managed preparation is gated by the exact measured URL before any browser run', async () => {
  const runner = await readFile('src/routes/submissionRunner.ts', 'utf8');
  const prepare = runner.slice(runner.indexOf('async function prepare('), runner.indexOf('\nasync function submit(', runner.indexOf('async function prepare(')));
  assert.match(prepare, /isManagedAttendedAccountPortal\(portal\)[\s\S]{0,100}managedAttendedAccountUrlIsSupported\(portal, current\.portal_url!\)/);
});

test('a retired packet email releases the final claim and requires regeneration before any employer request', async () => {
  const runner = await readFile('src/routes/submissionRunner.ts', 'utf8');
  const failStart = runner.indexOf('async function fail(');
  const failEnd = runner.indexOf('export type SecurityCodeSubmissionOutcome', failStart);
  assert.ok(failStart > 0 && failEnd > failStart);
  const failure = runner.slice(failStart, failEnd);
  assert.match(failure, /error instanceof ApplicantEmailRegenerationRequiredError/);
  /* Both terms are forwarded, asserted independently rather than as one adjacent string. The
     literal `regenerationRequired, uncertainAfterClaim` broke the moment a third stop reason was
     inserted between them, which is a correct change failing a test that was pinning punctuation
     rather than behaviour. What matters here is that regeneration reaches the classifier at all. */
  assert.match(failure, /submissionFailureOutcome\(\{[\s\S]*?\bregenerationRequired\b[\s\S]*?\}\)/);
  assert.match(failure, /submissionFailureOutcome\(\{[\s\S]*?\buncertainAfterClaim\b[\s\S]*?\}\)/);
  assert.match(failure, /submission_claimed_at: undefined/);
  assert.match(failure, /submission_claim_id: undefined/);
  assert.match(failure, /submission_authorization: undefined/);
});

test('submission packet ignores stored cover-letter artifact names for outbound uploads', async () => {
  const runner = await readFile('src/routes/submissionRunner.ts', 'utf8');
  assert.match(runner, /coverLetterName:\s*coverLetter\s*\?\s*coverLetterFileNameForRole\(fullName,\s*roleTitle\)/);
  assert.doesNotMatch(runner, /coverLetterName:[\s\S]{0,120}coverLetterMeta\.file_name/);
  assert.doesNotMatch(runner, /litos-\$\{row\.id\}-cover-letter\.pdf/);
});

/* ONE STOP, ONE WAIT. The prepared review is built from one object with two conditional spreads,
 * and both used to apply. A fill run that reached an emailed security-code screen therefore wrote
 * `status: awaiting_security_code` AND an open human_verification stall, which is a different wait
 * entirely: the stall is the CAPTCHA queue's entry and the clock its time-to-resolution is measured
 * from, and this packet is waiting on eight characters out of a mailbox, not on a challenge. Every
 * such row would have inflated the stall counts with a challenge nobody was holding.
 *
 * The captcha attention CATEGORY is deliberately left alone: a page may genuinely carry a widget,
 * and the category list is allowed to name more than one thing. It is the stall that must belong to
 * exactly one wait. */
test('a run stopped on an emailed security code does not also open a CAPTCHA stall', async () => {
  const runner = await readFile('src/routes/submissionRunner.ts', 'utf8');
  const patchStart = runner.indexOf('const review = nextReview(current, {\n    ...preparedReviewPatch(authorization, safe),');
  assert.ok(patchStart > 0, 'could not find the prepared review patch');
  const patch = runner.slice(patchStart, runner.indexOf('await writeReview(row, review);', patchStart));
  assert.match(patch, /\.\.\.\(securityCode\s*\n\s*\? \{/);
  assert.match(patch, /\.\.\.\(captchaAttention && !securityCode\s*\n\s*\? beginStall\(current, \{/);
  // The evidence is not lost with the stall: the categories still name both.
  assert.match(runner, /const preparedAttentionCategories = securityCode\s*\n\s*\? \['security_code' as const, \.\.\.attentionCategories/);
  assert.match(patch, /attention_categories: preparedAttentionCategories/);
  assert.match(runner, /const attentionCategories = attentionCategoriesForReasons\(attentionReasons\);/);
});
