import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import type { CandidateEducation } from '../engine/resumePolicy';
import { mergeEducationFallback, missingRenderedEducation, missingRequiredEducation } from './resume';

test('tailored resume education falls back only when the parsed profile field is blank', () => {
  const primary: CandidateEducation = {
    school: '',
    degree: undefined,
    grad_date: undefined,
    coursework: [],
  };

  const recovered = mergeEducationFallback(primary, {
    school: 'University of Southern California, Viterbi School of Engineering',
    degree: 'Bachelor of Science in Computer Science',
    grad_date: 'May 2028',
    grad_year: 2028,
    currently_enrolled: true,
    coursework: ['Data Structures & Algorithms'],
    school_location: 'Los Angeles, CA',
  });

  assert.equal(recovered.school, 'University of Southern California, Viterbi School of Engineering');
  assert.equal(recovered.degree, 'Bachelor of Science in Computer Science');
  assert.equal(recovered.grad_date, 'May 2028');
  assert.equal(recovered.grad_year, 2028);
  assert.deepEqual(recovered.coursework, ['Data Structures & Algorithms']);
  assert.deepEqual(missingRequiredEducation(recovered), []);
});

test('tailored resume education never overwrites a real parsed value with fallback data', () => {
  const recovered = mergeEducationFallback(
    {
      school: 'Parsed University',
      degree: 'Parsed Degree',
      grad_date: 'May 2027',
      coursework: ['Parsed Course'],
    },
    {
      school: 'Fallback University',
      degree: 'Fallback Degree',
      grad_date: 'May 2028',
      coursework: ['Fallback Course'],
    },
  );

  assert.equal(recovered.school, 'Parsed University');
  assert.equal(recovered.degree, 'Parsed Degree');
  assert.equal(recovered.grad_date, 'May 2027');
  assert.deepEqual(recovered.coursework, ['Parsed Course']);
});

test('blank education is held before a resume can be stored with an empty education section', () => {
  assert.deepEqual(
    missingRequiredEducation({ school: '', degree: '', grad_date: 'May 2028' }),
    [
      'education school is missing from the profile source',
      'education degree is missing from the profile source',
    ],
  );
});

test('fallback accepts nested education records from older stored resume shapes', () => {
  const recovered = mergeEducationFallback(
    { school: '', degree: undefined, grad_date: undefined },
    {
      education: {
        school: 'University of Southern California, Viterbi School of Engineering',
        degree: 'Bachelor of Science in Computer Science',
        grad_date: 'May 2028',
      },
    },
  );

  assert.equal(recovered.school, 'University of Southern California, Viterbi School of Engineering');
  assert.equal(recovered.degree, 'Bachelor of Science in Computer Science');
  assert.equal(recovered.grad_date, 'May 2028');
});

test('blank rendered education is held before the preview can be saved', () => {
  assert.deepEqual(
    missingRenderedEducation({ school: '', degree: 'Bachelor of Science in Computer Science' }),
    ['resume education school is blank in the generated preview'],
  );
  assert.deepEqual(
    missingRenderedEducation({ school: 'University of Southern California', degree: '' }),
    ['resume education degree is blank in the generated preview'],
  );
});

test('a missing-education build is refused as a fixable profile gap, never as a posting verdict', () => {
  /* The recovery for "your school/degree are not on file" is to add them, and that gap fails every
     posting identically - so this refusal must NOT be resume_quality_hold, whose recovery is "try
     another posting" (the loop measured live 2026-09-02). The gate has to send back the distinct
     resume_profile_incomplete code that the client routes to a one-field fix, the same way it
     already treats a missing name or resume email. This is a source-pattern test because the gate
     itself needs a live request; the pattern is what keeps the two codes from being reconflated. */
  const source = readFileSync('src/routes/resume.ts', 'utf8');
  const gate = source.slice(source.indexOf('const educationIssues = missingRequiredEducation(education);'));
  const block = gate.slice(0, gate.indexOf('const declaredSkills'));
  assert.match(block, /code: 'resume_profile_incomplete'/, 'the missing-education gate must send the profile-incomplete code');
  assert.match(block, /field: 'education'/, 'the gate must name the field the client should route the student to fix');
  assert.doesNotMatch(block, /code: 'resume_quality_hold'/, 'a missing-education gap is not a posting-fit quality hold');
});
