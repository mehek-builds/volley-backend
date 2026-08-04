import assert from 'node:assert/strict';
import test from 'node:test';
import type { CandidateEducation } from '../engine/resumePolicy';
import { mergeEducationFallback, missingRequiredEducation } from './resume';

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
