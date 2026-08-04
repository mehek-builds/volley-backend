import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { candidateEducationFromParsedProfile, packetEducationDrift } from './submissionEducationGuard';

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

test('extension-start refuses a drifted packet before it reserves the submission', () => {
  const handler = slice(routes, "'/applications/:id/submission/extension-start'", "'/applications/:id/submission/extension-outcome'");
  assert.match(handler, /packetEducationDrift\(row\.spec/);
  assert.match(handler, /educationIssues\.length > 0\) return \{ kind: 'education_drift'/);
  assert.ok(
    handler.indexOf('packetEducationDrift') < handler.indexOf('tx.update(generated_resumes)'),
    'the drift check must run before the claim is written',
  );
  assert.match(handler, /result\.kind === 'education_drift'\) return reply\.status\(422\)\.send\(educationDriftResponse/);
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
