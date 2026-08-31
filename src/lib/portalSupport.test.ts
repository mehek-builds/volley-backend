import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import {
  applyApplicationReviewEdit,
  readApplicationReview,
  type ApplicationReviewState,
} from './applicationReview';
import {
  canonicalMonitoredPortalUrl,
  canonicalSupportedPortalUrl,
  greenhousePortalUrlNeedsBoardToken,
  isPortalSupported,
} from './portalSubmission';

// __dirname rather than import.meta.url: tsconfig.api.json compiles this tree as CommonJS, where
// import.meta is a hard error. Matches serverlessRespond.test.ts and the other source-reading tests.
const routeSource = (name: string) => readFileSync(join(__dirname, '..', 'routes', name), 'utf8');
const libSource = (name: string) => readFileSync(join(__dirname, name), 'utf8');

/**
 * Portals Litos can actually fill in are knowable from the URL, so nothing should have to run to
 * find out. Before this, detectPortal only ever THREW, which meant no caller upstream of the
 * submission run could ask the question: packets on company-owned careers pages sat in the Tracker
 * labelled "Ready" behind a live send button, and the applicant learned Litos could not submit
 * there only after a multi-minute run failed. Nine of one account's ten failures on 2026-08-04 were
 * that exact shape.
 */
test('supported boards are recognised from the URL alone', () => {
  assert.equal(isPortalSupported('https://boards.greenhouse.io/gemini/jobs/4512345'), true);
  assert.equal(isPortalSupported('https://databricks.com/company/careers/open-positions/job?gh_jid=6883068002'), true);
  assert.equal(isPortalSupported('https://www.databricks.com/company/careers/product/product-management-intern-summer-2027-6883068002?gh_jid=6883068002'), true);
  assert.equal(isPortalSupported('https://jobs.lever.co/acme/abc-123'), true);
  assert.equal(isPortalSupported('https://jobs.ashbyhq.com/acme/00000000-0000-0000-0000-000000000000'), true);
});

test('company-owned careers pages are unsupported, and say so before anything runs', () => {
  // Every one of these is a real posting from the failure set, not an invented example.
  for (const url of [
    'https://www.jumptrading.com/careers/4512345/',
    'https://www.hudsonrivertrading.com/careers/job/',
    'https://www.optiver.com/working-at-optiver/career-opportunities/4512345/',
    'https://nuro.ai/careers?gh_jid=4512345',
  ]) {
    assert.equal(isPortalSupported(url), false, url);
  }
});

test('greenhouse wrapper links canonicalize to a supported application URL', () => {
  const canonical = canonicalSupportedPortalUrl(
    'https://databricks.com/company/careers/open-positions/job?gh_jid=6883068002',
    'greenhouse',
  );
  assert.equal(canonical, 'https://boards.greenhouse.io/embed/job_app?token=6883068002');
  assert.equal(isPortalSupported(canonical), true);
});

test('greenhouse wrapper canonicalization trusts the gh_jid URL convention and refuses unsafe ids', () => {
  assert.equal(canonicalSupportedPortalUrl('https://databricks.com/company/careers/open-positions/job?gh_jid=6883068002', 'lever'), 'https://boards.greenhouse.io/embed/job_app?token=6883068002');
  assert.equal(canonicalSupportedPortalUrl('https://databricks.com/company/careers/open-positions/job?gh_jid=abc', 'greenhouse'), undefined);
  assert.equal(canonicalSupportedPortalUrl('http://databricks.com/company/careers/open-positions/job?gh_jid=6883068002', 'greenhouse'), undefined);
  assert.equal(canonicalSupportedPortalUrl('https://nuro.ai/careers?gh_jid=4512345', 'greenhouse'), undefined);
  assert.equal(canonicalSupportedPortalUrl('https://www.fivetran.com/careers/job?gh_jid=1', 'greenhouse'), undefined);
  assert.equal(canonicalSupportedPortalUrl('https://databricks.com/company/careers/open-positions?gh_jid=6883068002', 'greenhouse'), undefined);
});

