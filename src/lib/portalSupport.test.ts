import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import {
  applyApplicationReviewEdit,
  readApplicationReview,
  type ApplicationReviewState,
} from './applicationReview';
import { isPortalSupported } from './portalSubmission';

// __dirname rather than import.meta.url: tsconfig.api.json compiles this tree as CommonJS, where
// import.meta is a hard error. Matches serverlessRespond.test.ts and the other source-reading tests.
const routeSource = (name: string) => readFileSync(join(__dirname, '..', 'routes', name), 'utf8');

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

/**
 * Wiring, asserted separately from behaviour.
 *
 * A correct predicate that nothing calls is the failure mode this repo has shipped before: the
 * module is right, the composition root never mounts it, and the defect survives the fix. These
 * assert the three places the answer has to be used for the bug to actually be gone.
 */
test('portal support is written at packet creation and enforced before a run starts', () => {
  const resumeRoute = routeSource('resume.ts');
  assert.match(resumeRoute, /import \{ isPortalSupported \} from '\.\.\/lib\/portalSubmission'/);
  // Set on the review at creation, from the URL the caller just handed us.
  assert.match(resumeRoute, /portal_supported: isPortalSupported\(body\.application\.portal_url\)/);

  const applicationsRoute = routeSource('applications.ts');
  // Refused up front. A client-side check is not an enforcement point, so submit-request has to
  // answer this itself rather than trusting the dashboard to have hidden the button.
  assert.match(applicationsRoute, /!isPortalSupported\(current\.portal_url\)[\s\S]{0,400}PORTAL_NOT_SUPPORTED/);
  // Refused BEFORE the run is kicked off, not after. Bounded span so a match cannot skip the file.
  const guardIndex = applicationsRoute.indexOf('PORTAL_NOT_SUPPORTED');
  const runIndex = applicationsRoute.indexOf('processSubmissionApplication(row.id, fastify)');
  assert.ok(guardIndex > 0 && runIndex > guardIndex, 'the portal guard must precede the submission run');
});

test('a cover letter failure degrades the run instead of aborting it', () => {
  const runner = routeSource('submissionRunner.ts');
  // The generate call is inside a try, and its failure returns a packet rather than rethrowing.
  assert.match(
    runner,
    /try \{\s*await generateStoredCoverLetter\(row, false, true\);\s*\} catch \(error\) \{[\s\S]{0,400}coverLetterIssue:/,
  );
  // And the reason reaches the applicant on both provider paths rather than being swallowed.
  const attentionLines = runner.match(/attention_reason:[\s\S]{0,160}?coverLetterAttention/g) ?? [];
  assert.equal(attentionLines.length, 2, 'both the managed and direct paths must surface the reason');
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
  assert.match(runner, /fastify\.log\.warn\(\{ error, applicationId: row\.id \}[\s\S]{0,120}Cover letter generation failed/);
});
