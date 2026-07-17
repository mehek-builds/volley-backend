import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { SYSTEM_PROMPT, normalizeDraftedAnswer } from './applicationAnswer';

// R-029 regression coverage. Live on Replit (2026-07-17): asked "Please tell us about your
// submitted project" on a form whose Project URL was empty and unfillable, the drafter wrote
// "For my submission I built Tonee..." - every FACT grounded, the FRAME false. No grounding
// check can catch that, because the defect is adopting the question's presupposition, not any
// claim inside the answer. The fix is a prompt rule plus a refusal sentinel that rides the
// module's existing cannot-draft path (empty answer -> route 502 -> the card flags the field).

describe('R-029: the premise rule is pinned in the system prompt', () => {
  // The live model cannot be asserted on in unit tests; the rule TEXT can. If someone rewrites
  // the prompt and drops the rule, these fail instead of the failure resurfacing on a live form.
  // The prompt hard-wraps its lines, so phrases are matched on a whitespace-normalized copy.
  const flat = SYSTEM_PROMPT.replace(/\s+/g, ' ');

  test('names the presupposition hazard', () => {
    assert.match(flat, /Premise \(hard rule\)/);
    assert.match(flat, /presuppose an artifact, event, or status/);
    assert.match(flat, /NEVER adopt such a premise/);
  });

  test('names the exact live failure shape: true facts under a false frame', () => {
    assert.match(flat, /submitted project/);
    assert.match(flat, /still false/);
    assert.match(flat, /never claiming to have submitted, attached, linked, or built anything for THIS application/);
  });

  test('names the honest reframe and the refusal path', () => {
    assert.match(flat, /The project I would point to is/);
    assert.match(flat, /output exactly CANNOT_DRAFT and nothing else/);
  });
});

describe('R-029: the refusal sentinel rides the cannot-draft path', () => {
  test('a bare refusal becomes the empty answer the route already 502s on', () => {
    assert.equal(normalizeDraftedAnswer('CANNOT_DRAFT'), '');
  });

  test('a refusal with an appended reason is still a refusal', () => {
    assert.equal(normalizeDraftedAnswer('CANNOT_DRAFT: the question presumes a submitted project and none exists'), '');
    assert.equal(normalizeDraftedAnswer('CANNOT_DRAFT.'), '');
  });

  test('surrounding whitespace does not hide a refusal', () => {
    assert.equal(normalizeDraftedAnswer('  CANNOT_DRAFT  \n'), '');
  });

  test('a real answer passes through trimmed', () => {
    assert.equal(
      normalizeDraftedAnswer('  The project I would point to is Tonee, which I built and shipped solo.  '),
      'The project I would point to is Tonee, which I built and shipped solo.',
    );
  });

  test('the sentinel mentioned MID-answer is not a refusal', () => {
    const answer = 'My tooling reports CANNOT_DRAFT when a template is missing, which I fixed at Traeco.';
    assert.equal(normalizeDraftedAnswer(answer), answer);
  });

  test('a lookalike prefix is not a refusal', () => {
    const answer = 'CANNOT_DRAFTED is not a word, but drafting is what I did at Traeco.';
    assert.equal(normalizeDraftedAnswer(answer), answer);
  });

  test('an empty model response stays empty', () => {
    assert.equal(normalizeDraftedAnswer(''), '');
    assert.equal(normalizeDraftedAnswer('   '), '');
  });
});