test('monitored Greenhouse sources canonicalize company wrappers with source board tokens', () => {
  assert.equal(
    canonicalMonitoredPortalUrl('https://nuro.ai/careers?gh_jid=4512345', 'greenhouse', 'nuro'),
    'https://job-boards.greenhouse.io/embed/job_app?for=nuro&token=4512345',
  );
  assert.equal(
    canonicalMonitoredPortalUrl('https://www.jumptrading.com/hr/job?gh_jid=8052281', 'greenhouse', 'jumptrading'),
    'https://job-boards.greenhouse.io/embed/job_app?for=jumptrading&token=8052281',
  );
  assert.equal(
    canonicalMonitoredPortalUrl('https://boards.greenhouse.io/embed/job_app?token=7351061', 'greenhouse', 'nuro'),
    'https://job-boards.greenhouse.io/embed/job_app?for=nuro&token=7351061',
  );
  assert.equal(
    canonicalMonitoredPortalUrl('https://job-boards.greenhouse.io/akunacapital/jobs/8018893', 'greenhouse', 'akunacapital'),
    'https://job-boards.greenhouse.io/embed/job_app?for=akunacapital&token=8018893',
  );
  assert.equal(
    canonicalMonitoredPortalUrl('https://job-boards.eu.greenhouse.io/imc/jobs/4829785101', 'greenhouse', 'imc'),
    'https://job-boards.eu.greenhouse.io/embed/job_app?for=imc&token=4829785101',
  );
  assert.equal(canonicalMonitoredPortalUrl('https://nuro.ai/careers?gh_jid=4512345', 'greenhouse'), undefined);
  assert.equal(canonicalMonitoredPortalUrl('https://nuro.ai/careers?gh_jid=abc', 'greenhouse', 'nuro'), undefined);
});

test('bare Greenhouse embed links are supported but still need monitored board-token repair', () => {
  assert.equal(isPortalSupported('https://boards.greenhouse.io/embed/job_app?token=7351061'), true);
  assert.equal(greenhousePortalUrlNeedsBoardToken('https://boards.greenhouse.io/embed/job_app?token=7351061'), true);
  assert.equal(greenhousePortalUrlNeedsBoardToken('https://job-boards.eu.greenhouse.io/embed/job_app?token=4829785101'), true);
  assert.equal(greenhousePortalUrlNeedsBoardToken('https://boards.greenhouse.io/embed/job_app?for=nuro&token=7351061'), false);
  assert.equal(greenhousePortalUrlNeedsBoardToken('https://job-boards.eu.greenhouse.io/embed/job_app?for=imc&token=4829785101'), false);
  assert.equal(greenhousePortalUrlNeedsBoardToken('https://job-boards.greenhouse.io/nuro/jobs/7351061'), false);
});

test('a question about a missing or malformed URL gets an answer, not an exception', () => {
  // The whole point of this predicate is that it is askable. Throwing here would reintroduce the
  // bug in a new place.
  assert.equal(isPortalSupported(undefined), false);
  assert.equal(isPortalSupported(''), false);
  assert.equal(isPortalSupported('not a url'), false);
  // Insecure links are refused by detectPortal, so they are not fillable either.
  assert.equal(isPortalSupported('http://boards.greenhouse.io/acme/jobs/1'), false);
});

test('packets stored before portal_supported existed still answer correctly', () => {
  // Derived on read so no backfill migration is needed. A packet created last month must not be
  // the one that still shows a send button that cannot work.
  const legacyUnsupported = readApplicationReview({
    _review: { status: 'ready_to_submit', portal_url: 'https://www.optiver.com/careers/1' },
  });
  assert.equal(legacyUnsupported?.portal_supported, false);

  const legacySupported = readApplicationReview({
    _review: { status: 'ready_to_submit', portal_url: 'https://boards.greenhouse.io/acme/jobs/1' },
  });
  assert.equal(legacySupported?.portal_supported, true);
});

test('a stored portal_supported decision is never overwritten by the derivation', () => {
  const stored = readApplicationReview({
    _review: { status: 'ready_to_submit', portal_url: 'https://www.optiver.com/careers/1', portal_supported: true },
  });
  assert.equal(stored?.portal_supported, true);
});

