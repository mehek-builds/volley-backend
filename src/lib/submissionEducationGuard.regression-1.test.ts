import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { isEducationLayoutIssue } from '../engine/resumeValidate';
import {
  EDUCATION_DRIFT_CODE,
  EDUCATION_LAYOUT_STALE_CODE,
  candidateEducationFromParsedProfile,
  educationDriftResponse,
  packetEducationDrift,
} from './submissionEducationGuard';

/* A packet freezes its rendered PDF at build time. These tests hold the line that an unattended
   send re-checks the education block against the profile as it reads NOW, and that it refuses in a
   way a client can explain to the student. */

const profile = {
  school: 'Example University',
  degree: 'BS Computer Science',
  grad_date: '2027',
  grad_year: 2027,
  currently_enrolled: true,
  coursework: ['Algorithms', 'Databases'],
  gpa: '3.7',
  gpa_scale: '4.0',
};

const packet = {
  target_role: 'Software Engineer Intern',
  school: 'Example University',
  degree: 'BS Computer Science',
  grad_date: '2027',
  coursework: 'Algorithms, Databases',
  education_position: 'top',
  experience: [{ type: 'job', org: 'Northwind Labs', title: 'Intern', date_range: '2026', bullets: ['Built things'] }],
  skills: ['TypeScript'],
  // The stored packet carries these alongside the resume content; the guard must ignore them.
  _review: { status: 'ready_to_submit' },
  _contact: { full_name: 'Test Student' },
};

test('a packet whose education still agrees with the profile is sent unchanged', () => {
  assert.deepEqual(packetEducationDrift(packet, profile), []);
});

test('a packet whose graduation date drifted from the profile is refused with an explainable issue', () => {
  const corrected = { ...profile, grad_date: '2026', grad_year: 2026 };
  const issues = packetEducationDrift(packet, corrected);
  assert.ok(issues.length > 0, 'a stale graduation date must not be submittable unattended');
  assert.ok(issues.some((issue) => issue.includes('graduation date')), `issues must name the field: ${issues.join('; ')}`);
});

test('school and degree drift are refused too', () => {
  assert.ok(packetEducationDrift(packet, { ...profile, school: 'Other University' })
    .some((issue) => issue.includes('school')));
  assert.ok(packetEducationDrift(packet, { ...profile, degree: 'BA Economics' })
    .some((issue) => issue.includes('degree')));
});

/* The trap. GET /profile overrides gpa/gpa_scale/major from application_profile while a packet's
   GPA comes from parsed_json, and the two stores are allowed to disagree from a packet's birth.
   A guard that compared them would refuse packets that never drifted, which is a worse failure
   than the bug it was meant to fix. */
test('a GPA that differs between the stores is not treated as drift', () => {
  assert.deepEqual(packetEducationDrift(packet, { ...profile, gpa: '3.9', gpa_scale: '4.0' }), []);
  assert.deepEqual(packetEducationDrift({ ...packet, gpa: '3.2' }, profile), []);
});

/* The calendar-boundary case. education_position is derived from year arithmetic, so a graduate
   exactly three calendar years back flips from "top" to "after_experience" at midnight on 1 January.
   A packet built on 31 December and sent on 2 January is stale after two days, with nothing about
   the student changed. It must still be refused, because a send guard laxer than the save guard is
   the other failure mode, but it must not be told a falsehood about why. */
const threeYearsBack = String(new Date().getFullYear() - 3);
const graduatedProfile = {
  school: 'Example University',
  degree: 'BS Computer Science',
  grad_date: threeYearsBack,
  grad_year: Number(threeYearsBack),
  currently_enrolled: false,
  coursework: ['Algorithms', 'Databases'],
};
const graduatedPacket = { ...packet, grad_date: threeYearsBack, education_position: 'top' };

test('a packet stale only by the education-position calendar flip is still refused', () => {
  const issues = packetEducationDrift(graduatedPacket, graduatedProfile);
  assert.deepEqual(issues.filter((issue) => !isEducationLayoutIssue(issue)), [],
    'nothing about this student changed, so nothing but layout may be reported');
  assert.equal(issues.length, 1, 'the layout flip must still block an unattended send');
});

test('a layout-only refusal does not tell the student their details changed', () => {
  const response = educationDriftResponse(packetEducationDrift(graduatedPacket, graduatedProfile));
  assert.equal(response.code, EDUCATION_LAYOUT_STALE_CODE);
  assert.ok(!/details changed/.test(response.error), `copy must be true: ${response.error}`);
  assert.match(response.error, /save the resume/, 'the instruction must still be the one that fixes it');
});

