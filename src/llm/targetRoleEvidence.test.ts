import { test } from 'node:test';
import assert from 'node:assert/strict';
import { unsupportedTargetRoles } from './targetRoleEvidence';

const nurse = {
  experience: [{ company: 'University Hospital', title: 'Registered Nurse', description: 'Coordinated patient care and clinical research.' }],
  skills: ['Patient assessment', 'Care planning'],
  degree: 'Bachelor of Science in Nursing',
};

test('accepts adjacent roles supported by the same healthcare evidence', () => {
  assert.deepEqual(unsupportedTargetRoles([
    'Registered Nurse', 'Clinical Research Coordinator', 'Patient Care Coordinator',
    'Health Educator', 'Nurse Researcher',
  ], nurse), []);
});

test('rejects five unrelated careers even when their count and uniqueness are valid', () => {
  assert.deepEqual(unsupportedTargetRoles([
    'Astronaut', 'Investment Banker', 'Film Director', 'Civil Engineer', 'Fashion Designer',
  ], nurse), [
    'Astronaut', 'Investment Banker', 'Film Director', 'Civil Engineer', 'Fashion Designer',
  ]);
});

test('supports specialized roles through distinctive resume wording', () => {
  assert.deepEqual(unsupportedTargetRoles(['Museum Curator'], {
    experience: [{ title: 'Collections Assistant', description: 'Catalogued museum collections.' }],
  }), []);
});

test('supports common practitioner and field suffix changes', () => {
  assert.deepEqual(unsupportedTargetRoles([
    'Economist', 'Chemist', 'Biologist', 'Psychologist',
  ], {
    degree: 'Economics, Chemistry, Biology, and Psychology',
  }), []);
});

test('uses a parsed objective when a scanned resume has no raw text layer', () => {
  assert.deepEqual(unsupportedTargetRoles(['Archivist'], {
    objective: 'Seeking an archivist role preserving historical records.',
  }), []);
});

test('accepts inflected evidence inside an enumerated domain', () => {
  assert.deepEqual(unsupportedTargetRoles(['Teacher'], {
    experience: [{ title: 'Teaching Assistant', description: 'Taught weekly lessons.' }],
  }), []);
});