test('a review with no portal_url is left alone', () => {
  const review = readApplicationReview({ _review: { status: 'resume_ready' } });
  assert.equal(review?.portal_supported, undefined);
});

/**
 * The review EDIT path, which is the third place portal_supported is written and the only one that
 * can contradict itself. Creation and the read-time derivation were covered from the first day of
 * this fix; this one was not, which is exactly why it was possible to ship a merge that carried the
 * old verdict onto a new URL.
 */
const reviewAt = (portalUrl: string, portalSupported: boolean): ApplicationReviewState => ({
  jd_text: 'jd',
  status: 'ready_to_submit',
  edited_terms: [],
  questions: [],
  skipped_reasons: [],
  updated_at: '2026-08-01T00:00:00.000Z',
  portal_url: portalUrl,
  portal_supported: portalSupported,
});

test('editing a supported packet onto an unsupported URL drops the verdict with it', () => {
  const edited = applyApplicationReviewEdit(reviewAt('https://boards.greenhouse.io/acme/jobs/1', true), {
    ats_name: 'Company site',
    portal_url: 'https://www.optiver.com/careers/1',
    questions: [],
    skipped_reasons: [],
  });
  assert.equal(edited.portal_url, 'https://www.optiver.com/careers/1');
  assert.equal(edited.portal_supported, false);
});

test('editing an unsupported packet onto a real board unlocks it again', () => {
  // The direction that traps people. The dashboard gates the send button on portal_supported, and
  // the read-time derivation never revisits a value that is already defined, so if the edit does not
  // re-derive here the applicant is locked out of a packet that would submit fine, permanently, and
  // saving the URL a second time changes nothing.
  const edited = applyApplicationReviewEdit(reviewAt('https://www.optiver.com/careers/1', false), {
    ats_name: 'Greenhouse',
    portal_url: 'https://boards.greenhouse.io/acme/jobs/1',
    questions: [],
    skipped_reasons: [],
  });
  assert.equal(edited.portal_supported, true);
});

test('editing onto a Databricks wrapper stores the Greenhouse embed URL', () => {
  const edited = applyApplicationReviewEdit(reviewAt('https://www.optiver.com/careers/1', false), {
    ats_name: 'Greenhouse',
    portal_url: 'https://databricks.com/company/careers/open-positions/job?gh_jid=6883068002',
    questions: [],
    skipped_reasons: [],
  });
  assert.equal(edited.portal_url, 'https://boards.greenhouse.io/embed/job_app?token=6883068002');
  assert.equal(edited.ats_name, 'greenhouse');
  assert.equal(edited.portal_supported, true);
});

test('an edit that carries no URL leaves the stored verdict alone', () => {
  // Deriving from an absent URL would write false over a good true, which is the same lockout
  // arriving by a different door. The route's schema requires portal_url, so this is the guard
  // holding the door shut if that ever relaxes.
  const edited = applyApplicationReviewEdit(reviewAt('https://boards.greenhouse.io/acme/jobs/1', true), {
    questions: [],
    skipped_reasons: [],
  });
  assert.equal(edited.portal_supported, true);
  assert.equal(edited.portal_url, 'https://boards.greenhouse.io/acme/jobs/1');
});

test('the review route edits through the helper rather than a bare spread', () => {
  const applicationsRoute = routeSource('applications.ts');
  assert.match(applicationsRoute, /const next = applyApplicationReviewEdit\(current, parsed\.data\)/);
});

test('dashboard resume edits prune generated off-list skills before validation', () => {
  const applicationsRoute = routeSource('applications.ts');
  assert.match(applicationsRoute, /import \{[^}]*pruneUngroundedSkills[^}]*validateResumeSpec[^}]*\} from '\.\.\/engine\/resumeValidate'/);
  assert.match(applicationsRoute, /const declaredSkills = declaredSkillsList\(profileRows\[0\]\?\.skills\)/);
  assert.match(applicationsRoute, /const grounded = pruneUngroundedSkills\(edited, bank, declaredSkills\)/);
  assert.match(applicationsRoute, /edited = grounded\.spec/);
  assert.match(applicationsRoute, /groundingRemoved: grounded\.removed/);

  const pruneIndex = applicationsRoute.indexOf('pruneUngroundedSkills(edited, bank, declaredSkills)');
  const validateIndex = applicationsRoute.indexOf('validateResumeSpec(', pruneIndex);
  assert.ok(pruneIndex > 0 && validateIndex > pruneIndex, 'dashboard save must sanitize uneditable skills before validation');
});