test('a real education change keeps the drift code even when layout is stale too', () => {
  const alsoRenamed = { ...graduatedProfile, school: 'Other University' };
  const response = educationDriftResponse(packetEducationDrift(graduatedPacket, alsoRenamed));
  assert.equal(response.code, EDUCATION_DRIFT_CODE);
  assert.match(response.error, /education details changed/);
  assert.ok(response.issues.length >= 2);
});

test('a genuine field change is never reported as a layout staleness', () => {
  const response = educationDriftResponse(packetEducationDrift(packet, { ...profile, grad_date: '2026', grad_year: 2026 }));
  assert.equal(response.code, EDUCATION_DRIFT_CODE);
});

test('the position issue wording lives at exactly one construction site', () => {
  const validate = strippedSource('src/engine/resumeValidate.ts');
  assert.match(validate, /export const EDUCATION_POSITION_ISSUE_PREFIX = 'education must render';/);
  assert.equal(
    validate.split("'education must render").length - 1,
    1,
    'the prefix must be declared once and referenced, never restated',
  );
  assert.match(validate, /issues\.push\(`\$\{EDUCATION_POSITION_ISSUE_PREFIX\}/);
});

test('the profile mapping resolves a missing grad_date from grad_year, as the dashboard does', () => {
  const education = candidateEducationFromParsedProfile({ school: 'Example University', grad_year: 2027 });
  assert.equal(education.grad_date, '2027');
  assert.equal(education.school, 'Example University');
  assert.deepEqual(candidateEducationFromParsedProfile(undefined).coursework, []);
});

/* Source-structure assertions. The routes have no in-process HTTP harness in this repo, so the
   wiring is asserted the way extensionSubmissionRoutes.test.ts asserts its own: against the file,
   with comments stripped so prose about the guard can never stand in for the guard. */
function strippedSource(path: string): string {
  return readFileSync(path, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const routes = strippedSource('src/routes/applications.ts');

function slice(source: string, from: string, to: string): string {
  const start = source.indexOf(from);
  assert.ok(start >= 0, `expected to find ${from}`);
  const end = source.indexOf(to, start);
  assert.ok(end > start, `expected to find ${to} after ${from}`);
  return source.slice(start, end);
}

function functionSlice(source: string, from: string): string {
  const start = source.indexOf(from);
  assert.ok(start >= 0, `expected to find ${from}`);
  const bodyStart = source.indexOf('{', start);
  assert.ok(bodyStart > start, `expected to find function body for ${from}`);
  let depth = 0;
  for (let i = bodyStart; i < source.length; i += 1) {
    const char = source[i];
    if (char === '{') depth += 1;
    if (char === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  assert.fail(`expected to find function end for ${from}`);
}

test('submission runner prefers current parsed education over stale base resume education', () => {
  const runner = strippedSource('src/routes/submissionRunner.ts');
  const academicStr = slice(runner, 'const academicStr = (key: string): string | undefined => {', 'const academicNum =')
    .replace(/\s+/g, '');
  const academicNum = functionSlice(runner, 'const academicNum = (key: string): number | undefined => {')
    .replace(/\s+/g, '');
  assert.ok(
    academicStr.indexOf('constparsedValue=parsed[key]') < academicStr.indexOf('constbaseValue=base[key]'),
    'parsed grad_date must beat stale base resume grad_date',
  );
  assert.ok(
    academicNum.indexOf('constparsedValue=parsed[key]') < academicNum.indexOf('constbaseValue=base[key]'),
    'parsed grad_year must beat stale base resume grad_year',
  );
});

test('extension-start refuses a drifted packet before it reserves the submission', () => {
  const handler = slice(routes, "'/applications/:id/submission/extension-start'", "'/applications/:id/submission/extension-outcome'");
  assert.match(handler, /packetEducationDrift\(row\.spec/);
  assert.match(handler, /educationIssues\.length > 0\) return \{ kind: 'education_drift'/);
  assert.ok(
    handler.indexOf('packetEducationDrift') < handler.indexOf('tx.update(generated_resumes)'),
    'the drift check must run before the claim is written',
  );
  /* Pinned because it is the argument, not an accident of layout: a drifted packet must not burn a
     day's submission quota, and "your graduation date changed" is actionable where "come back
     tomorrow" is not. Without this line a refactor can reorder the two and CI stays green. */
  assert.ok(
    handler.indexOf('packetEducationDrift') < handler.indexOf('withinDailyCap'),
    'the drift check must run before the daily cap, so a drifted packet reports drift rather than the cap',
  );
  assert.match(handler, /result\.kind === 'education_drift'\) return reply\.status\(422\)\.send\(educationDriftResponse/);
});

test('extension-start refuses sensitive questions before it reserves the submission', () => {
  const handler = slice(routes, "'/applications/:id/submission/extension-start'", "'/applications/:id/submission/extension-outcome'");
  assert.match(handler, /const refreshedQuestions = refreshKnownQuestionAnswers\([\s\S]{0,180}current\.questions_reviewed_at/);
  assert.match(handler, /sensitiveQuestionFor\(refreshedQuestions/);
  assert.match(handler, /kind: 'sensitive_question'/);
  assert.match(handler, /result\.kind === 'sensitive_question'/);
  assert.match(handler, /Sensitive question requires your attention/);
  assert.ok(
    handler.indexOf('sensitiveQuestionFor') < handler.indexOf('tx.update(generated_resumes)'),
    'a sensitive question must block before the submission claim is written',
  );
});

test('submit-request carries the same guard and does not merely warn', () => {
  const handler = slice(routes, "'/applications/:id/submit-request'", "'/applications/:id/submission'");
  assert.match(handler, /packetEducationDrift\(stored/);
  assert.match(
    handler,
    /submitEducationIssues\.length > 0\) \{\s*return reply\.status\(422\)\.send\(educationDriftResponse\(submitEducationIssues\)\);/,
  );
  assert.ok(
    handler.indexOf('packetEducationDrift') < handler.indexOf('processSubmissionApplication'),
    'the drift check must run before the submission is handed to the runner',
  );
});

test('submit-request revalidates resume content and PDF layout before the browser runner', () => {
  const handler = slice(routes, "'/applications/:id/submit-request'", "'/applications/:id/submission'");
  assert.match(handler, /preSendResumeVerificationIssues\([\s\S]{0,120}request\.jwtPayload!\.userId,[\s\S]{0,80}stored,[\s\S]{0,80}applicationCompany\(row\)/);
  assert.match(handler, /PRE_SEND_VERIFICATION_FAILED/);
  assert.ok(
    handler.indexOf('preSendResumeVerificationIssues') < handler.indexOf('processSubmissionApplication'),
    'pre-send verification must run before the submission is handed to the runner',
  );
});

test('final approval revalidates the full packet before it clicks submit', () => {
  const handler = slice(routes, "'/applications/:id/submission/approve'", "'/applications/:id/status'");
  assert.match(handler, /questions: refreshKnownQuestionAnswers\([\s\S]{0,180}current\.questions_reviewed_at/);
  assert.match(handler, /approvalReview\.preview_screenshot_url/);
  assert.match(handler, /approvalReview\.filled_fields/);
  /* The cover letter terms are pinned to the two facts they are ALLOWED to read, because both were
   * previously read off cover_letter_supported and that made a complete Cresta packet unsendable.
   * The evidence check asks what the run attached; the requirement check asks what the employer
   * marked required. Neither may go back to asking whether the form has the control. */
  assert.match(handler, /finalApprovalFieldIssues\(approvalReview, approvalReview\.cover_letter_attached === true\)/);
  assert.match(handler, /finalApprovalCoverLetterIssue\(approvalReview, Boolean\(storedCoverLetter\(row\)\)\)/);
  assert.doesNotMatch(handler, /cover_letter_supported/);
  assert.match(handler, /approvalReview\.questions = normalizeApplicationReviewQuestions\(approvalReview\.questions\)/);
  assert.match(handler, /approvalReview\.questions\.some\(\(question\) => question\.required && !question\.answer\.trim\(\)\)/);
  assert.match(handler, /sensitiveQuestionFor\(approvalReview\.questions/);
  assert.match(handler, /Sensitive question requires your attention/);
  assert.match(handler, /preSendResumeVerificationIssues\([\s\S]{0,120}request\.jwtPayload!\.userId,[\s\S]{0,80}stored,[\s\S]{0,80}applicationCompany\(row\)/);
  assert.match(handler, /FINAL_APPROVAL_VERIFICATION_FAILED/);
  assert.ok(
    handler.indexOf('preSendResumeVerificationIssues') < handler.indexOf('processSubmissionApplication'),
    'final approval verification must run before the browser clicks submit',
  );
  assert.ok(
    handler.indexOf('approvalReview.preview_screenshot_url') < handler.indexOf('processSubmissionApplication'),
    'a missing filled-form preview must block final submission',
  );
});

test('submit-request returns the cover letter it generated for final approval', () => {
  const handler = slice(routes, "'/applications/:id/submit-request'", "'/applications/:id/submission'");
  assert.match(handler, /const processed = await processSubmissionApplication\(row\.id, fastify\)/);
  assert.match(handler, /const responseRow = refreshed \?\? row/);
  assert.match(handler, /cover_letter: storedCoverLetter\(responseRow\)/);
  const runIndex = handler.indexOf('const processed = await processSubmissionApplication(row.id, fastify)');
  const supportedResponseIndex = handler.indexOf('cover_letter: storedCoverLetter(responseRow)', runIndex);
  assert.ok(
    runIndex > 0 && supportedResponseIndex > runIndex,
    'the response must read the cover letter after preparation has generated it',
  );
});

test('the education comparison has exactly one implementation', () => {
  const rule = 'education graduation date differs from uploaded resume';
  assert.ok(!routes.includes(rule), 'applications.ts must not carry its own copy of the education rule');
  assert.ok(
    !strippedSource('src/lib/submissionEducationGuard.ts').includes(rule),
    'the guard must call educationDriftIssues rather than restate it',
  );
  const validate = strippedSource('src/engine/resumeValidate.ts');
  assert.equal(validate.split(rule).length - 1, 1, 'resumeValidate.ts must state the rule once');
  assert.match(validate, /export function educationDriftIssues/);
  assert.match(validate, /if \(education\) issues\.push\(\.\.\.educationDriftIssues\(spec, education\)\)/);
});

test('the dashboard save and the send-time guard read the profile through the same mapping', () => {
  assert.match(routes, /const education = candidateEducationFromParsedProfile\(parsed\)/);
});

/* ISSUE-044. This guard decides whether a stored packet still matches the profile, so it has to read
 * parsed_json.coursework exactly the way the dashboard's educationFrom reads it. It used to gate on
 * Array.isArray alone, which resolves a stored string to [] where educationFrom resolves it to the
 * course list: the packet would be held for drift against a profile the dashboard shows as
 * unchanged. Nothing stores a string now, which is precisely when a lone shape gate stops being
 * load-bearing and starts being a trap. */
test('the education guard reads coursework the same way the resume generator does', () => {
  const courses = ['Data Structures and Object-Oriented Design', 'Financial Analysis & Valuation'];

  assert.deepEqual(candidateEducationFromParsedProfile({ school: 'USC', coursework: courses }).coursework, courses);

  // The pre-backfill shape, and what an older client beside a newer API could still write.
  assert.deepEqual(
    candidateEducationFromParsedProfile({ school: 'USC', coursework: courses.join(', ') }).coursework,
    courses,
    'a stored string must resolve to the same list the dashboard reads, not to []',
  );

  // A title containing "and" or "&" stays one course, or the drift comparison reports a false diff.
  assert.deepEqual(
    candidateEducationFromParsedProfile({ school: 'USC', coursework: 'Data Structures and Object-Oriented Design' }).coursework,
    ['Data Structures and Object-Oriented Design'],
  );

  assert.deepEqual(candidateEducationFromParsedProfile({ school: 'USC' }).coursework, []);
  assert.deepEqual(candidateEducationFromParsedProfile({ school: 'USC', coursework: 42 }).coursework, []);

  /* Empty and whitespace-only inputs must land on [] rather than [''], because
   * courseworkIsUngrounded treats an empty allowed set as "nothing to ground against" and returns
   * TRUE - a blank stored value would raise a drift issue on a packet that says nothing about
   * coursework at all. */
  assert.deepEqual(candidateEducationFromParsedProfile({ school: 'USC', coursework: '' }).coursework, []);
  assert.deepEqual(candidateEducationFromParsedProfile({ school: 'USC', coursework: '   ' }).coursework, []);
  assert.deepEqual(candidateEducationFromParsedProfile({ school: 'USC', coursework: [] }).coursework, []);
  assert.deepEqual(candidateEducationFromParsedProfile({ school: 'USC', coursework: null }).coursework, []);

  // Untrimmed and case-duplicate entries, which the parser can write without normalising.
  assert.deepEqual(
    candidateEducationFromParsedProfile({ school: 'USC', coursework: ['  Math  ', 'Physics', 'math'] }).coursework,
    ['Math', 'Physics'],
  );
});
