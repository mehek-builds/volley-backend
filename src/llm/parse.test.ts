import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SYSTEM_PROMPT } from './parse';

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