test('dashboard edits and every pre-send route enforce current lead citations', () => {
  const applicationsRoute = routeSource('applications.ts');
  const editStart = applicationsRoute.indexOf("'/applications/:id/resume'");
  const editEnd = applicationsRoute.indexOf("'/applications/:id/review'", editStart);
  const edit = applicationsRoute.slice(editStart, editEnd);
  const select = edit.indexOf('selectJdAlignedLead(edited, review.jd_text');
  const validate = edit.indexOf('validateResumeSpec(', select);
  const render = edit.indexOf('renderResumePdf(edited', validate);
  const renderedCitation = edit.indexOf('leadAlignmentIssues(rendered.spec', render);
  const persist = edit.indexOf('.update(generated_resumes)', renderedCitation);
  assert.ok(select > 0 && validate > select, 'dashboard edits must reselect the lead before validation');
  assert.ok(render > validate && renderedCitation > render, 'the fitted edit must retain its exact citation');
  assert.ok(persist > renderedCitation, 'a stale fitted citation must be refused before persistence');

  const preSend = applicationsRoute.slice(
    applicationsRoute.indexOf('export async function preSendResumeVerificationIssues'),
    applicationsRoute.indexOf('async function loadSensitiveQuestionProfile'),
  );
  assert.match(preSend, /applicationLeadAlignmentIssues\(stored, company\)/);
  assert.match(preSend, /leadAlignmentIssues\(rendered\.spec, review\.jd_text/);

  const extension = applicationsRoute.slice(
    applicationsRoute.indexOf("'/applications/:id/submission/extension-start'"),
    applicationsRoute.indexOf("'/applications/:id/submission/extension-outcome'"),
  );
  assert.match(extension, /preSendResumeVerificationIssues\(/);
  assert.match(extension, /sameApplicationPacketSpec\(row\.spec, precheckRow\.spec\)/);
  assert.match(extension, /generated_resumes\.spec\} = \$\{JSON\.stringify\(precheckRow\.spec\)\}::jsonb/);
});

test('the centralized runner refuses stale lead evidence before every claim and send channel', () => {
  const runner = routeSource('submissionRunner.ts');
  const submit = runner.slice(
    runner.indexOf('async function submit(row:'),
    runner.indexOf('export type SecurityCodeSubmissionOutcome'),
  );
  const submitGate = submit.indexOf('runnerLeadAlignmentIssues(row)');
  const claim = submit.indexOf('claimSubmission(row');
  assert.ok(submitGate > 0 && claim > submitGate, 'the runner must validate the exact packet before its submission claim');
  const ordinaryClaim = runner.slice(
    runner.indexOf('async function claimSubmission('),
    runner.indexOf('export function submissionClaimIsHeld'),
  );
  assert.match(ordinaryClaim, /generated_resumes\.spec\} = \$\{JSON\.stringify\(row\.spec\)\}::jsonb/);
  const preparationClaim = runner.slice(
    runner.indexOf('async function claimPreparation('),
    runner.indexOf('async function authorizationValidAtClick('),
  );
  assert.match(preparationClaim, /generated_resumes\.spec\} = \$\{JSON\.stringify\(row\.spec\)\}::jsonb/);
  for (const channel of [
    'submitControlled(row',
    'submitViaAtsSubmissionChannel(',
    'runManagedBrowser(',
    'clickFinalSubmit(',
  ]) {
    assert.ok(submit.indexOf(channel) > submitGate, `${channel} must remain behind the lead citation gate`);
  }

  const process = runner.slice(
    runner.indexOf('export async function processSubmissionApplication'),
    runner.indexOf('export async function submissionRunnerRoutes'),
  );
  assert.ok(
    process.indexOf('runnerLeadAlignmentIssues(activeRow)') < process.indexOf('claimPreparation(activeRow)'),
    'direct cron entry must validate before preparing or submitting a stored row',
  );

  const security = runner.slice(
    runner.indexOf('async function recoverManagedInitialSecurityCodeChallenge'),
    runner.indexOf('export async function recoverManagedSubmissionTerminalResult'),
  );
  assert.ok(
    security.indexOf('runnerLeadAlignmentIssues(row)') < security.indexOf('prepareManagedEmailVerification({'),
    'recovered security-code continuation must validate before mailbox or employer work',
  );
  assert.doesNotMatch(security, /claimSecurityCodeSubmission\(|submit\(/,
    'the retired typed-code endpoint must not reserve or refill an employer form');
  const securityClaim = runner.slice(
    runner.indexOf('async function claimSecurityCodeSubmission('),
    runner.indexOf('async function claimPreparation('),
  );
  assert.match(securityClaim, /generated_resumes\.spec\} = \$\{JSON\.stringify\(row\.spec\)\}::jsonb/);
});

