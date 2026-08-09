import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSpec, RESUME_SYSTEM_PROMPT } from './resumeSpec';

// Regression coverage for the "partial model JSON crashes resume generation" bug (audit #4):
// a syntactically valid but incomplete spec (e.g. no "experience" key) used to reach
// validateResumeSpec/renderResumePdf and throw an uncaught TypeError on `.flatMap`/`.length`,
// surfacing as an opaque 500 and bypassing the retry loop. normalizeSpec guarantees a well-formed
// shape so downstream code is crash-proof, while preserving an empty experience array (not faking
// content) so the route's own "no experience entries" validation still fires.

test('normalizeSpec coerces a partial object into a well-formed spec (no undefined arrays)', () => {
  const s = normalizeSpec({ school: 'USC' });
  assert.equal(s.school, 'USC');
  assert.equal(s.degree, '');
  assert.equal(s.grad_date, '');
  assert.equal(s.coursework, '');
  assert.deepEqual(s.experience, []);
  assert.deepEqual(s.skills, []);
});

test('normalizeSpec drops non-string bullets/skills and non-object experience entries', () => {
  const s = normalizeSpec({
    experience: [
      { org: 'Acme', title: 'Intern', date_range: '2024', bullets: ['Built X', 42, null] },
      null,
      'garbage',
    ],
    skills: ['Python', 7, undefined],
  });
  assert.equal(s.experience.length, 1);
  assert.equal(s.experience[0].org, 'Acme');
  assert.deepEqual(s.experience[0].bullets, ['Built X']);
  assert.deepEqual(s.skills, ['Python']);
});

test('normalizeSpec tolerates non-object / null input without throwing', () => {
  assert.deepEqual(normalizeSpec(null).experience, []);
  assert.deepEqual(normalizeSpec('nope').skills, []);
  assert.deepEqual(normalizeSpec(undefined).experience, []);
});

test('normalizeSpec preserves the per-application target role headline', () => {
  const s = normalizeSpec({ target_role: 'Analytics Engineer' });
  assert.equal(s.target_role, 'Analytics Engineer');
});

test('normalizeSpec preserves the frozen-JD binding on lead citations', () => {
  const s = normalizeSpec({
    experience: [{ org: 'Acme', title: 'Engineer', date_range: '2025', bullets: ['Built React interfaces'] }],
    lead_alignment: {
      entry_org: 'Acme',
      requirement: 'Build React interfaces',
      evidence: 'Built React interfaces',
      jd_hash: '0123456789abcdef',
    },
  });
  assert.equal(s.lead_alignment?.jd_hash, '0123456789abcdef');
});

test('resume prompt pins every application-specific tailoring rule', () => {
  assert.match(RESUME_SYSTEM_PROMPT, /proof document for THIS application/);
  assert.match(RESUME_SYSTEM_PROMPT, /exact role named in the Job line/);
  assert.match(RESUME_SYSTEM_PROMPT, /Follow the JD's priority order/);
  assert.match(RESUME_SYSTEM_PROMPT, /JD extraction summary as the priority map/);
  assert.match(RESUME_SYSTEM_PROMPT, /Hard requirements outrank preferences/);
  assert.match(RESUME_SYSTEM_PROMPT, /copy the JD's exact\s+multi-word terminology/);
  assert.match(RESUME_SYSTEM_PROMPT, /company values or operating principles/);
  assert.match(RESUME_SYSTEM_PROMPT, /Exact language never overrides truth/);
});
