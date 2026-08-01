import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsedProfileFromModelText, SYSTEM_PROMPT } from './parse';

// R-047, found in live QA 2026-07-23. Mehek's uploaded resume reads "Bachelor of Science in Computer
// Science & Business Administration, Finance Emphasis". The parser stored "Bachelor of Science in
// Business Administration, Emphasis in Finance": the Computer Science half was dropped and the
// emphasis reworded. Every tailored resume then presented a computer science candidate as a finance
// candidate, and resumeValidate's "education degree differs from uploaded resume" check could not
// catch it, because that check compares the spec against this same corrupted stored value. The only
// defence is the parse prompt, so pin its load-bearing clauses.

test('the parse prompt demands a verbatim degree', () => {
  assert.match(SYSTEM_PROMPT, /copied VERBATIM/);
});

test('the parse prompt names the joint-degree failure it exists to prevent', () => {
  const flat = SYSTEM_PROMPT.replace(/\s+/g, ' ');
  assert.match(flat, /joint or dual degree/);
  assert.match(flat, /carry BOTH halves/i);
});

test('the prompt does not hand the model a ready-made degree to copy', () => {
  // Few-shot contamination: a plausible verbatim degree inside model-visible text is something the
  // model can emit when a resume's education section is unclear, which is the exact fabrication the
  // rule forbids. The concrete R-047 strings belong in a code comment, not the prompt.
  assert.doesNotMatch(SYSTEM_PROMPT, /Bachelor of Science in/i);
  assert.doesNotMatch(SYSTEM_PROMPT, /Emphasis in Finance/i);
});

test('the parse prompt forbids inferring a degree from the school or college name', () => {
  // The prompt is a wrapped template literal, so match across the line breaks rather than pinning
  // one particular wrap position: rewrapping the paragraph must not fail this test.
  const flat = SYSTEM_PROMPT.replace(/\s+/g, ' ');
  assert.match(flat, /never let the school or college name influence the degree/i);
  assert.match(flat, /business school hosts non-business degrees/i);
});

test('the parse prompt still requires an empty string over an invented degree', () => {
  const flat = SYSTEM_PROMPT.replace(/\s+/g, ' ');
  assert.match(flat, /return an empty string rather than inferring one/i);
});

test('the parse prompt keeps the precise graduation date', () => {
  // Summer 2027 eligibility turns on this. A resume that loses "May 2027" down to a bare year, or
  // gains a year it never printed, changes whether the student qualifies for the posting at all.
  assert.match(SYSTEM_PROMPT, /most precise date printed on the resume/i);
});

test('the parse prompt pins the five-role evidence and ordering contract', () => {
  const flat = SYSTEM_PROMPT.replace(/\s+/g, ' ');
  assert.match(flat, /exactly five distinct job titles/i);
  assert.match(flat, /ordered from strongest to weakest fit/i);
  assert.match(flat, /dated years of experience, past job titles, projects, and skills/i);
  assert.match(flat, /match the seniority shown by the evidence/i);
  assert.match(flat, /do not invent a field the resume does not support/i);
});

function modelProfile(target_roles: unknown): string {
  return JSON.stringify({
    full_name: 'A Candidate', experience: [], skills: [], projects: [], school: '',
    grad_year: 0, target_roles,
  });
}

test('the parser accepts exactly five distinct non-empty target roles and trims them', () => {
  const parsed = parsedProfileFromModelText(modelProfile([
    ' Software Engineer ', 'Backend Engineer', 'Frontend Engineer', 'Product Engineer', 'Data Engineer',
  ]));
  assert.deepEqual(parsed.target_roles, [
    'Software Engineer', 'Backend Engineer', 'Frontend Engineer', 'Product Engineer', 'Data Engineer',
  ]);
});

test('the parser normalizes roles without inventing unrelated fallback careers', () => {
  assert.throws(() => parsedProfileFromModelText(modelProfile(undefined)), /five evidence-backed/);
  assert.throws(() => parsedProfileFromModelText(modelProfile(['Nurse', 'Teacher'])), /five evidence-backed/);
  assert.deepEqual(
    parsedProfileFromModelText(modelProfile(['One', 'Two', 'Three', 'Four', 'Five', 'Six'])).target_roles,
    ['One', 'Two', 'Three', 'Four', 'Five'],
  );
  assert.throws(
    () => parsedProfileFromModelText(JSON.stringify({
      ...JSON.parse(modelProfile(['Nurse'])),
      experience: [{ company: 'Hospital', title: 'Registered Nurse', start: '', end: '', description: '' }],
    })),
    /five evidence-backed/,
  );
});

test('the parser keeps every suggested title within the targeting API limit', () => {
  const parsed = parsedProfileFromModelText(modelProfile([
    'A'.repeat(120), 'Backend Engineer', 'Frontend Engineer', 'Product Engineer', 'Data Engineer',
  ]));
  assert.equal(parsed.target_roles[0].length, 80);
  assert.ok(parsed.target_roles.every((role) => role.length <= 80));
});