test('unsupported-portal email verifies, reserves, and records its immutable boundary before sending', () => {
  const applications = routeSource('applications.ts');
  const handler = applications.slice(
    applications.indexOf("'/applications/:id/submit-request'"),
    applications.indexOf("'/applications/:id/submission/channels'"),
  );
  const verify = handler.indexOf('preSendResumeVerificationIssues(');
  const packet = handler.indexOf('buildPacket(packetRow, false, canonicalSubmittedQuestions)', verify);
  const verifyPacket = handler.indexOf('transportVerifiedBuiltPacket(', packet);
  const prepareEmail = handler.indexOf('prepareUnsupportedPortalApplicationEmail', packet);
  const reservation = handler.indexOf('const reservation = await db.transaction', verifyPacket);
  const exactClaim = handler.indexOf('sql`${generated_resumes.spec} = ${JSON.stringify(latest.spec)}::jsonb`', reservation);
  const opened = handler.indexOf("eventKind: 'attempt_opened'", exactClaim);
  const boundary = handler.indexOf('authorizeFinalSubmissionBoundary(binding', opened);
  const pressed = handler.indexOf("eventKind: 'press_observed'", boundary);
  const send = handler.indexOf('sent = await sendPreparedUnsupportedPortalApplicationEmail', pressed);
  assert.ok(verify > 0 && packet > verify && prepareEmail > packet && verifyPacket > prepareEmail,
    'the exact packet must be built and audit-verified before a provider capability is reserved');
  assert.ok(reservation > verifyPacket && exactClaim > reservation,
    'the locked reservation must compare against the exact row that passed verification');
  assert.ok(opened > exactClaim && boundary > opened && pressed > boundary && send > pressed,
    'the immutable opening, boundary, and dispatch fact must precede the employer email call');
});

/**
 * Wiring, asserted separately from behaviour.
 *
 * A correct predicate that nothing calls is the failure mode this repo has shipped before: the
 * module is right, the composition root never mounts it, and the defect survives the fix. These
 * assert the three places the answer has to be used for the bug to actually be gone.
 */
