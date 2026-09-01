import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeSpec, type ResumeSpec } from '../llm/resumeSpec';
import { packetAuditSha256 } from './packetAudit';
import { mainResumeOfRecord } from './mainResumeOfRecord';
import { packetEducationDrift } from './submissionEducationGuard';

const NOW = new Date('2026-09-02T00:00:00.000Z');

const BASE: ResumeSpec = normalizeSpec({
  target_role: 'Software Engineer',
  school: 'Example University',
  degree: 'B.S. Computer Science & Business Administration',
  grad_date: 'May 2027',
  coursework: 'Distributed Systems',
  education_position: 'top',
  gpa: '3.8',
  school_location: 'Los Angeles, CA',
  experience: [{
    type: 'job',
    org: 'Example Lab',
    title: 'Software Engineering Intern',
    date_range: 'May 2026 - August 2026',
    bullets: ['Built a dependable service used by internal teams.'],
  }],
  skills: ['TypeScript', 'PostgreSQL'],
});

const RECORD = {
  full_name: 'Applicant',
  school: 'Example University, School of Engineering',
  degree: 'Bachelor of Science in Computer Science',
  grad_date: 'May 2028',
  coursework: ['Data Structures', 'Operating Systems'],
  gpa: '3.9',
};

test('the education block is the record\'s, the rest of the resume is the base\'s, and the guard agrees', () => {
  const spec = mainResumeOfRecord(BASE, RECORD, NOW);
  assert.equal(spec.school, RECORD.school);
  assert.equal(spec.degree, RECORD.degree);
  assert.equal(spec.grad_date, RECORD.grad_date);
  assert.equal(spec.coursework, 'Data Structures, Operating Systems');
  assert.equal(spec.education_position, 'top');
  // Untouched: the approved content, and the two academic fields the guard does not compare.
  assert.equal(spec.target_role, BASE.target_role);
  assert.deepEqual(spec.skills, BASE.skills);
  assert.deepEqual(spec.experience, BASE.experience);
  assert.equal(spec.gpa, BASE.gpa);
  assert.equal(spec.school_location, BASE.school_location);
  assert.deepEqual(packetEducationDrift(spec, RECORD), []);
});

test('a graduation date the calendar has passed moves education after experience, as the guard expects', () => {
  const record = { ...RECORD, grad_date: 'May 2019' };
  const spec = mainResumeOfRecord(BASE, record, NOW);
  assert.equal(spec.education_position, 'after_experience');
  assert.deepEqual(packetEducationDrift(spec, record), []);
});

test('a blank record field prints blank, as a fresh build would, and the guard agrees', () => {
  const record = { full_name: 'Applicant', grad_date: '', grad_year: 2028 };
  const spec = mainResumeOfRecord(BASE, record, NOW);
  assert.equal(spec.school, '');
  assert.equal(spec.degree, '');
  assert.equal(spec.grad_date, '2028');
  assert.equal(spec.coursework, '');
  assert.deepEqual(packetEducationDrift(spec, record), []);
});

test('record strings are dash-normalized like every other printed spec', () => {
  const record = { ...RECORD, degree: 'B.S. \u2014 Computer Science', grad_date: 'Aug 2024 \u2013 May 2028' };
  const spec = mainResumeOfRecord(BASE, record, NOW);
  assert.equal(spec.degree, 'B.S. - Computer Science');
  assert.equal(spec.grad_date, 'Aug 2024 - May 2028');
});

test('the digest moves on an education edit and on nothing else', () => {
  const digest = (parsed: unknown) => packetAuditSha256(mainResumeOfRecord(BASE, parsed, NOW));
  const aligned = digest(RECORD);
  assert.equal(digest({ ...RECORD, full_name: 'Renamed', gpa: '4.0', gpa_scale: '4.0', school_location: 'Elsewhere' }), aligned);
  assert.equal(digest({ ...RECORD, degree: '  Bachelor of Science in Computer Science  ' }), aligned);
  assert.notEqual(digest({ ...RECORD, grad_date: 'December 2028' }), aligned);
  assert.notEqual(digest({ ...RECORD, coursework: ['Data Structures'] }), aligned);
});