test('portal support is written at packet creation and unsupported portals use email fallback', () => {
  const resumeRoute = routeSource('resume.ts');
  assert.match(resumeRoute, /import \{[^}]*isPortalSupported[^}]*\} from '\.\.\/lib\/portalSubmission'/);
  assert.match(resumeRoute, /import \{ repairReviewPortalFromMonitoredJob \} from '\.\.\/lib\/applicationPortalRepair'/);
  // Set on the review at creation, from the URL the caller just handed us.
  assert.match(resumeRoute, /async function monitoredApplicationUrlForGenerate\(body: ResumeGenerateBody\)/);
  assert.match(resumeRoute, /canonicalMonitoredPortalUrl\(job\.apply_url, job\.ats_name, job\.board_token\)/);
  assert.match(resumeRoute, /const monitoredApplicationUrl = await monitoredApplicationUrlForGenerate\(body\)/);
  assert.match(resumeRoute, /const canonicalApplicationPortalUrl = body\.application[\s\S]{0,300}monitoredApplicationUrl \?\? canonicalSupportedPortalUrl\(body\.application\.portal_url, body\.application\.ats_name\)/);
  assert.match(resumeRoute, /inArray\(career_page_sources\.ats_name,[\s\S]{0,80}AUTONOMOUS_PORTAL_FAMILIES/);
  assert.match(resumeRoute, /portal_url: canonicalApplicationPortalUrl/);
  assert.match(resumeRoute, /applicationReview = await repairReviewPortalFromMonitoredJob\(/);
  assert.match(resumeRoute, /const canonicalApplicationPortalSupported = isPortalSupported\(canonicalApplicationPortalUrl\)/);
  assert.match(resumeRoute, /portal_supported: canonicalApplicationPortalSupported/);
  // And repaired on history reads so the dashboard does not keep hiding the send path for old
  // monitored-job packets whose review URL is stale or company-owned.
  assert.match(resumeRoute, /function repairedHistorySpec/);
  assert.match(resumeRoute, /canonicalSupportedPortalUrl\(review\.portal_url, review\.ats_name\)/);
  assert.match(resumeRoute, /monitored_jobs\.apply_url/);
  assert.match(resumeRoute, /canonicalMonitoredPortalUrl\(job\.apply_url, job\.ats_name, job\.board_token\)/);
  assert.match(resumeRoute, /monitoredDescriptionHash\(job\.description\)/);
  // The composition is now wrapped by specWithoutDocumentPointers, which strips the Blob pointers a
  // fifty-row spec payload was carrying (routes/documentResponseContract.test.ts owns that half).
  // The pin here is unchanged in what it proves: the REPAIRED spec, and not row.spec, is what the
  // response is built from, because a repair nothing serializes is a repair that did not happen.
  assert.match(
    resumeRoute,
    /spec: specWithoutDocumentPointers\(\s*refreshedHistorySpec\(repairedHistorySpec\(row, monitoredJobs\), profile, row\.job_context\),\s*\)/,
  );
  const applicationsRoute = routeSource('applications.ts');
  const repairSource = libSource('applicationPortalRepair.ts');
  // Packets created from monitored jobs can outlive a bad or stale review URL. Before declaring the
  // packet unsupported, submit-request must first repair from the canonical monitored job apply_url.
  assert.match(applicationsRoute, /import \{ repairReviewPortalFromMonitoredJob \} from '\.\.\/lib\/applicationPortalRepair'/);
  assert.match(repairSource, /export async function repairReviewPortalFromMonitoredJob/);
  assert.match(repairSource, /const currentCanonicalUrl = canonicalSupportedPortalUrl\(current\.portal_url, current\.ats_name\)[\s\S]{0,250}currentCanonicalUrl !== current\.portal_url/);
  assert.match(repairSource, /greenhousePortalUrlNeedsBoardToken\(current\.portal_url\)/);
  assert.match(repairSource, /monitored_jobs\.apply_url/);
  assert.match(repairSource, /canonicalMonitoredPortalUrl\(job\.apply_url, job\.ats_name, job\.board_token\)/);
  assert.match(repairSource, /monitoredJdAgrees\(expectedJdHash, current\.jd_text, job\.description\)/);
  assert.match(applicationsRoute, /current = await repairReviewPortalFromMonitoredJob\(row, current\)/);
  assert.match(applicationsRoute, /review = await repairReviewPortalFromMonitoredJob\(row, review\)/);
  assert.match(applicationsRoute, /\/applications\/:id\/submission\/channels/);
  assert.match(applicationsRoute, /assessAtsSubmissionChannel\(review\.portal_url\)/);
  assert.doesNotMatch(applicationsRoute, /inArray\(career_page_sources\.ats_name,[\s\S]{0,80}AUTONOMOUS_PORTAL_FAMILIES/);
  assert.match(applicationsRoute, /sendPreparedUnsupportedPortalApplicationEmail/);
  const unsupportedStart = applicationsRoute.indexOf('if (current.portal_url && !isPortalSupported(current.portal_url))');
  const channelsStart = applicationsRoute.indexOf("'/applications/:id/submission/channels'");
  assert.ok(unsupportedStart > 0 && channelsStart > unsupportedStart);
  assert.match(applicationsRoute.slice(unsupportedStart, channelsStart), /sendPreparedUnsupportedPortalApplicationEmail/);
  assert.doesNotMatch(applicationsRoute, /PORTAL_NOT_SUPPORTED/);
  const repairIndex = applicationsRoute.indexOf('repairReviewPortalFromMonitoredJob(row, current)');
  const guardIndex = applicationsRoute.indexOf('!isPortalSupported(current.portal_url)');
  const runIndex = applicationsRoute.indexOf('processSubmissionApplication(row.id, fastify)');
  assert.ok(repairIndex > 0 && guardIndex > repairIndex, 'the monitored-job URL repair must precede the unsupported portal branch');
  assert.ok(guardIndex > 0 && runIndex > guardIndex, 'the unsupported portal branch must precede the browser submission run');
  const browserConfigIndex = applicationsRoute.indexOf('PORTAL_RUNNER_NOT_CONFIGURED');
  assert.ok(browserConfigIndex > guardIndex, 'unsupported portal email fallback must not require a browser provider');
  assert.match(applicationsRoute, /pipeline_stage: 'applied'/);
  assert.match(applicationsRoute, /source: 'email_fallback'/);
  assert.match(applicationsRoute, /UNSUPPORTED_PORTAL_EMAIL_OUTCOME_UNVERIFIED/);
  const failureStart = applicationsRoute.indexOf('Unsupported portal email outcome is unverified');
  const failureEnd = applicationsRoute.indexOf('const submittedAt', failureStart);
  assert.ok(failureStart > guardIndex, 'email fallback failure handling must be inside the unsupported branch');
  assert.ok(failureEnd > failureStart, 'email fallback failure handling must return before the submitted write');
  const failureBlock = applicationsRoute.slice(failureStart, failureEnd);
  assert.match(failureBlock, /applyReviewPatch\([\s\S]{0,200}status: 'needs_attention'/);
  assert.match(failureBlock, /submission_attempted_at: failedAt/);
  assert.match(failureBlock, /unverified_submission:/);
  assert.match(failureBlock, /return reply\.status\(503\)\.send/);
  assert.doesNotMatch(failureBlock, /status: 'submitted'/);
  assert.doesNotMatch(failureBlock, /pipeline_stage: 'applied'/);

  const applicationReviewSource = routeSource('../lib/applicationReview.ts');
  assert.match(applicationReviewSource, /canonicalSupportedPortalUrl\(edit\.portal_url, edit\.ats_name \?\? current\.ats_name\)/);
  assert.match(applicationReviewSource, /portal_url: canonicalPortalUrl/);
  assert.match(applicationReviewSource, /portal_supported: isPortalSupported\(canonicalPortalUrl\)/);
});

test('a cover letter failure degrades the run instead of aborting it', () => {
  const runner = routeSource('submissionRunner.ts');
  // The generate call is inside a try, and its failure returns a packet rather than rethrowing.
  assert.match(
    runner,
    /try \{\s*await generateStoredCoverLetter\(row, false, true\);\s*\} catch \(error\) \{[\s\S]{0,700}coverLetterIssue:/,
  );
  // And the reason reaches the applicant on both provider paths rather than being swallowed. The
  // managed path names its final reason before it signs the attended URL binding, while the direct
  // path still writes the array inline.
  assert.match(runner, /const attentionReasons = \[[\s\S]{0,300}\.\.\.coverLetterAttention/);
  assert.match(runner, /const preparedAttentionReason = \[[\s\S]{0,220}\.\.\.attentionReasons/);
  assert.match(runner, /attention_reason:[\s\S]{0,220}\.\.\.coverLetterAttention/);
});

test('preview evidence blocks broken pages and incomplete form fills before final approval', () => {
  const runner = routeSource('submissionRunner.ts');
  assert.match(runner, /function previewContentBlockers\(text: string \| undefined\): string\[\]/);
  assert.match(runner, /can\(\?:not\|\u0027t\)/);
  /* Loosened from the one-line signature, which broke when the run's own evidence was added as a
     third argument so that a resume displaced by a later upload could be reported and not only a
     missing one. The requirement is that the function still takes the filled fields and the packet
     and returns sentences, not that it takes exactly two parameters. */
  assert.match(runner, /function filledFieldBlockers\(\s*fields: readonly string\[\] \| undefined,\s*packet: SubmissionPacket,[\s\S]{0,200}?\): string\[\]/);
  assert.match(runner, /The filled form did not record an email field/);
  assert.match(runner, /The filled form did not record a resume upload/);
  assert.match(runner, /The filled form did not record the applicant name fields/);
  assert.match(runner, /The filled form did not record the cover letter attachment/);
  /* Loosened from the exact one-line call, which broke when the reach evidence (provider blockers
     and discovered questions) was added as further arguments. The requirement is that the direct
     path feeds the live page text and the filled fields into the same evidence check the managed
     path uses, not that the argument object stays one line long. */
  assert.match(runner, /preparationEvidenceBlockers\(\{[\s\S]{0,400}text: pageText,[\s\S]{0,400}filledFields: result\.filledFields/);
  // And those per-field sentences are only reachable once the form is known to have been reached.
  assert.match(runner, /if \(!applicationFormWasReached\(\{[\s\S]{0,600}return \[FORM_NOT_REACHED_REASON\];/);
});

/* The submit gate is ONE check and must not be written as two.
 *
 * It read `managedResultRequiresCaptchaAttention(probe) && managedCaptchaVerdictIsCorroborated(
 * portal, probe)` and presented itself as probe-plus-corroboration. Both terms call
 * readManagedCaptchaEvidence on the same probe result and short-circuit on the same invisible
 * predicate, so on an autonomous family the second term cannot disagree with the first: the
 * conjunction is a tautology, and a tautology dressed as defence in depth is worse than a single
 * check, because the next person to touch it believes there are two.
 *
 * Corroboration is a genuine question exactly where two sources exist - the PREPARE path, which
 * judges the remote runner's own blocker list against markup this repo read - and it is still asked
 * there. This asserts the split stays that way. */
test('the managed submit gate asks one question, and corroboration stays where two sources exist', () => {
  const runner = routeSource('submissionRunner.ts');
  const submitGate = runner.match(/if \(managedResultRequiresCaptchaAttention\(captchaProbe\)[\s\S]{0,200}?\{/)?.[0] ?? '';
  assert.ok(submitGate, 'the submit path must still probe for a challenge before it clicks');
  assert.doesNotMatch(
    submitGate,
    /managedCaptchaVerdictIsCorroborated/,
    'a second term that reads the same evidence through the same predicate is not a second layer',
  );
  // The prepare path keeps it, wrapped around the blockers the remote runner reported.
  assert.match(runner, /corroborateManagedCaptchaBlockers\(\s*portal,/);
});

test('the applicant is told what happened, not what the model said', () => {
  const runner = routeSource('submissionRunner.ts');
  const issue = runner.match(/coverLetterIssue: (.*)$/m)?.[1] ?? '';
  // What reached applicants: "raise the cap", and 200 characters of raw model JSON with a vendor
  // name on it. A cover letter failure is one situation with one recovery, so the sentence is
  // fixed - no interpolation of any kind, which is the only version of this that cannot regress.
  assert.ok(issue.length > 0, 'the degrade must still say something');
  assert.ok(!issue.includes('${'), 'the applicant-facing sentence must not interpolate anything');
  assert.ok(!/error\.message/.test(issue), 'the raw error must not reach the applicant');
  // And the detail is not thrown away: whoever fixes the generator reads it in the logs.
  assert.match(runner, /fastify\.log\.warn\(\{ error, applicationId: row\.id \}[\s\S]{0,180}Cover letter generation or revalidation failed/);
});
